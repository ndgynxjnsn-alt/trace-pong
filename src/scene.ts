// Scene state: service graph layout, the playback clock, balls (one per hop),
// sparks, shockwaves and floating text. Produces flat Float32Arrays for the GPU.
import { SPARK_FLOATS } from './gpu';
import type { Graph, Hop, NodeKind, Rgb, Severity } from './types';

// ---------------------------------------------------------------------------
// colour helpers (linear RGB for the HDR pipeline, CSS strings for the overlay)
// ---------------------------------------------------------------------------
const toLinC = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const toLin = (c: Rgb): Rgb => [toLinC(c[0]), toLinC(c[1]), toLinC(c[2])];

function hslRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export const css = (rgb: Rgb, a = 1) => `rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},${a})`;

export const RED: Rgb = [1.0, 0.09, 0.14];
const RED_CSS = '#ff4d5e';
const AMBER: Rgb = [1.0, 0.55, 0.08];

// One colour per trace (from the trace id), so a request keeps it across the whole graph.
// Reds are left out: they mean errors.
const traceRgbCache = new Map<string, Rgb>();
function traceRgb(tr: string): Rgb {
  let c = traceRgbCache.get(tr);
  if (!c) {
    const h = hashStr(tr || String(Math.random()));
    c = toLin(hslRgb(0.07 + h * 0.86, 0.95, 0.62));
    if (traceRgbCache.size > 5000) traceRgbCache.clear();
    traceRgbCache.set(tr, c);
  }
  return c;
}

interface StatusFx {
  sev: Severity;
  /** null: use the node's colour */
  rgb: Rgb | null;
  grow: number;
  life: number;
  a: number;
}

// Shockwave look per status code (HTTP codes; 0 = no code, e.g. database calls).
function statusFx(h: Hop): StatusFx {
  const c = h.c || 0;
  if (h.e || c >= 500) return { sev: 'err', rgb: RED, grow: 2.2, life: 0.7, a: 0.9 };
  if (c >= 400) return { sev: 'warn', rgb: AMBER, grow: 1.2, life: 0.6, a: 0.75 };
  if (c >= 300) return { sev: 'redirect', rgb: [0.25, 0.5, 1.0], grow: 0.8, life: 0.5, a: 0.55 };
  if (c >= 200) return { sev: 'ok', rgb: [0.15, 1.0, 0.45], grow: 0.7, life: 0.45, a: 0.4 };
  return { sev: 'ok', rgb: null, grow: 0.7, life: 0.45, a: 0.4 };
}

const KIND: Record<NodeKind, number> = { service: 0, database: 1, external: 2, user: 3 };

// ---------------------------------------------------------------------------
// curve geometry
// ---------------------------------------------------------------------------
const SAMPLES = 28;
type Vec2 = [number, number];

function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

export class Edge {
  rate = 0;
  err = 0;
  mean: number | null = null;
  readonly pts = new Float32Array(SAMPLES * 2);
  readonly len = new Float32Array(SAMPLES);
  total = 1;
  lastSeen = 0;
  flash = 0;

  constructor(readonly key: string, readonly s: string, readonly t: string, public type: string) {}

  rebuild(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const p0: Vec2 = [a.x, a.y], p3: Vec2 = [b.x, b.y];
    let p1: Vec2, p2: Vec2;
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
      this.pts[i * 2] = x;
      this.pts[i * 2 + 1] = y;
      this.len[i] = total;
      px = x;
      py = y;
    }
    this.total = Math.max(total, 1);
  }

  /** position + unit normal at fraction u of arc length, written to out[0..3] */
  at(u: number, out: number[]): number[] {
    const target = Math.min(Math.max(u, 0), 1) * this.total;
    let i = 1;
    while (i < SAMPLES - 1 && this.len[i] < target) i++;
    const l0 = this.len[i - 1], l1 = this.len[i];
    const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    const x0 = this.pts[i * 2 - 2], y0 = this.pts[i * 2 - 1], x1 = this.pts[i * 2], y1 = this.pts[i * 2 + 1];
    const dx = x1 - x0, dy = y1 - y0, dl = Math.hypot(dx, dy) || 1;
    out[0] = x0 + dx * f;
    out[1] = y0 + dy * f;
    out[2] = -dy / dl;
    out[3] = dx / dl;
    return out;
  }
}

