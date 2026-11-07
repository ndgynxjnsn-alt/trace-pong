// Simulator: fakes a shop in the browser so the visuals work without a stack.
// A smaller cousin of mesh/topology.py. Live data is in tempo.ts.
import type { Scene } from './scene';
import type { GraphEdge, GraphNode, Hop, HopKind, NodeKind, Source } from './types';

interface CallStep { svc: string; route: string; p: number }
interface DbStep { db: string; op: string; ms: number; p: number }
interface ExtStep { ext: string; op: string; ms: number; p: number }
type Step = CallStep | DbStep | ExtStep;

const C = (svc: string, route: string, p = 1): CallStep => ({ svc, route, p });
const DB = (db: string, op: string, ms: number, p = 1): DbStep => ({ db, op, ms, p });
const EXT = (ext: string, op: string, ms: number, p = 1): ExtStep => ({ ext, op, ms, p });

const SIM: Record<string, Record<string, Step[]>> = {
  gateway: {
    'GET /api/products': [C('auth', 'GET /verify', 0.6), C('catalog', 'GET /products')],
    'GET /api/products/{id}': [C('catalog', 'GET /products/{id}'), C('recommendation', 'GET /recs', 0.8), C('pricing', 'GET /price')],
    'GET /api/search': [C('search', 'GET /search')],
    'POST /api/cart': [C('auth', 'GET /verify'), C('cart', 'POST /cart/items')],
    'POST /api/checkout': [C('auth', 'GET /verify'), C('checkout', 'POST /checkout')],
    'POST /api/login': [C('auth', 'POST /login')],
  },
  auth: { 'GET /verify': [DB('redis', 'GET session', 1)], 'POST /login': [DB('users-db', 'SELECT users', 6), DB('redis', 'SET session', 1)] },
  catalog: { 'GET /products': [DB('redis', 'GET products', 1), DB('catalog-db', 'SELECT products', 12, 0.4)], 'GET /products/{id}': [DB('catalog-db', 'SELECT products', 5), C('inventory', 'GET /stock/{id}', 0.5)] },
  search: { 'GET /search': [DB('elasticsearch', 'search products', 18), C('catalog', 'GET /products/{id}', 0.3)] },
  recommendation: { 'GET /recs': [DB('redis', 'HGETALL features', 2), C('catalog', 'GET /products', 0.7)] },
  cart: { 'POST /cart/items': [DB('redis', 'HSET cart', 1), C('pricing', 'GET /price')], 'GET /cart': [DB('redis', 'HGETALL cart', 1)] },
  pricing: { 'GET /price': [C('currency', 'GET /convert', 0.8), DB('catalog-db', 'SELECT prices', 4, 0.6)] },
  currency: { 'GET /convert': [DB('redis', 'GET fx', 1), EXT('ecb-rates-api', 'GET /rates', 80, 0.08)] },
  checkout: { 'POST /checkout': [C('cart', 'GET /cart'), C('pricing', 'GET /price'), C('shipping', 'POST /quote'), C('inventory', 'POST /reserve'), C('payment', 'POST /charge'), C('notification', 'orders process')] },
  inventory: { 'GET /stock/{id}': [DB('inventory-db', 'SELECT stock', 3)], 'POST /reserve': [DB('inventory-db', 'UPDATE stock', 9)] },
  payment: { 'POST /charge': [C('fraud', 'POST /score'), EXT('stripe-api', 'POST /v1/charges', 120)] },
  fraud: { 'POST /score': [DB('redis', 'GET risk', 1)] },
  shipping: { 'POST /quote': [C('currency', 'GET /convert'), EXT('dhl-api', 'POST /rates', 90)] },
  notification: { 'orders process': [EXT('smtp-relay', 'POST /send', 40)] },
};
const MIX: [string, number][] = [['GET /api/products', 30], ['GET /api/products/{id}', 25], ['GET /api/search', 15], ['POST /api/cart', 12], ['POST /api/login', 6], ['POST /api/checkout', 6]];
const ERR: Record<string, number> = { payment: 0.04, inventory: 0.02, auth: 0.02, catalog: 0.01 };
const DBS = new Set(['redis', 'users-db', 'catalog-db', 'inventory-db', 'elasticsearch']);

interface Incident { svc: string; kind: 'err' | 'slow' }
const INCIDENTS: Incident[] = [{ svc: 'payment', kind: 'err' }, { svc: 'search', kind: 'slow' }, { svc: 'inventory', kind: 'err' }, { svc: 'currency', kind: 'slow' }];

const lognorm = (ms: number) => ms * Math.exp((Math.random() * 2 - 1) * 0.5);
const pick = (mix: [string, number][]) => {
  let r = Math.random() * mix.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of mix) if ((r -= w) <= 0) return k;
  return mix[0][0];
};

