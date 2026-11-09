// Live data, fetched through Grafana's data source proxy (so Grafana adds auth and tenant headers):
//  * topology + RED stats from the service-graph series that Tempo's metrics-generator writes to
//    the metrics data source (Mimir/Prometheus): traces_service_graph_*;
//  * hops (one client->server call each) from fresh Tempo traces, paired the way the
//    service-graph processor pairs spans.
import type { Scene } from './scene';
import type { Env, Graph, GraphEdge, GraphNode, Hop, HopKind, Source, UserInfo, ViewOptions } from './types';

/** Same precedence as Tempo's service-graph processor for virtual (uninstrumented) servers. */
const PEER_ATTRS = ['peer.service', 'db.name', 'db.system'];
/** seconds a trace must be finished before we fetch it */
const LAG = 4;
/** ms between Tempo searches */
const POLL = 1000;
/** ms between service-graph queries */
const GRAPH_POLL = 3000;
const CONCURRENCY = 8;

// ---- API shapes (only the fields we read) ---------------------------------------------
interface PromVector {
  data: { result: { metric: Record<string, string>; value: [number, string] }[] };
}

interface TempoSearch {
  traces?: { traceID: string; startTimeUnixNano: string; durationMs?: number }[];
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpAttr { key: string; value?: OtlpAnyValue }
interface OtlpSpan {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttr[];
  status?: { code?: string };
}
interface OtlpTrace {
  resourceSpans?: OtlpResourceSpans[];
  /** older Tempo versions */
  batches?: OtlpResourceSpans[];
}
interface OtlpResourceSpans {
  resource?: { attributes?: OtlpAttr[] };
  scopeSpans?: { spans?: OtlpSpan[] }[];
  instrumentationLibrarySpans?: { spans?: OtlpSpan[] }[];
}

export class TempoSource implements Source {
  status = { error: null as string | null, waiting: 'connecting to Tempo…' as string | null };
  private graphSeen = false;
  private tracesSeen = false;
  private polls = 0;
  private readonly errors: { graph: string | null; traces: string | null } = { graph: null, traces: null };
  /** traceID -> first seen, for dedupe */
  private readonly seen = new Map<string, number>();
  private first = true;
  private stopped = false;
  private gt?: ReturnType<typeof setTimeout>;
  private ht?: ReturnType<typeof setTimeout>;

  constructor(private readonly scene: Scene, private readonly env: Env, private readonly o: ViewOptions) {
    if (!o.tempoUrl) this.errors.traces = 'no Tempo data source selected';
    if (!o.promUrl) this.errors.graph = 'no metrics data source selected (set one, or the service map data source of the Tempo data source)';
    this.sync();
    if (o.promUrl) void this.graphLoop();
    if (o.tempoUrl) void this.hopLoop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.gt);
    clearTimeout(this.ht);
  }

  private sync(): void {
    this.status.error = this.errors.graph || this.errors.traces;
    // what the loading screen says while nothing has arrived yet
    if (this.tracesSeen || this.graphSeen) this.status.waiting = null;
    else if (this.status.error) this.status.waiting = 'cannot reach the data sources';
    else if (this.polls > 5) this.status.waiting = `no traces match ${this.o.traceql || '{ true }'} in the last 2 minutes`;
    else this.status.waiting = 'waiting for traces…';
  }

