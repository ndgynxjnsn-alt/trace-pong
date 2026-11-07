// Scene state: service graph layout, the playback clock, balls (one per hop),
// sparks, shockwaves and floating text. Produces flat Float32Arrays for the GPU.
import { SPARK_FLOATS } from './gpu.js';

// ---------------------------------------------------------------------------
// colour helpers (linear RGB for the HDR pipeline, CSS strings for the overlay)
// ---------------------------------------------------------------------------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hslRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
const css = (rgb, a = 1) => `rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},${a})`;

export const RED = [1.0, 0.09, 0.14];
const RED_CSS = '#ff4d5e';
const AMBER = [1.0, 0.55, 0.08];

// One colour per trace (from the trace id), so a request keeps it across the whole graph.
// Reds are left out: they mean errors.
const traceRgbCache = new Map();
function traceRgb(tr) {
  let c = traceRgbCache.get(tr);
  if (!c) {
    const h = hashStr(tr || String(Math.random()));
    c = hslRgb(0.07 + h * 0.86, 0.95, 0.62).map(toLin);
    if (traceRgbCache.size > 5000) traceRgbCache.clear();
    traceRgbCache.set(tr, c);
  }
  return c;
}

// Shockwave look per status code (HTTP codes; 0 = no code, e.g. database calls).
function statusFx(h) {
  const c = h.c || 0;
  if (h.e || c >= 500) return { sev: 'err', rgb: RED, grow: 2.2, life: 0.7, a: 0.9 };
  if (c >= 400) return { sev: 'warn', rgb: AMBER, grow: 1.2, life: 0.6, a: 0.75 };
  if (c >= 300) return { sev: 'redirect', rgb: [0.25, 0.5, 1.0], grow: 0.8, life: 0.5, a: 0.55 };
  if (c >= 200) return { sev: 'ok', rgb: [0.15, 1.0, 0.45], grow: 0.7, life: 0.45, a: 0.4 };
  return { sev: 'ok', rgb: null, grow: 0.7, life: 0.45, a: 0.4 };
}

const KIND = { service: 0, database: 1, external: 2, user: 3 };

// ---------------------------------------------------------------------------
// curve geometry
// ---------------------------------------------------------------------------
const SAMPLES = 28;

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

class Edge {
  constructor(key, s, t, type) {
    this.key = key; this.s = s; this.t = t; this.type = type;
    this.rate = 0; this.err = 0; this.mean = null;
    this.pts = new Float32Array(SAMPLES * 2);
    this.len = new Float32Array(SAMPLES);
    this.total = 1;
    this.lastSeen = 0;
    this.flash = 0;
  }

  rebuild(a, b) {
    const p0 = [a.x, a.y], p3 = [b.x, b.y];
    let p1, p2;
    const dx = b.x - a.x;
    if (dx > 40) {
      p1 = [a.x + dx * 0.5, a.y];
      p2 = [b.x - dx * 0.5, b.y];
    } else if (Math.abs(dx) <= 40) {
      // same column: bow out to the right
      const bow = 90 + Math.abs(b.y - a.y) * 0.25;
      p1 = [a.x + bow, a.y];
      p2 = [b.x + bow, b.y];
    } else {
      // backwards: loop over the top
      p1 = [a.x + 160, a.y - 140];
      p2 = [b.x - 160, b.y - 140];
    }
    let total = 0, px = p0[0], py = p0[1];
    for (let i = 0; i < SAMPLES; i++) {
      const [x, y] = bezier(p0, p1, p2, p3, i / (SAMPLES - 1));
      total += Math.hypot(x - px, y - py);
      this.pts[i * 2] = x; this.pts[i * 2 + 1] = y;
      this.len[i] = total;
      px = x; py = y;
    }
    this.total = Math.max(total, 1);
  }