// ---------------------------------------------------------------------------
// growable float arrays
// ---------------------------------------------------------------------------
export class FloatList {
  data: Float32Array<ArrayBuffer>;
  count = 0;

  constructor(readonly per: number, cap = 1024) {
    this.data = new Float32Array(cap * per);
  }

  reset(): void {
    this.count = 0;
  }

  push(...v: number[]): void {
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
export interface SceneNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** layout target */
  tx: number;
  ty: number;
  placed: boolean;
  r: number;
  /** target radius */
  tr: number;
  rgb: Rgb;
  lin: Rgb;
  css: string;
  pulse: number;
  heat: number;
  flash: number;
  shake: number;
  lastRing: number;
  rate: number;
  errRate: number;
  mean: number | null;
  outRate: number;
  alpha: number;
  lastSeen: number;
  inflight: number;
  hits: number;
  errs: number;
}

/** A hop scheduled for playback: depart -> arrive (request), held, ret -> back (response). */
export interface Ball {
  hop: Hop;
  edge: Edge;
  depart: number;
  arrive: number;
  ret: number;
  back: number;
  /** 0 request in flight, 1 held by the server, 2 response in flight */
  phase: 0 | 1 | 2;
  err: boolean;
  slow: boolean;
  rgb: Rgb;
}

interface Ring {
  x: number;
  y: number;
  rgb: Rgb;
  r0: number;
  r1: number;
  life: number;
  age: number;
  a: number;
}

export interface FloatingText {
  str: string;
  x: number;
  y: number;
  color: string;
  age: number;
  life: number;
  vy: number;
  size: number;
  weight: number;
  glow: boolean;
}

interface TextOpts {
  life?: number;
  vy?: number;
  size?: number;
  weight?: number;
  glow?: boolean;
  force?: boolean;
}

interface TraceHop extends Hop {
  kids: TraceHop[];
  parent: TraceHop | null;
}

export class Scene {
  readonly nodes = new Map<string, SceneNode>();
  readonly edges = new Map<string, Edge>();
  /** scheduled balls not yet departed, sorted by depart */
  queue: Ball[] = [];
  balls: Ball[] = [];
  rings: Ring[] = [];
  texts: FloatingText[] = [];
  /** playback time (epoch ms, same domain as hop timestamps) */
  play = 0;
  /** wall - play; fixed once set, so playback always runs at 1x */
  delay: number | null = null;
  /** sound hook: severity and world x of the event */
  sfx: ((sev: Severity, worldX: number) => void) | null = null;
  paused = false;
  /** ball speed multiplier */
  speed = 1;
  /** how many visual ms a real span ms takes while a ball is "held" */
  stretch = 2;
  layoutDirty = true;
  /** pinned node id */
  focus: string | null = null;
  hover: string | null = null;
  hoverEdge: string | null = null;
  time = 0;
  readonly sparks = new FloatList(SPARK_FLOATS, 4096);
  readonly out = {
    nodes: new FloatList(16, 64),
    edges: new FloatList(12, 2048),
    under: new FloatList(8, 4096),
    over: new FloatList(8, 1024),
    heat: new FloatList(8, 64),
  };
  private textBudget = 0;

