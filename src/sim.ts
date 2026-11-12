// Simulator: fakes a shop in the browser so the visuals work without a stack.
// A smaller cousin of mesh/: OAuth users on a Faro-instrumented frontend (shop-web), a gateway,
// services with several endpoints each, databases with server > database > table.
// Live data is in tempo.ts.
import type { Scene } from './scene';
import type { GraphEdge, GraphNode, Hop, HopKind, NodeKind, Source, UserInfo } from './types';

interface CallStep { svc: string; route: string; p: number }
interface DbStep { server: string; db: string | null; table: string; op: string; ms: number; p: number }
interface ExtStep { ext: string; op: string; ms: number; p: number }
type Step = CallStep | DbStep | ExtStep;

const C = (svc: string, route: string, p = 1): CallStep => ({ svc, route, p });
const PG = (db: string, table: string, op: string, ms: number, p = 1): DbStep => ({ server: 'postgres', db, table, op, ms, p });
const REDIS = (key: string, op: string, ms: number, p = 1): DbStep => ({ server: 'redis', db: null, table: key, op, ms, p });
const ES = (index: string, op: string, ms: number, p = 1): DbStep => ({ server: 'elasticsearch', db: null, table: index, op, ms, p });
const EXT = (ext: string, op: string, ms: number, p = 1): ExtStep => ({ ext, op, ms, p });

const SIM: Record<string, Record<string, Step[]>> = {
  gateway: {
    'GET /api/products': [C('auth', 'GET /verify', 0.6), C('catalog', 'GET /products')],
    'GET /api/products/{id}': [C('catalog', 'GET /products/{id}'), C('recommendation', 'GET /recs', 0.8), C('pricing', 'GET /price')],
    'GET /api/search': [C('search', 'GET /search')],
    'POST /api/cart': [C('auth', 'GET /verify'), C('cart', 'POST /cart/items')],
    'POST /api/checkout': [C('auth', 'GET /verify'), C('checkout', 'POST /checkout')],
    'POST /api/login': [C('auth', 'POST /login')],
    'GET /api/account': [C('auth', 'GET /verify'), C('account', 'GET /user/info')],
    'GET /api/orders': [C('auth', 'GET /verify'), C('account', 'GET /user/orders')],
    'PUT /api/settings': [C('auth', 'GET /verify'), C('account', 'PUT /user/settings')],
    'GET /api/health': [C('account', 'GET /api/health')],
  },
  account: {
    'GET /user/info': [PG('users_db', 'user_info', 'SELECT', 4), REDIS('avatar', 'GET', 1, 0.5)],
    'GET /user/orders': [PG('orders_db', 'orders', 'SELECT', 14), PG('orders_db', 'order_items', 'SELECT', 9, 0.8)],
    'PUT /user/settings': [PG('users_db', 'user_settings', 'UPDATE', 7)],
    'GET /api/health': [PG('users_db', 'pg_stat_activity', 'SELECT', 1)],
  },
  auth: { 'GET /verify': [REDIS('session', 'GET', 1)], 'POST /login': [PG('users_db', 'user_info', 'SELECT', 6), REDIS('session', 'SET', 1)] },
  catalog: { 'GET /products': [REDIS('products', 'GET', 1), PG('catalog_db', 'products', 'SELECT', 12, 0.4)], 'GET /products/{id}': [PG('catalog_db', 'products', 'SELECT', 5), C('inventory', 'GET /stock/{id}', 0.5)] },
  search: { 'GET /search': [ES('products', 'search', 18), C('catalog', 'GET /products/{id}', 0.3)] },
  recommendation: { 'GET /recs': [REDIS('features', 'HGETALL', 2), C('catalog', 'GET /products', 0.7)] },
  cart: { 'POST /cart/items': [REDIS('cart', 'HSET', 1), C('pricing', 'GET /price')], 'GET /cart': [REDIS('cart', 'HGETALL', 1)] },
  pricing: { 'GET /price': [C('currency', 'GET /convert', 0.8), PG('catalog_db', 'prices', 'SELECT', 4, 0.6)] },
  currency: { 'GET /convert': [REDIS('fx', 'GET', 1), EXT('ecb-rates-api', 'GET /rates', 80, 0.08)] },
  checkout: { 'POST /checkout': [C('cart', 'GET /cart'), C('pricing', 'GET /price'), C('shipping', 'POST /quote'), C('inventory', 'POST /reserve'), C('payment', 'POST /charge'), C('notification', 'orders process')] },
  inventory: { 'GET /stock/{id}': [PG('inventory_db', 'stock', 'SELECT', 3)], 'POST /reserve': [PG('inventory_db', 'stock', 'UPDATE', 9)] },
  payment: { 'POST /charge': [C('fraud', 'POST /score'), EXT('stripe-api', 'POST /v1/charges', 120)] },
  fraud: { 'POST /score': [REDIS('risk', 'GET', 1)] },
  shipping: { 'POST /quote': [C('currency', 'GET /convert'), EXT('dhl-api', 'POST /rates', 90)] },
  notification: { 'orders process': [EXT('smtp-relay', 'POST /send', 40)] },
};
/** gateway route, weight, frontend view it is called from */
const MIX: [string, number, string][] = [
  ['GET /api/products', 30, '/products'], ['GET /api/products/{id}', 25, '/product/:id'], ['GET /api/search', 15, '/search'],
  ['POST /api/cart', 12, '/product/:id'], ['POST /api/login', 5, '/login'], ['POST /api/checkout', 5, '/checkout'],
  ['GET /api/account', 6, '/account'], ['GET /api/orders', 5, '/account/orders'], ['PUT /api/settings', 2, '/account/settings'],
  ['GET /api/health', 2, '/'],
];
const ANON = ['GET /api/products', 'GET /api/products/{id}', 'GET /api/search', 'GET /api/health'];
const ERR: Record<string, number> = { payment: 0.04, inventory: 0.02, auth: 0.02, catalog: 0.01 };
const FRONTEND = 'shop-web';