  // position + unit normal at fraction u of arc length
  at(u, out) {
    const target = Math.min(Math.max(u, 0), 1) * this.total;
    let i = 1;
    while (i < SAMPLES - 1 && this.len[i] < target) i++;
    const l0 = this.len[i - 1], l1 = this.len[i];
    const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    const x0 = this.pts[i * 2 - 2], y0 = this.pts[i * 2 - 1], x1 = this.pts[i * 2], y1 = this.pts[i * 2 + 1];
    const dx = x1 - x0, dy = y1 - y0, dl = Math.hypot(dx, dy) || 1;
    out[0] = x0 + dx * f; out[1] = y0 + dy * f; out[2] = -dy / dl; out[3] = dx / dl;
    return out;
  }
}

// ---------------------------------------------------------------------------
// growable float arrays
// ---------------------------------------------------------------------------
class FloatList {
  constructor(per, cap = 1024) { this.per = per; this.data = new Float32Array(cap * per); this.count = 0; }
  reset() { this.count = 0; }
  push(...v) {
    if ((this.count + 1) * this.per > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data.set(v, this.count * this.per);
    this.count++;
  }
}

// ---------------------------------------------------------------------------
export class Scene {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.queue = [];      // scheduled balls not yet departed, sorted by depart
    this.balls = [];      // live balls
    this.rings = [];      // shockwaves
    this.texts = [];      // floating labels
    this.play = 0;        // playback time (epoch ms, same domain as hop timestamps)
    this.delay = null;    // wall - play; fixed once set, so playback always runs at 1x
    this.sfx = null;      // (severity, worldX) -> void, for sound
    this.paused = false;
    this.speed = 1;       // ball speed multiplier
    this.stretch = 2;     // how many visual ms a real span ms takes while a ball is "held"
    this.layoutDirty = true;
    this.focus = null;    // pinned node id
    this.hover = null;    // hovered node id
    this.hoverEdge = null;
    this.time = 0;
    this.sparks = new FloatList(SPARK_FLOATS, 4096);
    this.out = {
      nodes: new FloatList(16, 64), edges: new FloatList(12, 2048),
      under: new FloatList(8, 4096), over: new FloatList(8, 1024), heat: new FloatList(8, 64),
    };
    // live counters for the HUD (from hops)
    this.recent = [];     // [playTime, isEntry, isErr, name, from, to, dur]
    this.routes = new Map();
    this.hopsSeen = 0;
    this.textBudget = 0;
    this.lastHopWall = 0;
  }

  // ---- graph -------------------------------------------------------------
  node(id, kind) {
    let n = this.nodes.get(id);
    if (!n) {
      const h = hashStr(id);
      kind = id === 'user' ? 'user' : (kind || 'service');
      let rgb;
      if (kind === 'user') rgb = [0.85, 0.9, 1.0];
      else if (kind === 'database') rgb = hslRgb(0.53 + h * 0.12, 0.85, 0.6);
      else if (kind === 'external') rgb = hslRgb(0.72 + h * 0.12, 0.8, 0.66);
      else rgb = hslRgb((h * 7.31) % 1, 0.9, 0.6);
      n = {
        id, kind, x: 0, y: 0, tx: 0, ty: 0, placed: false,
        r: 26, tr: 26, rgb, lin: rgb.map(toLin), css: css(rgb),
        pulse: 0, heat: 0, flash: 0,
        rate: 0, errRate: 0, mean: null, p90: null, outRate: 0, alpha: 0, lastSeen: performance.now(),
        inflight: 0, hits: 0, errs: 0,
      };
      this.nodes.set(id, n);
      this.layoutDirty = true;
    } else if (kind && kind !== n.kind && n.kind === 'service' && id !== 'user') {
      n.kind = kind;
      this.layoutDirty = true;
    }
    return n;
  }

  edge(s, t, type) {
    const key = `${s}→${t}`;
    let e = this.edges.get(key);
    if (!e) {
      this.node(s); this.node(t);
      e = new Edge(key, s, t, type || '');
      this.edges.set(key, e);
      this.layoutDirty = true;
    }
    if (type && !e.type) e.type = type;
    e.lastSeen = performance.now();
    return e;
  }