  private async graphLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const g = await this.serviceGraph();
      if (g.nodes.length) this.graphSeen = true;
      this.scene.applyGraph(g);
      this.errors.graph = null;
    } catch (e) {
      this.errors.graph = `service graph: ${errText(e)}`;
    }
    this.sync();
    if (!this.stopped) this.gt = setTimeout(() => void this.graphLoop(), GRAPH_POLL);
  }

  private async hopLoop(): Promise<void> {
    if (this.stopped) return;
    const t0 = Date.now();
    try {
      if (!document.hidden) await this.pollTraces();
      this.polls++;
      this.errors.traces = null;
    } catch (e) {
      this.errors.traces = `traces: ${errText(e)}`;
    }
    this.sync();
    if (!this.stopped) this.ht = setTimeout(() => void this.hopLoop(), Math.max(50, POLL - (Date.now() - t0)));
  }

  private async promql(query: string) {
    const d = await this.env.get<PromVector>(`${this.o.promUrl}/api/v1/query`, { query });
    return d.data.result;
  }

  private async serviceGraph(): Promise<Graph> {
    const w = this.o.window || '1m';
    const sel = this.env.replace(this.o.labelFilter || '').trim().replace(/^\{|\}$/g, '').trim();
    const m = (name: string) => (sel ? `${name}{${sel}}` : name);
    const [rate, failed, sum] = await Promise.all([
      this.promql(`sum by (client, server, connection_type) (rate(${m('traces_service_graph_request_total')}[${w}]))`),
      this.promql(`sum by (client, server) (rate(${m('traces_service_graph_request_failed_total')}[${w}]))`),
      this.promql(`sum by (client, server) (rate(${m('traces_service_graph_request_server_seconds_sum')}[${w}]))`),
    ]);

    const edges = new Map<string, GraphEdge>();
    const key = (mm: Record<string, string>) => `${mm.client ?? '?'}|${mm.server ?? '?'}`;
    for (const r of rate) {
      const mm = r.metric;
      const k = key(mm);
      let e = edges.get(k);
      if (!e) {
        e = { source: mm.client ?? '?', target: mm.server ?? '?', type: mm.connection_type || '', rate: 0, errRate: 0, mean: null };
        edges.set(k, e);
      }
      e.rate += num(r.value[1]) ?? 0;
    }
    for (const r of failed) {
      const e = edges.get(key(r.metric));
      if (e) e.errRate = num(r.value[1]) ?? 0;
    }
    for (const r of sum) {
      const e = edges.get(key(r.metric));
      const v = num(r.value[1]);
      if (e && v != null && e.rate > 0) e.mean = (v / e.rate) * 1000;
    }

    // Tempo keeps series of edges that went quiet until they go stale; they report rate 0
    for (const [k, e] of edges) if (e.rate <= 1e-6) edges.delete(k);

    const nodes = new Map<string, GraphNode & { lat: number }>();
    const node = (id: string) => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, rate: 0, errRate: 0, outRate: 0, mean: null, kind: 'service', lat: 0 }));
      return n;
    };
    for (const e of edges.values()) {
      const s = node(e.source), t = node(e.target);
      s.outRate += e.rate;
      t.rate += e.rate;
      t.errRate += e.errRate;
      if (e.mean != null) t.lat += e.mean * e.rate;
      if (e.type === 'database') t.kind = 'database';
      else if (e.type === 'virtual_node' && e.source !== 'user') t.kind = 'external';
    }
    const user = nodes.get('user');
    if (user) user.kind = 'user';
    for (const n of nodes.values()) if (n.rate > 0) n.mean = n.lat / n.rate;
    // Tempo labels a server with no instrumented caller "user". A service that also has real
    // callers would get a spurious user edge from partial traces; keep only significant ones.
    const called = new Set([...edges.values()].filter((e) => e.source !== 'user').map((e) => e.target));
    for (const [k, e] of edges) {
      if (e.source === 'user' && called.has(e.target) && e.rate < 0.05 * (nodes.get(e.target)?.rate ?? 0)) edges.delete(k);
    }
    return { nodes: [...nodes.values()].map(({ lat: _lat, ...n }) => n), edges: [...edges.values()] };
  }

  private async pollTraces(): Promise<void> {
    const now = Date.now() / 1000;
    let q = this.env.replace(this.o.traceql || '').trim() || '{ true }';
    if (!/\bwith\s*\(/.test(q)) q += ' with (most_recent=true)';
    // Tempo aligns search ranges to minutes; ask for the last two and dedupe ourselves.
    const res = await this.env.get<TempoSearch>(`${this.o.tempoUrl}/api/search`, {
      q, limit: 400, spss: 1, start: Math.floor(now - 120), end: Math.floor(now + 60),
    });
    const fresh: [number, string][] = [];
    for (const t of res.traces ?? []) {
      const start = Number(BigInt(t.startTimeUnixNano) / 1000000n) / 1000;
      const end = start + (t.durationMs ?? 0) / 1000;
      if (this.seen.has(t.traceID) || now - end < LAG) continue;
      fresh.push([start, t.traceID]);
    }
    fresh.sort((a, b) => b[0] - a[0]);
    const ids = fresh.slice(0, this.o.maxTraces || 30).map((f) => f[1]);
    for (const id of ids) this.seen.set(id, now);
    if (this.seen.size > 20000) {
      for (const k of [...this.seen.keys()].slice(0, this.seen.size - 20000)) this.seen.delete(k);
    }

    const hops: Hop[] = [];
    let i = 0;
    const worker = async () => {
      while (i < ids.length && !this.stopped) {
        const id = ids[i++];
        try {
          const d = await this.env.get<{ trace?: OtlpTrace } & OtlpTrace>(`${this.o.tempoUrl}/api/v2/traces/${id}`);
          hops.push(...hopsFromTrace(d.trace ?? d));
        } catch {
          // a single missing trace is not worth an error message
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (this.stopped || !hops.length) return;
    this.tracesSeen = true;
    hops.sort((a, b) => a.t - b.t);
    this.scene.ingest(hops, Date.now(), this.first);
    this.first = false;
  }
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const x = e as { data?: { message?: string; error?: string }; message?: string; statusText?: string };
    return x.data?.message || x.data?.error || x.message || x.statusText || String(e);
  }
  return String(e);
}

function num(v: string | undefined): number | null {
  const x = parseFloat(v ?? '');
  return Number.isFinite(x) ? x : null;
}

type AttrValue = string | number | boolean;

function attrMap(attrs: OtlpAttr[] | undefined): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    const x = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
    if (x !== undefined) out[a.key] = x;
  }
  return out;
}