/** language and HTTP framework per service (the same stacks the demo mesh reports) */
const STACK: Record<string, [string, string]> = {
  'shop-web': ['webjs', 'faro'], gateway: ['go', 'otelhttp'], shipping: ['go', 'otelhttp'],
  auth: ['java', 'spring-webmvc'], account: ['java', 'spring-webmvc'], catalog: ['java', 'spring-webmvc'],
  inventory: ['java', 'spring-webmvc'], checkout: ['java', 'spring-webmvc'], payment: ['java', 'spring-webmvc'],
  notification: ['java', 'spring-webmvc'],
  cart: ['nodejs', 'express'], pricing: ['nodejs', 'express'], currency: ['nodejs', 'express'],
  search: ['python', 'flask'], recommendation: ['python', 'flask'], fraud: ['python', 'flask'],
};
const DB_SYSTEM: Record<string, string> = { postgres: 'postgresql', redis: 'redis', elasticsearch: 'elasticsearch' };
/** an endpoint's type: queue consumers ("<topic> process") run on the Kafka client */
function techOf(svc: string, route: string): string | undefined {
  const st = STACK[svc];
  if (!st) return undefined;
  return `${st[0]} · ${route.endsWith(' process') ? 'kafka-clients' : st[1]}`;
}

interface Incident { svc: string; kind: 'err' | 'slow' }
const INCIDENTS: Incident[] = [{ svc: 'payment', kind: 'err' }, { svc: 'search', kind: 'slow' }, { svc: 'inventory', kind: 'err' }, { svc: 'currency', kind: 'slow' }];

const lognorm = (ms: number) => ms * Math.exp((Math.random() * 2 - 1) * 0.5);
function pickWeighted<T>(items: T[], weight: (t: T) => number): T {
  let r = Math.random() * items.reduce((s, x) => s + weight(x), 0);
  for (const x of items) if ((r -= weight(x)) <= 0) return x;
  return items[0];
}

// ---- fake OAuth users -----------------------------------------------------------------------
const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Frances', 'Alan', 'Radia', 'Edsger', 'Hedy', 'Katherine', 'Guido', 'Sophie', 'Anita'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Allen', 'Turing', 'Perlman', 'Dijkstra', 'Lamarr', 'Johnson', 'Wilson', 'Borg'];

function makeUsers(n: number): (UserInfo & { weight: number })[] {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const hex = (len: number) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('');
  const digits = (len: number) => Array.from({ length: len }, () => Math.floor(rnd() * 10)).join('');
  const users: (UserInfo & { weight: number })[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)], last = LAST[Math.floor(rnd() * LAST.length)];
    const kind = Math.floor(rnd() * 3);
    const id = kind === 0 ? `google-oauth2|1${digits(20)}` : kind === 1 ? `auth0|${hex(24)}` : `github|${digits(8)}`;
    users.push({
      id, name: `${first} ${last}`, username: `${first[0]}${last}${Math.floor(rnd() * 90 + 10)}`.toLowerCase(),
      email: `${first}.${last}@example.com`.toLowerCase(), weight: 1 / (0.05 + rnd()),
    });
  }
  return users;
}

/** [wall time, from, to, kind, err, duration] of recent simulated hops, for the fake service graph */
type LogRow = [number, string, string, HopKind, boolean, number];