  applyGraph(g) {
    const now = performance.now();
    for (const gn of g.nodes) {
      const n = this.node(gn.id, gn.kind);
      n.rate = gn.rate; n.errRate = gn.errRate; n.mean = gn.mean; n.p90 = gn.p90; n.outRate = gn.outRate;
      n.lastSeen = now;
    }
    for (const ge of g.edges) {
      const e = this.edge(ge.source, ge.target, ge.type);
      e.rate = ge.rate; e.err = ge.errRate; e.mean = ge.mean;
    }
    // forget what hasn't been seen for a while
    for (const [k, e] of this.edges) if (now - e.lastSeen > 120000) { this.edges.delete(k); this.layoutDirty = true; }
    for (const [id, n] of this.nodes) {
      if (now - n.lastSeen > 120000 && ![...this.edges.values()].some((e) => e.s === id || e.t === id)) {
        this.nodes.delete(id);
        this.layoutDirty = true;
      }
    }
  }

  // Layered left-to-right layout: longest-path ranks, sinks (databases, external APIs) in
  // the last column, barycentric ordering inside columns to untangle edges.
  layout() {
    this.layoutDirty = false;
    const ids = [...this.nodes.keys()];
    if (!ids.length) return;
    const isSink = (id) => {
      const n = this.nodes.get(id);
      return n.kind === 'database' || n.kind === 'external';
    };
    const preds = new Map(ids.map((i) => [i, []]));
    const succs = new Map(ids.map((i) => [i, []]));
    for (const e of this.edges.values()) {
      if (e.s === e.t || !preds.has(e.t) || !succs.has(e.s)) continue;
      preds.get(e.t).push(e.s);
      succs.get(e.s).push(e.t);
    }
    const rank = new Map();
    for (const id of ids) rank.set(id, id === 'user' ? 0 : 1);
    const hasUser = this.nodes.has('user');
    for (let iter = 0; iter < ids.length; iter++) {
      let changed = false;
      for (const e of this.edges.values()) {
        if (isSink(e.t) || e.t === 'user' || e.s === e.t) continue;
        const r = rank.get(e.s) + 1;
        if (r > rank.get(e.t) && r < ids.length + 1) { rank.set(e.t, r); changed = true; }
      }
      if (!changed) break;
    }
    if (!hasUser) for (const id of ids) rank.set(id, rank.get(id) - 1);
    let maxRank = 0;
    for (const id of ids) if (!isSink(id)) maxRank = Math.max(maxRank, rank.get(id));
    for (const id of ids) if (isSink(id)) rank.set(id, maxRank + 1);

    const cols = [];
    for (const id of ids) (cols[rank.get(id)] ||= []).push(id);
    for (let i = 0; i < cols.length; i++) cols[i] ||= [];
    // initial order: databases first, then externals, then by name
    for (const c of cols) c.sort((a, b) => (KIND[this.nodes.get(a).kind] - KIND[this.nodes.get(b).kind]) || a.localeCompare(b));

    const ROW = 204, COL = 340;
    const ys = new Map();
    const place = () => cols.forEach((c) => c.forEach((id, i) => ys.set(id, (i - (c.length - 1) / 2) * ROW)));
    place();
    const bary = (id, nb) => {
      const v = nb.get(id).filter((x) => ys.has(x));
      return v.length ? v.reduce((s, x) => s + ys.get(x), 0) / v.length : ys.get(id);
    };
    for (let sweep = 0; sweep < 8; sweep++) {
      const forward = sweep % 2 === 0;
      const order = forward ? cols.map((_, i) => i) : cols.map((_, i) => cols.length - 1 - i);
      for (const ci of order) {
        const nb = forward ? preds : succs;
        const keys = new Map(cols[ci].map((id) => [id, bary(id, nb)]));
        cols[ci].sort((a, b) => keys.get(a) - keys.get(b));
        cols[ci].forEach((id, i) => ys.set(id, (i - (cols[ci].length - 1) / 2) * ROW));
      }
    }
    for (const id of ids) {
      const n = this.nodes.get(id);
      n.tx = rank.get(id) * COL;
      n.ty = ys.get(id);
      if (!n.placed) {
        n.x = n.tx - 60; n.y = n.ty;
        n.placed = true;
      }
    }
    this.cols = cols.length;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes.values()) {
      x0 = Math.min(x0, n.tx - n.tr - (n.kind === 'user' ? 110 : 20)); x1 = Math.max(x1, n.tx + n.tr + 20);
      y0 = Math.min(y0, n.ty - n.tr - 20); y1 = Math.max(y1, n.ty + n.tr + 44);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // ---- hops --------------------------------------------------------------
  // Hops arrive in batches. Each trace is replayed as a causal rally: a call only
  // leaves a service after the ball that triggered it has arrived there, and a
  // response only goes back after the children have returned.
  ingest(hops, wallNow, backlog) {
    if (!hops.length) return;
    let maxT = -Infinity;
    for (const h of hops) maxT = Math.max(maxT, h.t);
    // The playback clock runs at real speed, a fixed delay behind the wall clock. Traces that
    // arrive later than that are shifted forward a little rather than slowing the clock down.
    if (this.delay === null) {
      this.delay = wallNow - maxT + 3500;
      this.play = wallNow - this.delay;
    }
    if (!backlog) this.lastHopWall = wallNow;
    const byTrace = new Map();
    for (const h of hops) {
      if (!byTrace.has(h.tr)) byTrace.set(h.tr, []);
      byTrace.get(h.tr).push(h);
    }
    const cutoff = this.play - 1500;
    for (const list of byTrace.values()) this.scheduleTrace(list, cutoff, !backlog);
    this.queue.sort((a, b) => a.depart - b.depart);
  }

  travelMs(e) {
    return Math.min(1500, Math.max(260, (e.total / 720) * 1000)) / this.speed;
  }

  scheduleTrace(hops, cutoff, shiftLate) {
    hops.sort((a, b) => a.t - b.t);
    // late trace: start it now-ish (spread over a poll interval) instead of dropping it;
    // anything more than 20 s late is stale and skipped
    let shift = 0;
    const late = this.play - hops[0].t;
    if (shiftLate && late > 0) {
      if (late > 20000) return;
      shift = late + Math.random() * 900;
    }
    const rgb = traceRgb(hops[0].tr);
    // parent = the latest hop into our caller that started before us
    for (const h of hops) {
      h.kids = [];
      h.parent = null;
      for (const p of hops) {
        if (p === h || p.to !== h.f || p.t > h.t) continue;
        if (!h.parent || p.t > h.parent.t) h.parent = p;
      }
    }
    for (const h of hops) if (h.parent) h.parent.kids.push(h);
    const S = this.stretch;
    const plan = (h, depart) => {
      if (h.k === 'db') this.node(h.to, 'database');
      else if (h.k === 'ext') this.node(h.to, 'external');
      const e = this.edge(h.f, h.to, h.k === 'db' ? 'database' : h.k === 'ext' ? 'virtual_node' : '');
      const T = this.travelMs(e);
      const arrive = depart + T;
      let ready = arrive + h.d * S;
      const sibs = h.kids.sort((a, b) => a.t - b.t);
      const done = [];
      for (const c of sibs) {
        let dep = arrive + (c.t - h.t) * S;
        // a call that started after a sibling finished waits for that sibling's response
        for (const s of done) if (c.t >= s.h.t + s.h.d - 0.05) dep = Math.max(dep, s.back + (c.t - (s.h.t + s.h.d)) * S);
        const back = plan(c, dep);
        done.push({ h: c, back });
        const async = c.t > h.t + h.d;   // queue consumer after the producer returned
        if (!async) ready = Math.max(ready, back + 12);
      }
      const ret = ready;
      if (depart >= cutoff) {
        this.queue.push({ hop: h, edge: e, depart, arrive, ret, back: ret + T, phase: 0, err: h.e, slow: h.d > 250, rgb });
      }
      return ret + T;
    };
    for (const h of hops) if (!h.parent) plan(h, h.t + shift);
  }

  // ---- effects -------------------------------------------------------------
  burst(x, y, n, rgb, speed, life, size, dir = null, spread = Math.PI * 2) {
    for (let i = 0; i < n; i++) {
      const a = dir === null ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * spread;
      const v = speed * (0.3 + Math.random() * 0.9);
      const l = life * (0.5 + Math.random() * 0.7);
      const k = 0.7 + Math.random() * 0.6;
      this.sparks.push(x, y, Math.cos(a) * v, Math.sin(a) * v, l, l, size * (0.5 + Math.random()), 0.12,
        rgb[0] * k, rgb[1] * k, rgb[2] * k, 1);
    }
  }

  ring(x, y, rgb, r0, r1, life, a = 0.9) {
    this.rings.push({ x, y, rgb, r0, r1, life, age: 0, a });
  }

  text(str, x, y, color, opts = {}) {
    if (this.texts.length > 70 && !opts.force) return;
    this.texts.push({ str, x, y, color, age: 0, life: opts.life || 1.6, vy: opts.vy ?? -22, size: opts.size || 12, weight: opts.weight || 500, glow: opts.glow });
  }

  onArrive(b) {
    const h = b.hop, n = this.nodes.get(h.to), from = this.nodes.get(h.f);
    if (!n) return;
    n.hits++;
    n.heat = Math.min(n.heat + 0.05, 4);
    n.pulse = Math.min(n.pulse + 0.25, 0.9);
    n.inflight++;
    const ang = from ? Math.atan2(from.x - n.x, -(from.y - n.y)) : Math.PI * 1.5;
    const inDir = from ? Math.atan2(n.y - from.y, n.x - from.x) : 0;
    const fx = statusFx(h);
    if (fx.sev === 'err') {
      // errors smash into the node
      n.errs++;
      n.flash = 0;
      this.burst(n.x, n.y, 70, RED, 420, 0.9, 2.6);
      this.burst(n.x, n.y, 30, b.rgb, 240, 0.6, 1.8, inDir, 1.2);
      this.ring(n.x, n.y, RED, n.r, n.r * (1 + fx.grow), fx.life, fx.a);
      n.shake = 1;
      this.sfx?.('err', n.x);
    } else {
      n.flash = 1;
      // sparks fly back off the ring where the ball hit
      const px = n.x + Math.sin(ang) * n.r, py = n.y - Math.cos(ang) * n.r;
      const warn = fx.sev === 'warn';
      this.burst(px, py, warn ? 24 : b.slow ? 12 : 4, warn ? AMBER : b.rgb, warn ? 220 : 160, 0.4, 1.4, inDir + Math.PI, warn ? 3 : 1.6);
      // shockwave in the status colour; 2xx/3xx are throttled per node so busy nodes don't white out
      if (warn || this.time - (n.lastRing || 0) > 0.35 || b.slow) {
        n.lastRing = this.time;
        this.ring(n.x, n.y, fx.rgb || n.lin, n.r, n.r * (1 + fx.grow), fx.life, fx.a);
      }
      this.sfx?.(fx.sev, n.x);
    }
    // a label for the call, rate limited
    if (this.textBudget > 0 && (h.f === 'user' || b.err || Math.random() < 0.12)) {
      this.textBudget--;
      this.text(h.n, n.x + (Math.random() - 0.5) * 30, n.y - n.r - 20, b.err ? RED_CSS : css(n.rgb, 1), { life: 1.8, size: h.f === 'user' ? 13 : 11 });
    }
  }

  onReturn(b) {
    const h = b.hop, n = this.nodes.get(h.f), srv = this.nodes.get(h.to);
    if (srv) srv.inflight = Math.max(0, srv.inflight - 1);
    if (!n) return;
    const code = h.c || (b.err ? 'ERR' : 'OK');
    if (b.err) {
      this.burst(n.x, n.y, 40, RED, 300, 0.8, 2.2);
      this.ring(n.x, n.y, RED, n.r, n.r * 2.4, 0.6);
      this.text(String(code), n.x - n.r - 26, n.y + (Math.random() - 0.5) * n.r * 2, RED_CSS, { size: 16, weight: 800, life: 2.2, vy: -14, force: true, glow: true });
    } else {
      n.flash = Math.max(n.flash, 0.6);
      if (h.f === 'user' && this.textBudget > 0) {
        this.textBudget--;
        const warn = h.c >= 400;
        this.text(String(code), n.x - n.r - 30 - Math.random() * 40, n.y + (Math.random() - 0.5) * n.r * 3, warn ? '#ffb347' : 'rgba(190,210,235,0.75)', { size: warn ? 14 : 12, weight: 700, life: 1.4, vy: -10 });
      }
    }
  }

  // ---- per frame -------------------------------------------------------------
  update(wall, dt) {
    this.time += dt;
    this.textBudget = Math.min(this.textBudget + dt * 14, 14);
    if (!this.paused && this.delay !== null) this.play = Math.max(this.play, wall - this.delay);
    else if (this.paused && this.delay !== null) this.delay = wall - this.play;
    if (this.layoutDirty) this.layout();

    // nodes: animate toward layout, decay effects
    const k = 1 - Math.exp(-dt * 4);
    for (const n of this.nodes.values()) {
      n.x += (n.tx - n.x) * k;
      n.y += (n.ty - n.y) * k;
      const tr = n.kind === 'user' ? 38 : (n.kind === 'service' ? 31 : 26) + 6 * Math.log10(1 + n.rate * 4);
      n.tr = tr;
      n.r += (tr - n.r) * k;
      n.alpha = Math.min(1, n.alpha + dt * 1.5);
      n.pulse *= Math.exp(-dt * 5);
      n.flash *= Math.exp(-dt * 7);
      n.heat *= Math.exp(-dt * 0.9);
      n.shake = (n.shake || 0) * Math.exp(-dt * 8);
    }
    for (const e of this.edges.values()) {
      const a = this.nodes.get(e.s), b = this.nodes.get(e.t);
      if (a && b) e.rebuild(a, b);
      e.flash *= Math.exp(-dt * 3);
    }

    // launch balls whose time has come
    const play = this.play;
    let qi = 0;
    while (qi < this.queue.length && this.queue[qi].depart <= play) {
      const b = this.queue[qi++];
      if (b.back < play) continue;   // fell entirely in the past
      this.balls.push(b);
      this.countHop(b.hop);
    }
    if (qi) this.queue.splice(0, qi);
    if (this.queue.length > 30000) this.queue.splice(0, this.queue.length - 30000);

    // balls
    const alive = [];
    for (const b of this.balls) {
      if (b.phase === 0 && play >= b.arrive) { b.phase = 1; this.onArrive(b); }
      if (b.phase === 1 && play >= b.ret) { b.phase = 2; }
      if (b.phase === 2 && play >= b.back) { this.onReturn(b); continue; }
      alive.push(b);
    }
    this.balls = alive;
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < r.life);
    for (const t of this.texts) { t.age += dt; t.y += t.vy * dt; }
    this.texts = this.texts.filter((t) => t.age < t.life);

    // HUD counters: sliding 10 s window in playback time
    const horizon = play - 10000;
    let i = 0;
    while (i < this.recent.length && this.recent[i][0] < horizon) i++;
    if (i) this.recent.splice(0, i);
  }