/** Tempo's v2 JSON carries ids base64-encoded; Grafana/Tempo links want hex. */
function traceHex(id: string): string {
  if (!id || id.length === 32) return id;
  try {
    return [...atob(id)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return id;
  }
}

interface Span extends OtlpSpan {
  svc: string;
  attrs: Record<string, AttrValue>;
}

const ns = (v: string | undefined) => BigInt(v || 0);
const isServer = (k?: string) => k === 'SPAN_KIND_SERVER' || k === 'SPAN_KIND_CONSUMER';
const isClient = (k?: string) => k === 'SPAN_KIND_CLIENT' || k === 'SPAN_KIND_PRODUCER';
const str = (v: AttrValue | undefined) => (v === undefined || v === '' ? undefined : String(v));

/** The end user from OAuth claims on a span: Faro's user.* meta, or enduser.* from a backend. */
function userOf(a: Record<string, AttrValue>): UserInfo | undefined {
  const id = str(a['user.id']) ?? str(a['enduser.id']);
  if (!id) return undefined;
  return {
    id,
    name: str(a['user.full_name']) ?? str(a['enduser.name']),
    username: str(a['user.name']) ?? str(a['user.username']),
    email: str(a['user.email']) ?? str(a['enduser.email']),
  };
}

/** Table/collection from a SQL statement, when no db.collection.name is set. */
function tableFromQuery(q: string | undefined): string | undefined {
  const m = q?.match(/\b(?:from|into|update|join)\s+[`"[]?([\w.$-]+)/i);
  return m ? m[1].split('.').pop() : undefined;
}

/** One OTLP-JSON trace -> client->server hops, the way Tempo's service graph pairs spans. */
export function hopsFromTrace(tr: OtlpTrace): Hop[] {
  const spans = new Map<string, Span>();
  const children = new Map<string, Span[]>();
  for (const rs of tr.resourceSpans ?? tr.batches ?? []) {
    const svc = String(attrMap(rs.resource?.attributes)['service.name'] ?? 'unknown');
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const s: Span = { ...raw, svc, attrs: attrMap(raw.attributes) };
        spans.set(s.spanId, s);
        if (s.parentSpanId) {
          let list = children.get(s.parentSpanId);
          if (!list) children.set(s.parentSpanId, (list = []));
          list.push(s);
        }
      }
    }
  }

  // The endpoint a span belongs to: the nearest server span of the same service above it, or for
  // a frontend (no server span), the root's view name.
  const endpointOf = (span: Span): string => {
    let cur: Span | undefined = span;
    let top = span;
    for (let depth = 0; cur && cur.svc === span.svc && depth < 200; depth++) {
      if (isServer(cur.kind)) return cur.name;
      top = cur;
      cur = cur.parentSpanId ? spans.get(cur.parentSpanId) : undefined;
    }
    return str(top.attrs['view.name']) ?? top.name;
  };

  const hops: Hop[] = [];
  const emit = (src: string, dst: string, s: Span, k: HopKind, extra: Partial<Hop>) => {
    const a = s.attrs;
    const t0 = ns(s.startTimeUnixNano), t1 = ns(s.endTimeUnixNano);
    const code = parseInt(String(a['http.response.status_code'] ?? a['http.status_code'] ?? 0), 10) || 0;
    const err = s.status?.code === 'STATUS_CODE_ERROR' || code >= 500;
    hops.push({
      t: Number(t0 / 1000n) / 1000,
      d: Number((t1 - t0) / 1000n) / 1000,
      f: src, to: dst, n: s.name, c: code, e: err, k, tr: traceHex(s.traceId ?? ''),
      ...extra,
    });
  };

  for (const s of spans.values()) {
    if (!s.parentSpanId) {
      // the user who started the trace: a root server span (backend OAuth), or a frontend's
      // root span with Faro's user meta
      const u = userOf(s.attrs);
      if (isServer(s.kind)) {
        emit('user', s.svc, s, 'http', { te: s.name, tg: [s.svc], u });
        continue;
      }
      if (u) {
        const view = str(s.attrs['view.name']) ?? s.name;
        emit('user', s.svc, s, 'http', { te: view, tg: [s.svc], u, n: view });
      }
    }
    if (isServer(s.kind)) {
      const p = s.parentSpanId ? spans.get(s.parentSpanId) : undefined;
      if (!p) continue;   // parent not (yet) in the trace
      if (isClient(p.kind) && p.svc !== s.svc) {
        emit(p.svc, s.svc, s, s.kind === 'SPAN_KIND_CONSUMER' ? 'messaging' : 'http', { fe: endpointOf(p), te: s.name, tg: [s.svc] });
      }
    } else if (s.kind === 'SPAN_KIND_CLIENT') {
      if ((children.get(s.spanId) ?? []).some((k) => isServer(k.kind))) continue;
      const a = s.attrs;
      const peer = PEER_ATTRS.map((k) => a[k]).find(Boolean);
      if (!peer) continue;
      const fe = endpointOf(s);
      if (a['db.system']) {
        // server > database > table, as far as the attributes tell
        const server = str(a['server.address']) ?? str(a['net.peer.name']) ?? str(a['db.system']) ?? String(peer);
        const db = str(a['db.namespace']) ?? str(a['db.name']);
        const table = str(a['db.collection.name']) ?? str(a['db.sql.table']) ?? str(a['db.mongodb.collection'])
          ?? tableFromQuery(str(a['db.query.text']) ?? str(a['db.statement']));
        const tg = db && db !== server ? [server, db] : [server];
        emit(s.svc, String(peer), s, 'db', { fe, te: table ?? str(a['db.operation.name']) ?? str(a['db.operation']) ?? s.name, tg });
      } else {
        emit(s.svc, String(peer), s, 'ext', { fe, te: s.name, tg: [String(peer)] });
      }
    }
  }
  hops.sort((a, b) => a.t - b.t);
  return hops;
}