export class SimSource implements Source {
  status = { error: null as string | null, waiting: null as string | null };
  private log: LogRow[] = [];
  private incident: Incident | null = null;
  private readonly t0 = Date.now();
  private readonly timers: ReturnType<typeof setInterval>[];
  private readonly users = makeUsers(48);
  private active = this.users.slice(0, 16);
  private lastChurn = Date.now();

  constructor(private readonly scene: Scene) {
    this.timers = [setInterval(() => this.tick(), 1000), setInterval(() => this.graph(), 3000)];
    this.tick(true);
    this.graph();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  private pickUser(now: number): UserInfo {
    // people come and go
    if (now - this.lastChurn > 4000) {
      this.lastChurn = now;
      const idle = this.users.filter((u) => !this.active.includes(u));
      this.active[Math.floor(Math.random() * this.active.length)] = idle[Math.floor(Math.random() * idle.length)];
    }
    const { weight: _w, ...u } = pickWeighted(this.active, (x) => x.weight);
    return u;
  }

  /** hops for one call into `svc` starting at time t; returns the call's own hop */
  private call(from: string, fromEp: string, svc: string, route: string, t: number, tr: string, hops: Hop[]): Hop {
    const steps = SIM[svc]?.[route] || [];
    const slow = this.incident?.svc === svc && this.incident.kind === 'slow' ? 5 : 1;
    let now = t + lognorm(1.5) * slow;
    let err = false;
    const me: Hop = {
      t, d: 0, f: from, to: svc, n: route, c: 200, e: false, k: route.endsWith(' process') ? 'messaging' : 'http', tr,
      fe: fromEp, te: route, tg: [svc], ft: techOf(from, fromEp), tt: techOf(svc, route),
    };
    hops.push(me);
    for (const s of steps) {
      if (Math.random() > s.p) continue;
      if ('svc' in s) {
        const child = this.call(svc, route, s.svc, s.route, now + 0.2, tr, hops);
        now = child.t + child.d + 0.2;
        if (child.e && Math.random() < 0.8) { err = true; break; }
      } else {
        const d = lognorm(s.ms) * slow;
        if ('server' in s) {
          // Tempo names the virtual node after db.name, else db.system
          const to = s.db ?? s.server;
          hops.push({
            t: now, d, f: svc, to, n: `${s.op} ${s.table}`, c: 0, e: false, k: 'db', tr, fe: route, te: s.table,
            tg: s.db ? [s.server, s.db] : [s.server], ft: techOf(svc, route), tt: DB_SYSTEM[s.server] ?? s.server,
          });
        } else {
          hops.push({
            t: now, d, f: svc, to: s.ext, n: s.op, c: 200, e: false, k: 'ext', tr, fe: route, te: s.op, tg: [s.ext],
            ft: techOf(svc, route), tt: 'external',
          });
        }
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
      if (Math.random() < 0.15) {
        // an uninstrumented caller (crawler, monitor, webhook): no traceparent, no user
        this.call('user', '', 'gateway', ANON[Math.floor(Math.random() * ANON.length)], t, tr, hops);
        continue;
      }
      const [route, , view] = pickWeighted(MIX, (m) => m[1]);
      // the user's click in the browser (Faro root span), then the fetch to the gateway
      const ui: Hop = {
        t, d: 0, f: 'user', to: FRONTEND, n: view, c: 200, e: false, k: 'http', tr, te: view, tg: [FRONTEND],
        u: this.pickUser(now), tt: techOf(FRONTEND, view),
      };
      hops.push(ui);
      const api = this.call(FRONTEND, view, 'gateway', route, t + 2 + Math.random() * 3, tr, hops);
      ui.d = api.t + api.d - t + 1;
      ui.e = api.e;
      ui.c = api.c;
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
      if (f === 'user') continue;   // Faro root spans are clients: Tempo has no `user` edge for them
      const key = `${f}|${to}`;
      let x = edges.get(key);
      if (!x) {
        const type = k === 'db' ? 'database' : k === 'ext' ? 'virtual_node' : '';
        edges.set(key, (x = { source: f, target: to, type, rate: 0, errRate: 0, mean: null, sum: 0 }));
      }
      x.rate += 1 / win;
      x.sum += d;
      if (e) x.errRate += 1 / win;
    }
    const nodes = new Map<string, GraphNode & { lat: number }>();
    const kinds = new Map<string, NodeKind>();
    for (const [, , to, k] of this.log) if (k === 'db' || k === 'ext') kinds.set(to, k === 'db' ? 'database' : 'external');
    const node = (id: string) => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, rate: 0, errRate: 0, outRate: 0, mean: null, lat: 0, kind: kinds.get(id) ?? 'service' }));
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
    this.scene.applyGraph({ nodes: [...nodes.values()].map(({ lat: _l, ...n }) => n), edges: [...edges.values()].map(({ sum: _s, ...e }) => e) });
  }
}