  countHop(h) {
    this.hopsSeen++;
    this.recent.push([h.t, h.f === 'user', h.e, h.n, h.f, h.to, h.d]);
    if (h.f === 'user') {
      let r = this.routes.get(h.n);
      if (!r) this.routes.set(h.n, (r = { name: h.n, svc: h.to, hits: [], errs: [] }));
      r.hits.push(this.play);
      if (h.e || h.c >= 400) r.errs.push(this.play);
    }
  }

  // ---- GPU buffers -------------------------------------------------------------
  focusSet() {
    const id = this.focus || this.hover;
    if (!id) return null;
    const s = new Set([id]);
    for (const e of this.edges.values()) {
      if (e.s === id) s.add(e.t);
      if (e.t === id) s.add(e.s);
    }
    return s;
  }

  build() {
    const o = this.out;
    for (const l of Object.values(o)) l.reset();
    const fs = this.focusSet();
    const focusId = this.focus || this.hover;
    const dimOf = (id) => (!fs || fs.has(id) ? 1 : 0.18);
    const play = this.play;

    // edges
    for (const e of this.edges.values()) {
      const a = this.nodes.get(e.s), b = this.nodes.get(e.t);
      if (!a || !b) continue;
      const lit = !focusId || e.s === focusId || e.t === focusId;
      const errf = e.rate > 0 ? Math.min(1, (e.err / e.rate) * 4) : 0;
      let col = [0.16 + 0.84 * errf, 0.24 - 0.14 * errf, 0.42 - 0.3 * errf];
      if (this.hoverEdge === e.key) col = col.map((c) => c * 2.2);
      const alpha = Math.min(a.alpha, b.alpha) * (lit ? 1 : 0.15) * (focusId && lit ? 1.6 : 1);
      const width = 1.2 + 2.4 * Math.log10(1 + e.rate * 2);
      const flow = Math.min(1, 0.15 + e.rate / 6);
      for (let i = 0; i < SAMPLES - 1; i++) {
        o.edges.push(e.pts[i * 2], e.pts[i * 2 + 1], e.pts[i * 2 + 2], e.pts[i * 2 + 3],
          e.len[i], e.len[i + 1], width, flow, col[0], col[1], col[2], alpha);
      }
    }

    // balls: comet with a trail of ghosts; responses travel in the other lane
    const tmp = [0, 0, 0, 0];
    for (const b of this.balls) {
      const h = b.hop;
      const src = this.nodes.get(h.f), dst = this.nodes.get(h.to);
      if (!src || !dst) continue;
      const dim = fs ? (fs.has(h.f) && fs.has(h.to) && (h.f === focusId || h.to === focusId) ? 1 : 0.12) : 1;
      if (b.phase === 1) {
        // held inside the server: orbiting dot, shows concurrency
        const ang = this.time * 2.4 + (b.depart % 1000) * 0.0063;
        const rr = dst.r * 0.55;
        o.under.push(dst.x + Math.cos(ang) * rr, dst.y + Math.sin(ang) * rr, 1.6, 0, ...b.rgb, 0.5 * dim);
        continue;
      }
      const req = b.phase === 0;
      const t0 = req ? b.depart : b.ret, t1 = req ? b.arrive : b.back;
      const dur = t1 - t0;
      const size = (req ? 3.4 : 2.7) + Math.min(3.5, Math.log10(1 + h.d) * 1.3) + (b.err ? 1.5 : 0);
      const rgb = b.rgb;   // the trace's colour, on the way there and back
      const lane = req ? 4 : -4;
      const ghosts = 9;
      for (let g = ghosts; g >= 0; g--) {
        const u = (play - t0 - g * 16) / dur;
        if (u < 0 || u > 1) continue;
        b.edge.at(req ? u : 1 - u, tmp);
        const x = tmp[0] + tmp[2] * lane, y = tmp[1] + tmp[3] * lane;
        const fade = 1 - g / (ghosts + 1);
        if (g === 0) o.under.push(x, y, size, 0, rgb[0], rgb[1], rgb[2], dim);
        else o.under.push(x, y, size * (0.25 + 0.75 * fade), 2, rgb[0], rgb[1], rgb[2], 0.5 * fade * fade * dim);
      }
    }

    // nodes
    for (const n of this.nodes.values()) {
      const err = n.rate > 0 ? Math.min(1, n.errRate / n.rate) : 0;
      const heat = 1 - Math.exp(-n.heat * 0.45);
      const sx = (Math.random() - 0.5) * (n.shake || 0) * 6, sy = (Math.random() - 0.5) * (n.shake || 0) * 6;
      o.nodes.push(n.x + sx, n.y + sy, n.r, n.pulse, n.lin[0], n.lin[1], n.lin[2], err,
        0, heat, KIND[n.kind] ?? 0, n.alpha * dimOf(n.id),
        n.flash, n.id === focusId ? 1 : 0, 0, 0);
      if (heat > 0.02) o.heat.push(n.x, n.y, n.r * 2.6, 0.022 * heat * dimOf(n.id), n.lin[0], n.lin[1], n.lin[2], 0);
    }

    for (const r of this.rings) {
      const k = r.age / r.life;
      const e = 1 - Math.pow(1 - k, 3);
      o.over.push(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 1, r.rgb[0], r.rgb[1], r.rgb[2], (1 - k) * r.a);
    }
  }
}

export { css, toLin };
