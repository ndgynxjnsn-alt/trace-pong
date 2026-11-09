// Scene state: nodes (services, endpoints, users), force layout, the playback clock, balls (one
// per hop), sparks, shockwaves and floating text. Produces flat Float32Arrays for the GPU.
import {
  forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { SPARK_FLOATS } from './gpu';
import type { Graph, GraphNode, Hop, NodeKind, Rgb, Severity, UserInfo, ViewMode } from './types';

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

/** colour of a service / server, shared by its endpoints and its group outline */
function ownerRgb(owner: string, kind: NodeKind): Rgb {
  const h = hashStr(owner);
  if (kind === 'user') return [0.78, 0.86, 1.0];
  if (kind === 'database') return hslRgb(0.53 + h * 0.12, 0.85, 0.6);
  if (kind === 'external') return hslRgb(0.72 + h * 0.12, 0.8, 0.66);
  return hslRgb((h * 7.31) % 1, 0.9, 0.6);
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
/** separator inside node ids and group keys (never shown) */
const SEP = '\u001f';
/** time constant (s) of the hop-based statistics */
const TAU = 30;

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
  /** shown statistics (from the service graph, or estimated from hops) */
  rate = 0;
  err = 0;
  mean: number | null = null;
  /** decayed hop counters */
  hHits = 0;
  hErr = 0;
  hLat = 0;
  fromGraph = false;
  readonly pts = new Float32Array(SAMPLES * 2);
  readonly len = new Float32Array(SAMPLES);
  total = 1;
  lastSeen = performance.now();

  constructor(readonly key: string, readonly s: string, readonly t: string, public type: string) {}

  rebuild(a: { x: number; y: number }, b: { x: number; y: number }, flow: boolean): void {
    const p0: Vec2 = [a.x, a.y], p3: Vec2 = [b.x, b.y];
    let p1: Vec2, p2: Vec2;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (flow && dx > 40) {
      p1 = [a.x + dx * 0.5, a.y];
      p2 = [b.x - dx * 0.5, b.y];
    } else {
      // a gentle arc, always bending the same way relative to the direction of the call
      const k = 0.18;
      p1 = [a.x + dx / 3 - dy * k, a.y + dy / 3 + dx * k];
      p2 = [a.x + (dx * 2) / 3 - dy * k, a.y + (dy * 2) / 3 + dx * k];
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
export type NodeLevel = 'service' | 'endpoint' | 'user';

export interface SceneNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: NodeKind;
  level: NodeLevel;
  /** group path: [] none, ['users'], ['gateway'], ['postgres', 'users_db'] */
  group: string[];
  /** top-level owner (service, server or 'users'); decides layout rank and colour */
  owner: string;
  user?: UserInfo;
  x: number;
  y: number;
  r: number;
  rgb: Rgb;
  lin: Rgb;
  css: string;
  pulse: number;
  heat: number;
  flash: number;
  shake: number;
  lastRing: number;
  /** recent activity (1 = just now), shows user labels for a moment */
  active: number;
  /** shown statistics: from the service graph, or estimated from hops */
  rate: number;
  errRate: number;
  mean: number | null;
  outRate: number;
  /** decayed hop counters: calls received, failed, their latency sum, calls made */
  hHits: number;
  hErr: number;
  hLat: number;
  hOut: number;
  fromGraph: boolean;
  alpha: number;
  lastSeen: number;
  dying: boolean;
  inflight: number;
}

interface NodeSpec {
  id: string;
  label: string;
  kind: NodeKind;
  level: NodeLevel;
  group: string[];
  owner: string;
  user?: UserInfo;
}

/** A hop scheduled for playback: depart -> arrive (request), held, ret -> back (response). */
export interface Ball {
  hop: Hop;
  edge: Edge;
  src: string;
  dst: string;
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

/** A drawn group outline (service with its endpoints, database server, users). */
export interface GroupOut {
  key: string;
  label: string;
  depth: number;
  /** label anchor: top of the outline */
  x: number;
  y: number;
  css: string;
  stats: GraphNode | null;
}

interface Link extends SimulationLinkDatum<SceneNode> {
  same: boolean;
}

interface TraceHop {
  h: Hop;
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
  groups: GroupOut[] = [];
  mode: ViewMode = { endpoints: false, userNames: false, layout: 'radial' };
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
    hulls: new FloatList(8, 1024),
  };
  private textBudget = 0;
  private graph: Graph | null = null;
  private readonly svcStats = new Map<string, GraphNode>();
  private readonly kinds = new Map<string, NodeKind>();
  /** hops played recently, to rebuild the endpoint view at once when it is switched on */
  private recent: Hop[] = [];
  /** decayed count of all played hops (excluding users), for the sampling factor */
  private hopCount = 0;
  /** service-graph rate / sampled hop rate */
  private factor = 1;
  private lastIdentifiedUser = -Infinity;
  private lastAnonUser = -Infinity;
  private topologyDirty = true;
  private readonly sim: Simulation<SceneNode, Link>;
  private groupMembers = new Map<string, SceneNode[]>();

  constructor() {
    this.sim = forceSimulation<SceneNode, Link>().stop().alphaDecay(0.025).velocityDecay(0.38);
  }

  get hasData(): boolean {
    return this.nodes.size > 0;
  }

  // ---- view modes ----------------------------------------------------------
  setMode(m: ViewMode): void {
    const rebuild = m.endpoints !== this.mode.endpoints;
    const relayout = m.layout !== this.mode.layout;
    this.mode = { ...m };
    if (rebuild) this.rebuild();
    else if (relayout) {
      if (m.layout === 'radial') this.unfold();
      this.topologyDirty = true;
      this.sim.alpha(1);
    }
  }

  /** Left-to-right positions -> polar: x becomes the radius, y the angle around the full circle. */
  private unfold(): void {
    const ns = [...this.nodes.values()];
    if (!ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x));
    const ys = ns.map((n) => n.y);
    const y0 = Math.min(...ys), span = Math.max(1, Math.max(...ys) - y0);
    for (const n of ns) {
      const a = ((n.y - y0) / span) * Math.PI * 2 * 0.92;
      const r = n.x - x0;
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
      n.vx = n.vy = 0;
    }
  }

  /** Throw away nodes and edges and recreate them for the current mode; new nodes start at their owner's old place. */
  private rebuild(): void {
    const old = new Map<string, { x: number; y: number; n: number }>();
    for (const n of this.nodes.values()) {
      const o = old.get(n.owner) ?? { x: 0, y: 0, n: 0 };
      o.x += n.x;
      o.y += n.y;
      o.n++;
      old.set(n.owner, o);
    }
    this.nodes.clear();
    this.edges.clear();
    this.hover = this.focus = this.hoverEdge = null;
    const seed = (n: SceneNode) => {
      const o = old.get(n.owner);
      if (o) {
        n.x = o.x / o.n + (Math.random() - 0.5) * 30;
        n.y = o.y / o.n + (Math.random() - 0.5) * 30;
      }
    };
    if (this.graph && !this.mode.endpoints) this.applyGraph(this.graph);
    for (const h of this.recent) this.edgeFor(h);
    for (const b of [...this.queue, ...this.balls]) {
      const e = this.edgeFor(b.hop);
      b.edge = e;
      b.src = e.s;
      b.dst = e.t;
    }
    for (const n of this.nodes.values()) seed(n);
    this.topologyDirty = true;
    this.sim.alpha(1);
  }

  // ---- nodes and edges -----------------------------------------------------
  private kindOf(service: string): NodeKind {
    return service === 'user' ? 'user' : this.kinds.get(service) ?? 'service';
  }

  private srcSpec(h: Hop): NodeSpec {
    if (h.f === 'user') {
      if (h.u) return { id: `user${SEP}${h.u.id}`, label: h.u.id, kind: 'user', level: 'user', group: ['users'], owner: 'users', user: h.u };
      return { id: 'user', label: 'USERS', kind: 'user', level: 'service', group: [], owner: 'user' };
    }
    if (this.mode.endpoints && h.fe) {
      return { id: `${h.f}${SEP}${h.fe}`, label: h.fe, kind: this.kindOf(h.f), level: 'endpoint', group: [h.f], owner: h.f };
    }
    return { id: h.f, label: h.f, kind: this.kindOf(h.f), level: 'service', group: [], owner: h.f };
  }

  private dstSpec(h: Hop): NodeSpec {
    const kind: NodeKind = h.k === 'db' ? 'database' : h.k === 'ext' ? 'external' : this.kindOf(h.to);
    if (this.mode.endpoints && h.te) {
      const g = h.tg?.length ? h.tg : [h.to];
      return { id: [...g, h.te].join(SEP), label: h.te, kind, level: 'endpoint', group: g, owner: g[0] };
    }
    return { id: h.to, label: h.to, kind, level: 'service', group: [], owner: h.to };
  }

  private node(spec: NodeSpec, near?: SceneNode): SceneNode {
    let n = this.nodes.get(spec.id);
    if (n) {
      if (spec.kind !== n.kind && n.kind === 'service' && spec.kind !== 'user') {
        n.kind = spec.kind;
        this.recolor(n);
      }
      if (spec.user) n.user = spec.user;
      n.lastSeen = performance.now();
      n.dying = false;
      return n;
    }
    const rgb = this.colorOf(spec);
    // start next to the rest of the group; else one step further out than the node that calls it
    const mates = spec.group.length ? this.groupMembers.get(spec.group.join(SEP)) : undefined;
    const mate = mates?.find((m) => this.nodes.has(m.id));
    const jitter = () => (Math.random() - 0.5) * 60;
    let x: number, y: number;
    if (mate) {
      x = mate.x + jitter();
      y = mate.y + jitter();
    } else if (this.mode.layout === 'flow') {
      x = (near?.x ?? 0) + 220 + jitter();
      y = (near?.y ?? 0) + jitter() * 4;
    } else {
      // radial: a spread-out angle, near the caller's if there is one
      const ang = near && (near.x || near.y) ? Math.atan2(near.y, near.x) + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
      const rad = (near ? Math.hypot(near.x, near.y) : 0) + 220;
      x = Math.cos(ang) * rad;
      y = Math.sin(ang) * rad;
    }
    n = {
      ...spec,
      x,
      y,
      r: spec.level === 'user' ? 9 : spec.level === 'endpoint' ? 16 : 26,
      rgb, lin: toLin(rgb), css: css(rgb),
      pulse: 0, heat: 0, flash: 0, shake: 0, lastRing: 0, active: 0,
      rate: 0, errRate: 0, mean: null, outRate: 0,
      hHits: 0, hErr: 0, hLat: 0, hOut: 0,
      fromGraph: false, alpha: 0, lastSeen: performance.now(), dying: false, inflight: 0,
    };
    this.nodes.set(spec.id, n);
    this.topologyDirty = true;
    return n;
  }

  private colorOf(spec: NodeSpec): Rgb {
    if (spec.level === 'user') {
      // pale, slightly different per person
      return hslRgb(hashStr(spec.user?.id ?? spec.id), 0.45, 0.78);
    }
    const base = ownerRgb(spec.owner, spec.kind);
    if (spec.level !== 'endpoint') return base;
    // endpoints: their service's hue, a little lighter or darker each
    const k = 0.85 + hashStr(spec.label) * 0.35;
    return [Math.min(1, base[0] * k), Math.min(1, base[1] * k), Math.min(1, base[2] * k)];
  }

  private recolor(n: SceneNode): void {
    n.rgb = this.colorOf(n);
    n.lin = toLin(n.rgb);
    n.css = css(n.rgb);
  }

  private edge(src: NodeSpec, dst: NodeSpec, type: string): Edge {
    const key = `${src.id}→${dst.id}`;
    let e = this.edges.get(key);
    const s = this.node(src);
    this.node(dst, s);
    if (!e) {
      e = new Edge(key, src.id, dst.id, type);
      this.edges.set(key, e);
      this.topologyDirty = true;
    }
    if (type && !e.type) e.type = type;
    e.lastSeen = performance.now();
    return e;
  }

  private edgeFor(h: Hop): Edge {
    return this.edge(this.srcSpec(h), this.dstSpec(h), h.k === 'db' ? 'database' : h.k === 'ext' ? 'virtual_node' : '');
  }

  /** Service-graph metrics: node kinds and stats; in the service view also the nodes and edges themselves. */
  applyGraph(g: Graph): void {
    this.graph = g;
    this.svcStats.clear();
    for (const gn of g.nodes) {
      this.svcStats.set(gn.id, gn);
      if (gn.kind !== 'service') this.kinds.set(gn.id, gn.kind);
    }
    // sampling factor: how many real calls one played hop stands for
    let total = 0;
    for (const e of g.edges) if (e.source !== 'user') total += e.rate;
    const sampled = this.hopCount / TAU;
    if (sampled > 0.05 && total > 0) this.factor = Math.max(1, Math.min(1000, total / sampled));

    if (this.mode.endpoints) return;
    const now = performance.now();
    // per-user nodes replace Tempo's aggregate `user` node while identified users are around
    const hideUser = now - this.lastIdentifiedUser < 90000 && now - this.lastAnonUser > 90000;
    for (const ge of g.edges) {
      if (hideUser && ge.source === 'user') continue;
      const spec = (id: string): NodeSpec => ({
        id, label: id === 'user' ? 'USERS' : id, kind: id === 'user' ? 'user' : this.kindOf(id),
        level: 'service', group: [], owner: id,
      });
      const e = this.edge(spec(ge.source), spec(ge.target), ge.type);
      e.fromGraph = true;
      e.rate = ge.rate;
      e.err = ge.errRate;
      e.mean = ge.mean;
    }
    for (const gn of g.nodes) {
      const n = this.nodes.get(gn.id);
      if (!n) continue;
      n.fromGraph = true;
      n.rate = gn.rate;
      n.errRate = gn.errRate;
      n.mean = gn.mean;
      n.outRate = gn.outRate;
      n.lastSeen = now;
    }
  }

  // ---- layout ---------------------------------------------------------------
  /** Longest-path depth of each owner from the users; sinks (databases, external APIs) last. */
  private ranks(): Map<string, number> {
    const owners = new Map<string, NodeKind>();
    for (const n of this.nodes.values()) if (!owners.has(n.owner) || n.level !== 'endpoint') owners.set(n.owner, n.kind);
    const ownerOf = (id: string) => this.nodes.get(id)?.owner;
    const links: [string, string][] = [];
    for (const e of this.edges.values()) {
      const a = ownerOf(e.s), b = ownerOf(e.t);
      if (a && b && a !== b) links.push([a, b]);
    }
    const isSink = (o: string) => owners.get(o) === 'database' || owners.get(o) === 'external';
    const isUser = (o: string) => owners.get(o) === 'user';
    const rank = new Map<string, number>();
    for (const o of owners.keys()) rank.set(o, isUser(o) ? 0 : 1);
    for (let iter = 0; iter < owners.size; iter++) {
      let changed = false;
      for (const [a, b] of links) {
        if (isSink(b) || isUser(b)) continue;
        const r = (rank.get(a) ?? 0) + 1;
        if (r > (rank.get(b) ?? 0) && r <= owners.size) {
          rank.set(b, r);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const hasUsers = [...owners.keys()].some(isUser);
    let max = 0;
    for (const [o, r] of rank) {
      if (!hasUsers) rank.set(o, r - 1);
      if (!isSink(o)) max = Math.max(max, rank.get(o) ?? 0);
    }
    for (const o of owners.keys()) if (isSink(o)) rank.set(o, max + 1);
    return rank;
  }

  /**
   * Radial-tree sectors: a spanning tree over owners from the users outward; each subtree gets a
   * slice of [0, 1) proportional to its size. Returns the centre of each owner's slice. Radial
   * mode turns it into an angle around the circle, left-to-right mode into the vertical order.
   */
  private sectors(rank: Map<string, number>): Map<string, number> {
    const ownerOf = (id: string) => this.nodes.get(id)?.owner;
    const out = new Map<string, Set<string>>();
    // heavier links first, so a node hangs under its main caller
    const links = [...this.edges.values()].sort((a, b) => b.rate - a.rate);
    for (const e of links) {
      const a = ownerOf(e.s), b = ownerOf(e.t);
      if (!a || !b || a === b || (rank.get(b) ?? 0) <= (rank.get(a) ?? 0)) continue;
      let set = out.get(a);
      if (!set) out.set(a, (set = new Set()));
      set.add(b);
    }
    const parent = new Map<string, string>();
    const owners = [...rank.keys()].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || a.localeCompare(b));
    const kids = new Map<string, string[]>();
    for (const o of owners) {
      for (const c of out.get(o) ?? []) {
        if (parent.has(c)) continue;
        parent.set(c, o);
        let list = kids.get(o);
        if (!list) kids.set(o, (list = []));
        list.push(c);
      }
    }
    const size = new Map<string, number>();
    const sizeOf = (o: string, depth = 0): number => {
      const known = size.get(o);
      if (known !== undefined) return known;
      const v = depth > 64 ? 1 : Math.max(1, (kids.get(o) ?? []).reduce((sum, c) => sum + sizeOf(c, depth + 1), 0));
      size.set(o, v);
      return v;
    };
    const centre = new Map<string, number>();
    const assign = (o: string, a0: number, a1: number, depth = 0) => {
      centre.set(o, (a0 + a1) / 2);
      if (depth > 64) return;
      const list = kids.get(o) ?? [];
      const total = list.reduce((sum, c) => sum + sizeOf(c), 0) || 1;
      let a = a0;
      for (const c of list) {
        const w = ((a1 - a0) * sizeOf(c)) / total;
        assign(c, a, a + w, depth + 1);
        a += w;
      }
    };
    const roots = owners.filter((o) => !parent.has(o));
    const total = roots.reduce((sum, r) => sum + sizeOf(r), 0) || 1;
    let a = 0;
    for (const r of roots) {
      const w = sizeOf(r) / total;
      assign(r, a, a + w);
      a += w;
    }
    return centre;
  }

  /** Recompute groups and forces after the set of nodes or edges changed. */
  private relayout(): void {
    this.topologyDirty = false;
    const nodes = [...this.nodes.values()];
    // groups at every level of each node's path
    const groups = new Map<string, SceneNode[]>();
    for (const n of nodes) {
      for (let i = 1; i <= n.group.length; i++) {
        const k = n.group.slice(0, i).join(SEP);
        let list = groups.get(k);
        if (!list) groups.set(k, (list = []));
        list.push(n);
      }
    }
    this.groupMembers = groups;

    const rank = this.ranks();
    const rankOf = (n: SceneNode) => rank.get(n.owner) ?? 1;
    const ep = this.mode.endpoints;
    const flow = this.mode.layout === 'flow';
    const COL = ep ? 470 : 330;
    const RING = ep ? 480 : 250;
    const links: Link[] = [];
    for (const e of this.edges.values()) {
      const s = this.nodes.get(e.s), t = this.nodes.get(e.t);
      if (s && t && s !== t) links.push({ source: s, target: t, same: s.owner === t.owner });
    }
    const sim = this.sim;
    sim.nodes(nodes);
    sim.force('link', forceLink<SceneNode, Link>(links)
      .distance((l) => (l.same ? 60 : flow ? COL * 0.7 : RING * 0.75))
      .strength((l) => (l.same ? 0.4 : 0.06)));
    sim.force('charge', forceManyBody<SceneNode>()
      .strength((n) => (n.level === 'user' ? -50 : n.level === 'endpoint' ? -160 : -700))
      .distanceMax(flow ? 900 : 2600));
    sim.force('collide', forceCollide<SceneNode>((n) => n.r + (n.level === 'user' ? 9 : n.level === 'endpoint' ? 18 : 30))
      .strength(0.9).iterations(2));
    const sector = this.sectors(rank);
    const sec = (n: SceneNode) => sector.get(n.owner) ?? 0.5;
    if (flow) {
      // columns by depth; the vertical order follows the call tree
      const height = Math.max(600, sector.size * (ep ? 150 : 90));
      sim.force('x', forceX<SceneNode>((n) => rankOf(n) * COL).strength(0.5));
      sim.force('y', forceY<SceneNode>((n) => (sec(n) - 0.5) * height).strength((n) => (n.level === 'user' ? 0.05 : 0.12)));
      sim.force('radial', null);
    } else {
      // rings by depth; each subtree gets its slice of the circle, users in the middle
      const at = (n: SceneNode): Vec2 => {
        const r = rankOf(n) * RING, a = sec(n) * Math.PI * 2;
        return [Math.cos(a) * r, Math.sin(a) * r];
      };
      sim.force('radial', forceRadial<SceneNode>((n) => rankOf(n) * RING, 0, 0).strength(0.45));
      sim.force('x', forceX<SceneNode>((n) => at(n)[0]).strength((n) => (rankOf(n) ? 0.12 : 0.02)));
      sim.force('y', forceY<SceneNode>((n) => at(n)[1]).strength((n) => (rankOf(n) ? 0.12 : 0.02)));
    }
    // members of a group pull towards its centre, inner groups harder; top-level groups keep
    // their outlines apart (node collision alone lets two groups interleave)
    // sibling groups: top-level groups, and the groups inside each group (databases of a server)
    const siblings = new Map<string, SceneNode[][]>();
    for (const [k, m] of groups) {
      const parent = k.includes(SEP) ? k.slice(0, k.lastIndexOf(SEP)) : '';
      let list = siblings.get(parent);
      if (!list) siblings.set(parent, (list = []));
      list.push(m);
    }
    sim.force('groupSep', (alpha: number) => {
      for (const sibs of siblings.values()) if (sibs.length > 1) separate(sibs, alpha);
    });
    const separate = (sibs: SceneNode[][], alpha: number) => {
      const disc = sibs.map((members) => {
        let cx = 0, cy = 0;
        for (const m of members) {
          cx += m.x;
          cy += m.y;
        }
        cx /= members.length;
        cy /= members.length;
        let r = 0;
        for (const m of members) r = Math.max(r, Math.hypot(m.x - cx, m.y - cy) + m.r);
        const below = Math.max(...members.map((m) => m.group.length)) - 1;
        return { members, cx, cy, r: r + 22 + below * 28 };
      });
      for (let i = 0; i < disc.length; i++) {
        for (let j = i + 1; j < disc.length; j++) {
          const a = disc[i], b = disc[j];
          let dx = b.cx - a.cx, dy = b.cy - a.cy;
          let d = Math.hypot(dx, dy);
          if (d < 1e-3) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d = Math.hypot(dx, dy);
          }
          const overlap = a.r + b.r - d;
          if (overlap <= 0) continue;
          const k = (overlap / d) * alpha * 0.3;
          for (const m of a.members) {
            m.vx = (m.vx ?? 0) - dx * k;
            m.vy = (m.vy ?? 0) - dy * k;
          }
          for (const m of b.members) {
            m.vx = (m.vx ?? 0) + dx * k;
            m.vy = (m.vy ?? 0) + dy * k;
          }
        }
      }
    };
    sim.force('group', (alpha: number) => {
      for (const [key, members] of groups) {
        if (members.length < 2) continue;
        const depth = key.split(SEP).length;
        const k = (depth > 1 ? 0.35 : 0.18) * alpha;
        let cx = 0, cy = 0;
        for (const m of members) {
          cx += m.x;
          cy += m.y;
        }
        cx /= members.length;
        cy /= members.length;
        for (const m of members) {
          m.vx = (m.vx ?? 0) + (cx - m.x) * k;
          m.vy = (m.vy ?? 0) + (cy - m.y) * k;
        }
      }
    });
    sim.alpha(Math.max(sim.alpha(), 0.35));
  }

  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes.values()) {
      const pad = n.group.length ? 40 + n.group.length * 14 : 26;
      x0 = Math.min(x0, n.x - n.r - pad);
      x1 = Math.max(x1, n.x + n.r + pad);
      y0 = Math.min(y0, n.y - n.r - pad - 18);
      y1 = Math.max(y1, n.y + n.r + pad + 18);
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
    const hops: TraceHop[] = trace.slice(0, 3000).sort((a, b) => a.t - b.t).map((h) => ({ h, kids: [], parent: null }));
    // late trace: start it now-ish (spread over a poll interval) instead of dropping it;
    // anything more than 20 s late is stale and skipped
    let shift = 0;
    const late = this.play - hops[0].h.t;
    if (shiftLate && late > 0) {
      if (late > 20000) return;
      shift = late + Math.random() * 900;
    }
    const rgb = traceRgb(hops[0].h.tr);
    // parent = the latest earlier hop into our caller (earlier in sorted order, so no cycles)
    const intoService = new Map<string, TraceHop[]>();
    for (const th of hops) {
      const cands = intoService.get(th.h.f);
      if (cands?.length) th.parent = cands[cands.length - 1];
      let list = intoService.get(th.h.to);
      if (!list) intoService.set(th.h.to, (list = []));
      list.push(th);
    }
    for (const th of hops) th.parent?.kids.push(th);
    const S = this.stretch;
    const plan = (th: TraceHop, depart: number): number => {
      const h = th.h;
      const e = this.edgeFor(h);
      const T = this.travelMs(e);
      const arrive = depart + T;
      let ready = arrive + h.d * S;
      const done: { h: Hop; back: number }[] = [];
      for (const c of th.kids) {
        let dep = arrive + (c.h.t - h.t) * S;
        // a call that started after a sibling finished waits for that sibling's response
        for (const s of done) if (c.h.t >= s.h.t + s.h.d - 0.05) dep = Math.max(dep, s.back + (c.h.t - (s.h.t + s.h.d)) * S);
        const back = plan(c, dep);
        done.push({ h: c.h, back });
        const async = c.h.t > h.t + h.d;   // queue consumer after the producer returned
        if (!async) ready = Math.max(ready, back + 12);
      }
      const ret = ready;
      if (depart >= cutoff) {
        this.queue.push({ hop: h, edge: e, src: e.s, dst: e.t, depart, arrive, ret, back: ret + T, phase: 0, err: h.e, slow: h.d > 250, rgb });
      }
      return ret + T;
    };
    for (const th of hops) if (!th.parent) plan(th, th.h.t + shift);
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

  private onDepart(b: Ball): void {
    const h = b.hop;
    const now = performance.now();
    if (h.f === 'user') {
      if (h.u) this.lastIdentifiedUser = now;
      else this.lastAnonUser = now;
    } else {
      this.hopCount += 1;
    }
    this.recent.push(h);
    if (this.recent.length > 6000) this.recent.splice(0, this.recent.length - 5000);
    const src = this.nodes.get(b.src);
    if (src) {
      src.hOut += 1;
      src.lastSeen = now;
      src.active = 1;
      if (src.level === 'user') src.pulse = Math.min(src.pulse + 0.5, 0.9);
    }
  }

  private onArrive(b: Ball): void {
    const h = b.hop, n = this.nodes.get(b.dst), from = this.nodes.get(b.src);
    if (!n) return;
    n.lastSeen = performance.now();
    n.hHits += 1;
    n.hLat += h.d;
    if (h.e) n.hErr += 1;
    b.edge.hHits += 1;
    b.edge.hLat += h.d;
    if (h.e) b.edge.hErr += 1;
    n.heat = Math.min(n.heat + 0.05, 4);
    n.pulse = Math.min(n.pulse + 0.25, 0.9);
    n.inflight++;
    const ang = from ? Math.atan2(from.x - n.x, -(from.y - n.y)) : Math.PI * 1.5;
    const inDir = from ? Math.atan2(n.y - from.y, n.x - from.x) : 0;
    const fx = statusFx(h);
    if (fx.sev === 'err') {
      // errors smash into the node
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
    if (this.textBudget > 0 && (h.f === 'user' || b.err || Math.random() < 0.12) && n.level !== 'endpoint') {
      this.textBudget--;
      this.text(h.n, n.x + (Math.random() - 0.5) * 30, n.y - n.r - 20, b.err ? RED_CSS : css(n.rgb, 1), { life: 1.8, size: h.f === 'user' ? 13 : 11 });
    }
  }

  private onReturn(b: Ball): void {
    const h = b.hop, n = this.nodes.get(b.src), srv = this.nodes.get(b.dst);
    if (srv) srv.inflight = Math.max(0, srv.inflight - 1);
    if (!n) return;
    const code = h.c || (b.err ? 'ERR' : 'OK');
    if (b.err) {
      this.burst(n.x, n.y, 40, RED, 300, 0.8, 2.2);
      this.ring(n.x, n.y, RED, n.r, n.r * 2.4, 0.6);
      this.text(String(code), n.x - n.r - 26, n.y + (Math.random() - 0.5) * n.r * 2, RED_CSS, { size: 16, weight: 800, life: 2.2, vy: -14, force: true, glow: true });
    } else {
      n.flash = Math.max(n.flash, 0.6);
      if (h.f === 'user' && this.textBudget > 0 && n.level !== 'user') {
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
    this.decayAndExpire(dt);
    if (this.topologyDirty) this.relayout();
    if (this.sim.alpha() > this.sim.alphaMin()) this.sim.tick(this.sim.alpha() > 0.5 ? 2 : 1);

    // nodes: grow toward their size, decay effects
    const k = 1 - Math.exp(-dt * 4);
    for (const n of this.nodes.values()) {
      const r = n.level === 'user' ? 8 + 2 * Math.log10(1 + n.outRate * 20)
        : n.level === 'endpoint' ? (n.kind === 'database' ? 13 : 15) + 4 * Math.log10(1 + n.rate * 4)
          : n.id === 'user' ? 38
            : (n.kind === 'service' ? 31 : 26) + 6 * Math.log10(1 + n.rate * 4);
      n.r += (r - n.r) * k;
      n.alpha = n.dying ? Math.max(0, n.alpha - dt * 1.2) : Math.min(1, n.alpha + dt * 1.5);
      n.pulse *= Math.exp(-dt * 5);
      n.flash *= Math.exp(-dt * 7);
      n.heat *= Math.exp(-dt * 0.9);
      n.shake *= Math.exp(-dt * 8);
      n.active *= Math.exp(-dt * 0.8);
    }
    const flow = this.mode.layout === 'flow';
    for (const e of this.edges.values()) {
      const a = this.nodes.get(e.s), b = this.nodes.get(e.t);
      if (a && b) e.rebuild(a, b, flow);
    }

    // launch balls whose time has come
    const play = this.play;
    let qi = 0;
    while (qi < this.queue.length && this.queue[qi].depart <= play) {
      const b = this.queue[qi++];
      if (b.back < play) continue;   // fell entirely in the past
      this.balls.push(b);
      this.onDepart(b);
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

  /** Hop statistics decay; nodes and edges nobody uses any more fade out and go. */
  private decayAndExpire(dt: number): void {
    const d = Math.exp(-dt / TAU);
    this.hopCount *= d;
    const now = performance.now();
    const f = this.factor;
    for (const e of this.edges.values()) {
      e.hHits *= d;
      e.hErr *= d;
      e.hLat *= d;
      if (!e.fromGraph) {
        e.rate = (e.hHits / TAU) * f;
        e.err = (e.hErr / TAU) * f;
        e.mean = e.hHits > 0.05 ? e.hLat / e.hHits : null;
      }
    }
    let removed = false;
    for (const [id, n] of this.nodes) {
      n.hHits *= d;
      n.hErr *= d;
      n.hLat *= d;
      n.hOut *= d;
      if (!n.fromGraph) {
        n.rate = (n.hHits / TAU) * f;
        n.errRate = (n.hErr / TAU) * f;
        n.mean = n.hHits > 0.05 ? n.hLat / n.hHits : null;
        n.outRate = (n.hOut / TAU) * f;
      }
      const idle = now - n.lastSeen;
      const ttl = n.level === 'user' ? 45000 : n.fromGraph ? 120000 : 90000;
      if (idle > ttl && !n.dying && (n.inflight === 0 || idle > ttl * 2)) n.dying = true;
      if (n.dying && n.alpha <= 0) {
        this.nodes.delete(id);
        if (this.focus === id) this.focus = null;
        if (this.hover === id) this.hover = null;
        removed = true;
      }
    }
    if (removed) {
      for (const [k, e] of this.edges) if (!this.nodes.has(e.s) || !this.nodes.has(e.t)) this.edges.delete(k);
      this.balls = this.balls.filter((b) => this.nodes.has(b.src) && this.nodes.has(b.dst));
      this.topologyDirty = true;
    }
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

  /** text shown for a node */
  labelOf(n: SceneNode): string {
    if (n.level === 'user' && n.user) {
      return this.mode.userNames ? (n.user.name ?? n.user.username ?? n.user.email ?? n.user.id) : n.user.id;
    }
    return n.label;
  }

  build(): void {
    const o = this.out;
    for (const l of Object.values(o)) l.reset();
    const fs = this.focusSet();
    const focusId = this.focus || this.hover;
    const dimOf = (id: string) => (!fs || fs.has(id) ? 1 : 0.18);
    const play = this.play;

    this.buildGroups(dimOf);

    // edges
    for (const e of this.edges.values()) {
      const a = this.nodes.get(e.s), b = this.nodes.get(e.t);
      if (!a || !b) continue;
      const lit = !focusId || e.s === focusId || e.t === focusId;
      const errf = e.rate > 0 ? Math.min(1, (e.err / e.rate) * 4) : 0;
      let col = [0.16 + 0.84 * errf, 0.24 - 0.14 * errf, 0.42 - 0.3 * errf];
      if (this.hoverEdge === e.key) col = col.map((c) => c * 2.2);
      const user = a.level === 'user';
      const alpha = Math.min(a.alpha, b.alpha) * (lit ? 1 : 0.15) * (focusId && lit ? 1.6 : 1) * (user ? 0.5 : 1);
      const width = user ? 0.8 : 1.2 + 2.4 * Math.log10(1 + e.rate * 2);
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
      const src = this.nodes.get(b.src), dst = this.nodes.get(b.dst);
      if (!src || !dst) continue;
      const dim = fs ? (fs.has(b.src) && fs.has(b.dst) && (b.src === focusId || b.dst === focusId) ? 1 : 0.12) : 1;
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
      if (heat > 0.02 && n.level !== 'user' && o.heat.count < 64) {
        o.heat.push(n.x, n.y, n.r * 2.6, 0.022 * heat * dimOf(n.id), n.lin[0], n.lin[1], n.lin[2], 0);
      }
    }

    for (const r of this.rings) {
      const k = r.age / r.life;
      const e = 1 - Math.pow(1 - k, 3);
      o.over.push(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 1, r.rgb[0], r.rgb[1], r.rgb[2], (1 - k) * r.a);
    }
  }

  /** Rounded convex outlines around groups (triangle fans for the hull pipeline) and their labels. */
  private buildGroups(dimOf: (id: string) => number): void {
    this.groups = [];
    const hulls = this.out.hulls;
    // deepest path below each group, so outer groups get more padding than inner ones
    for (const [key, members] of this.groupMembers) {
      const live = members.filter((m) => this.nodes.has(m.id));
      if (!live.length) continue;
      const path = key.split(SEP);
      const depth = path.length;
      const below = Math.max(...live.map((m) => m.group.length)) - depth;
      const pad = 16 + below * 28;
      const pts: Vec2[] = [];
      for (const m of live) {
        const R = m.r + pad;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          pts.push([m.x + Math.cos(a) * R, m.y + Math.sin(a) * R]);
        }
      }
      const hull = convexHull(pts);
      if (hull.length < 3) continue;
      const users = path[0] === 'users';
      const rgb = users ? [0.6, 0.7, 1.0] as Rgb : ownerRgb(path[0], live[0].kind);
      const lin = toLin(rgb);
      const alpha = Math.max(...live.map((m) => m.alpha * dimOf(m.id))) * (depth > 1 ? 0.8 : 1);
      let cx = 0, cy = 0;
      for (const p of hull) {
        cx += p[0];
        cy += p[1];
      }
      cx /= hull.length;
      cy /= hull.length;
      let top = hull[0];
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        if (a[1] < top[1]) top = a;
        // distance from the centre to this edge, for the rim in the fragment shader
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const dist = Math.abs((cx - a[0]) * ey - (cy - a[1]) * ex) / (Math.hypot(ex, ey) || 1);
        hulls.push(cx, cy, dist, 0, lin[0], lin[1], lin[2], alpha);
        hulls.push(a[0], a[1], 0, 0, lin[0], lin[1], lin[2], alpha);
        hulls.push(b[0], b[1], 0, 0, lin[0], lin[1], lin[2], alpha);
      }
      const label = users ? `USERS · ${live.length}` : path[depth - 1];
      this.groups.push({ key, label, depth, x: cx, y: top[1], css: css(rgb, Math.min(1, alpha)), stats: depth === 1 ? this.svcStats.get(path[0]) ?? null : null });
    }
  }
}

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating the first point. */
function convexHull(points: Vec2[]): Vec2[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