  // ---- graph -------------------------------------------------------------
  node(id: string, kind?: NodeKind): SceneNode {
    let n = this.nodes.get(id);
    if (!n) {
      const h = hashStr(id);
      const k: NodeKind = id === 'user' ? 'user' : (kind || 'service');
      let rgb: Rgb;
      if (k === 'user') rgb = [0.85, 0.9, 1.0];
      else if (k === 'database') rgb = hslRgb(0.53 + h * 0.12, 0.85, 0.6);
      else if (k === 'external') rgb = hslRgb(0.72 + h * 0.12, 0.8, 0.66);
      else rgb = hslRgb((h * 7.31) % 1, 0.9, 0.6);
      n = {
        id, kind: k, x: 0, y: 0, tx: 0, ty: 0, placed: false,
        r: 26, tr: 26, rgb, lin: toLin(rgb), css: css(rgb),
        pulse: 0, heat: 0, flash: 0, shake: 0, lastRing: 0,
        rate: 0, errRate: 0, mean: null, outRate: 0, alpha: 0, lastSeen: performance.now(),
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

  edge(s: string, t: string, type: string): Edge {
    const key = `${s}→${t}`;
    let e = this.edges.get(key);
    if (!e) {
      this.node(s);
      this.node(t);
      e = new Edge(key, s, t, type || '');
      this.edges.set(key, e);
      this.layoutDirty = true;
    }
    if (type && !e.type) e.type = type;
    e.lastSeen = performance.now();
    return e;
  }

  applyGraph(g: Graph): void {
    const now = performance.now();
    for (const gn of g.nodes) {
      const n = this.node(gn.id, gn.kind);
      n.rate = gn.rate;
      n.errRate = gn.errRate;
      n.mean = gn.mean;
      n.outRate = gn.outRate;
      n.lastSeen = now;
    }
    for (const ge of g.edges) {
      const e = this.edge(ge.source, ge.target, ge.type);
      e.rate = ge.rate;
      e.err = ge.errRate;
      e.mean = ge.mean;
    }
    // forget what hasn't been seen for a while
    for (const [k, e] of this.edges) {
      if (now - e.lastSeen > 120000) {
        this.edges.delete(k);
        this.layoutDirty = true;
      }
    }
    for (const [id, n] of this.nodes) {
      if (now - n.lastSeen > 120000 && ![...this.edges.values()].some((e) => e.s === id || e.t === id)) {
        this.nodes.delete(id);
        this.layoutDirty = true;
      }
    }
  }

  /**
   * Layered left-to-right layout: longest-path ranks, sinks (databases, external APIs) in
   * the last column, barycentric ordering inside columns to untangle edges.
   */
  layout(): void {
    this.layoutDirty = false;
    const ids = [...this.nodes.keys()];
    if (!ids.length) return;
    const kindOf = (id: string) => this.nodes.get(id)?.kind ?? 'service';
    const isSink = (id: string) => kindOf(id) === 'database' || kindOf(id) === 'external';
    const preds = new Map<string, string[]>(ids.map((i) => [i, []]));
    const succs = new Map<string, string[]>(ids.map((i) => [i, []]));
    for (const e of this.edges.values()) {
      const p = preds.get(e.t), s = succs.get(e.s);
      if (e.s === e.t || !p || !s) continue;
      p.push(e.s);
      s.push(e.t);
    }
    const rank = new Map<string, number>();
    const rankOf = (id: string) => rank.get(id) ?? 0;
    for (const id of ids) rank.set(id, id === 'user' ? 0 : 1);
    for (let iter = 0; iter < ids.length; iter++) {
      let changed = false;
      for (const e of this.edges.values()) {
        if (isSink(e.t) || e.t === 'user' || e.s === e.t || !rank.has(e.s) || !rank.has(e.t)) continue;
        const r = rankOf(e.s) + 1;
        if (r > rankOf(e.t) && r < ids.length + 1) {
          rank.set(e.t, r);
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (!this.nodes.has('user')) for (const id of ids) rank.set(id, rankOf(id) - 1);
    let maxRank = 0;
    for (const id of ids) if (!isSink(id)) maxRank = Math.max(maxRank, rankOf(id));
    for (const id of ids) if (isSink(id)) rank.set(id, maxRank + 1);

    const cols: string[][] = [];
    for (const id of ids) (cols[rankOf(id)] ||= []).push(id);
    for (let i = 0; i < cols.length; i++) cols[i] ||= [];
    // initial order: databases first, then externals, then by name
    for (const c of cols) c.sort((a, b) => (KIND[kindOf(a)] - KIND[kindOf(b)]) || a.localeCompare(b));

    const ROW = 204, COL = 340;
    const ys = new Map<string, number>();
    const placeCol = (c: string[]) => c.forEach((id, i) => ys.set(id, (i - (c.length - 1) / 2) * ROW));
    cols.forEach(placeCol);
    const bary = (id: string, nb: Map<string, string[]>) => {
      const v = (nb.get(id) ?? []).filter((x) => ys.has(x));
      return v.length ? v.reduce((s, x) => s + (ys.get(x) ?? 0), 0) / v.length : (ys.get(id) ?? 0);
    };
    for (let sweep = 0; sweep < 8; sweep++) {
      const forward = sweep % 2 === 0;
      const order = forward ? cols.map((_, i) => i) : cols.map((_, i) => cols.length - 1 - i);
      for (const ci of order) {
        const nb = forward ? preds : succs;
        const keys = new Map(cols[ci].map((id) => [id, bary(id, nb)]));
        cols[ci].sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0));
        placeCol(cols[ci]);
      }
    }
    for (const [id, n] of this.nodes) {
      n.tx = rankOf(id) * COL;
      n.ty = ys.get(id) ?? 0;
      if (!n.placed) {
        n.x = n.tx - 60;
        n.y = n.ty;
        n.placed = true;
      }
    }
  }

  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes.values()) {
      x0 = Math.min(x0, n.tx - n.tr - (n.kind === 'user' ? 110 : 20));
      x1 = Math.max(x1, n.tx + n.tr + 20);
      y0 = Math.min(y0, n.ty - n.tr - 20);
      y1 = Math.max(y1, n.ty + n.tr + 44);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // ---- hops --------------------------------------------------------------
  /**
   * Hops arrive in batches. Each trace is replayed as a causal rally: a call only leaves a
   * service after the ball that triggered it has arrived there, and a response only goes back
   * after the children have returned.
   */
  ingest(hops: Hop[], wallNow: number, backlog: boolean): void {
    if (!hops.length) return;
    let maxT = -Infinity;
    for (const h of hops) maxT = Math.max(maxT, h.t);
    // The playback clock runs at real speed, a fixed delay behind the wall clock. Traces that
    // arrive later than that are shifted forward a little rather than slowing the clock down.
    if (this.delay === null) {
      this.delay = wallNow - maxT + 3500;
      this.play = wallNow - this.delay;
    }
    const byTrace = new Map<string, Hop[]>();
    for (const h of hops) {
      let list = byTrace.get(h.tr);
      if (!list) byTrace.set(h.tr, (list = []));
      list.push(h);
    }
    const cutoff = this.play - 1500;
    for (const list of byTrace.values()) this.scheduleTrace(list, cutoff, !backlog);
    this.queue.sort((a, b) => a.depart - b.depart);
  }

  private travelMs(e: Edge): number {
    return Math.min(1500, Math.max(260, (e.total / 720) * 1000)) / this.speed;
  }

  private scheduleTrace(trace: Hop[], cutoff: number, shiftLate: boolean): void {
    const hops: TraceHop[] = trace.map((h) => ({ ...h, kids: [], parent: null })).sort((a, b) => a.t - b.t);
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
      for (const p of hops) {
        if (p === h || p.to !== h.f || p.t > h.t) continue;
        if (!h.parent || p.t > h.parent.t) h.parent = p;
      }
    }
    for (const h of hops) h.parent?.kids.push(h);
    const S = this.stretch;
    const plan = (h: TraceHop, depart: number): number => {
      if (h.k === 'db') this.node(h.to, 'database');
      else if (h.k === 'ext') this.node(h.to, 'external');
      const e = this.edge(h.f, h.to, h.k === 'db' ? 'database' : h.k === 'ext' ? 'virtual_node' : '');
      const T = this.travelMs(e);
      const arrive = depart + T;
      let ready = arrive + h.d * S;
      const done: { h: TraceHop; back: number }[] = [];
      for (const c of h.kids.sort((a, b) => a.t - b.t)) {
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
        const { kids: _k, parent: _p, ...hop } = h;
        this.queue.push({ hop, edge: e, depart, arrive, ret, back: ret + T, phase: 0, err: h.e, slow: h.d > 250, rgb });
      }
      return ret + T;
    };
    for (const h of hops) if (!h.parent) plan(h, h.t + shift);
  }

  // ---- effects -------------------------------------------------------------
  private burst(x: number, y: number, n: number, rgb: Rgb, speed: number, life: number, size: number,
    dir: number | null = null, spread = Math.PI * 2): void {
    for (let i = 0; i < n; i++) {
      const a = dir === null ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * spread;
      const v = speed * (0.3 + Math.random() * 0.9);
      const l = life * (0.5 + Math.random() * 0.7);
      const k = 0.7 + Math.random() * 0.6;
      this.sparks.push(x, y, Math.cos(a) * v, Math.sin(a) * v, l, l, size * (0.5 + Math.random()), 0.12,
        rgb[0] * k, rgb[1] * k, rgb[2] * k, 1);
    }
  }

  private ring(x: number, y: number, rgb: Rgb, r0: number, r1: number, life: number, a = 0.9): void {
    this.rings.push({ x, y, rgb, r0, r1, life, age: 0, a });
  }

  private text(str: string, x: number, y: number, color: string, opts: TextOpts = {}): void {
    if (this.texts.length > 70 && !opts.force) return;
    this.texts.push({
      str, x, y, color, age: 0, life: opts.life || 1.6, vy: opts.vy ?? -22,
      size: opts.size || 12, weight: opts.weight || 500, glow: !!opts.glow,
    });
  }

  private onArrive(b: Ball): void {
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
      if (warn || this.time - n.lastRing > 0.35 || b.slow) {
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

  private onReturn(b: Ball): void {
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
        this.text(String(code), n.x - n.r - 30 - Math.random() * 40, n.y + (Math.random() - 0.5) * n.r * 3,
          warn ? '#ffb347' : 'rgba(190,210,235,0.75)', { size: warn ? 14 : 12, weight: 700, life: 1.4, vy: -10 });
      }
    }
  }

  // ---- per frame -------------------------------------------------------------
  update(wall: number, dt: number): void {
    this.time += dt;
    this.textBudget = Math.min(this.textBudget + dt * 14, 14);
    if (this.delay !== null) {
      if (this.paused) this.delay = wall - this.play;
      else this.play = Math.max(this.play, wall - this.delay);
    }
    if (this.layoutDirty) this.layout();

    // nodes: animate toward layout, decay effects
    const k = 1 - Math.exp(-dt * 4);
    for (const n of this.nodes.values()) {
      n.x += (n.tx - n.x) * k;
      n.y += (n.ty - n.y) * k;
      n.tr = n.kind === 'user' ? 38 : (n.kind === 'service' ? 31 : 26) + 6 * Math.log10(1 + n.rate * 4);
      n.r += (n.tr - n.r) * k;
      n.alpha = Math.min(1, n.alpha + dt * 1.5);
      n.pulse *= Math.exp(-dt * 5);
      n.flash *= Math.exp(-dt * 7);
      n.heat *= Math.exp(-dt * 0.9);
      n.shake *= Math.exp(-dt * 8);
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
      if (b.back >= play) this.balls.push(b);   // else: fell entirely in the past
    }
    if (qi) this.queue.splice(0, qi);
    if (this.queue.length > 30000) this.queue.splice(0, this.queue.length - 30000);

    // balls
    const alive: Ball[] = [];
    for (const b of this.balls) {
      if (b.phase === 0 && play >= b.arrive) { b.phase = 1; this.onArrive(b); }
      if (b.phase === 1 && play >= b.ret) b.phase = 2;
      if (b.phase === 2 && play >= b.back) { this.onReturn(b); continue; }
      alive.push(b);
    }
    this.balls = alive;
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < r.life);
    for (const t of this.texts) { t.age += dt; t.y += t.vy * dt; }
    this.texts = this.texts.filter((t) => t.age < t.life);
  }

  // ---- GPU buffers -------------------------------------------------------------
  /** the focused/hovered node and its neighbours, or null */
  focusSet(): Set<string> | null {
    const id = this.focus || this.hover;
    if (!id) return null;
    const s = new Set([id]);
    for (const e of this.edges.values()) {
      if (e.s === id) s.add(e.t);
      if (e.t === id) s.add(e.s);
    }
    return s;
  }

  build(): void {
    const o = this.out;
    for (const l of Object.values(o)) l.reset();
    const fs = this.focusSet();
    const focusId = this.focus || this.hover;
    const dimOf = (id: string) => (!fs || fs.has(id) ? 1 : 0.18);
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
      const rgb = b.rgb;   // the trace's colour, on the way there and back
      if (b.phase === 1) {
        // held inside the server: orbiting dot, shows concurrency
        const ang = this.time * 2.4 + (b.depart % 1000) * 0.0063;
        const rr = dst.r * 0.55;
        o.under.push(dst.x + Math.cos(ang) * rr, dst.y + Math.sin(ang) * rr, 1.6, 0, rgb[0], rgb[1], rgb[2], 0.5 * dim);
        continue;
      }
      const req = b.phase === 0;
      const t0 = req ? b.depart : b.ret, t1 = req ? b.arrive : b.back;
      const dur = t1 - t0;
      const size = (req ? 3.4 : 2.7) + Math.min(3.5, Math.log10(1 + h.d) * 1.3) + (b.err ? 1.5 : 0);
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
      const sx = (Math.random() - 0.5) * n.shake * 6, sy = (Math.random() - 0.5) * n.shake * 6;
      o.nodes.push(n.x + sx, n.y + sy, n.r, n.pulse, n.lin[0], n.lin[1], n.lin[2], err,
        0, heat, KIND[n.kind], n.alpha * dimOf(n.id),
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