/** [wall time, from, to, kind, err, duration] of recent simulated hops, for the fake service graph */
type LogRow = [number, string, string, HopKind, boolean, number];

export class SimSource implements Source {
  status = { error: null as string | null };
  private log: LogRow[] = [];
  private incident: Incident | null = null;
  private readonly t0 = Date.now();
  private readonly timers: ReturnType<typeof setInterval>[];

  constructor(private readonly scene: Scene) {
    this.timers = [setInterval(() => this.tick(), 1000), setInterval(() => this.graph(), 3000)];
    this.tick(true);
    this.graph();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  /** hops for one call into `svc` starting at time t; returns the call's own hop */
  private call(from: string, svc: string, route: string, t: number, tr: string, hops: Hop[]): Hop {
    const steps = SIM[svc]?.[route] || [];
    const slow = this.incident?.svc === svc && this.incident.kind === 'slow' ? 5 : 1;
    let now = t + lognorm(1.5) * slow;
    let err = false;
    const me: Hop = { t, d: 0, f: from, to: svc, n: route, c: 200, e: false, k: 'http', tr };
    hops.push(me);
    for (const s of steps) {
      if (Math.random() > s.p) continue;
      if ('svc' in s) {
        const child = this.call(svc, s.svc, s.route, now + 0.2, tr, hops);
        now = child.t + child.d + 0.2;
        if (child.e && Math.random() < 0.8) { err = true; break; }
      } else {
        const d = lognorm(s.ms) * slow;
        const isDb = 'db' in s;
        hops.push({ t: now, d, f: svc, to: isDb ? s.db : s.ext, n: s.op, c: isDb ? 0 : 200, e: false, k: isDb ? 'db' : 'ext', tr });
        now += d + 0.1;
      }
    }
    const extra = this.incident?.svc === svc && this.incident.kind === 'err' ? 0.35 : 0;
    if (!err && Math.random() < (ERR[svc] || 0.003) + extra) err = true;
    me.d = now - t + lognorm(1);
    me.e = err;
    me.c = err ? (svc === 'gateway' ? 502 : 500) : 200;
    return me;
  }

  private tick(first = false): void {
    const now = Date.now();
    // rotating incidents like the real mesh
    const phase = ((now - this.t0) / 1000) % 90;
    this.incident = phase > 40 && phase < 70 ? INCIDENTS[Math.floor((now - this.t0) / 90000) % INCIDENTS.length] : null;

    const rate = 14 * (1 + 0.5 * Math.sin((((now - this.t0) / 1000) * 2 * Math.PI) / 60));
    const span = first ? 8000 : 1000;
    const n = Math.round((rate * span) / 1000);
    const hops: Hop[] = [];
    for (let i = 0; i < n; i++) {
      const t = now - 6000 - span + Math.random() * span;
      const tr = Math.random().toString(16).slice(2, 10);
      this.call('user', 'gateway', pick(MIX), t, tr, hops);
    }
    for (const h of hops) this.log.push([now, h.f, h.to, h.k, h.e, h.d]);
    this.scene.ingest(hops, now, first);
  }

  private graph(): void {
    const now = Date.now();
    this.log = this.log.filter((l) => now - l[0] < 60000);
    const win = Math.min(60, Math.max(5, (now - this.t0) / 1000));
    const edges = new Map<string, GraphEdge & { sum: number }>();
    for (const [, f, to, k, e, d] of this.log) {
      const key = `${f}|${to}`;
      let x = edges.get(key);
      if (!x) {
        const type = k === 'db' ? 'database' : k === 'ext' || f === 'user' ? 'virtual_node' : '';
        edges.set(key, (x = { source: f, target: to, type, rate: 0, errRate: 0, mean: null, sum: 0 }));
      }
      x.rate += 1 / win;
      x.sum += d;
      if (e) x.errRate += 1 / win;
    }
    const nodes = new Map<string, GraphNode & { lat: number }>();
    const kindOf = (id: string): NodeKind => (id === 'user' ? 'user' : DBS.has(id) ? 'database' : SIM[id] ? 'service' : 'external');
    const node = (id: string) => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, rate: 0, errRate: 0, outRate: 0, mean: null, lat: 0, kind: kindOf(id) }));
      return n;
    };
    for (const e of edges.values()) {
      e.mean = e.sum / (e.rate * win);
      node(e.source).outRate += e.rate;
      const t = node(e.target);
      t.rate += e.rate;
      t.errRate += e.errRate;
      t.lat += e.sum;
    }
    for (const n of nodes.values()) n.mean = n.rate ? n.lat / (n.rate * win) : null;
    this.scene.applyGraph({ nodes: [...nodes.values()], edges: [...edges.values()] });
  }
}
