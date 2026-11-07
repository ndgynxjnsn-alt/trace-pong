// Live data, fetched through Grafana's data source proxy (so Grafana adds auth and tenant headers):
//  * topology + RED stats from the service-graph series that Tempo's metrics-generator writes to
//    the metrics data source (Mimir/Prometheus): traces_service_graph_*;
//  * hops (one client->server call each) from fresh Tempo traces, paired the way the
//    service-graph processor pairs spans.

// Same precedence as Tempo's service-graph processor for virtual (uninstrumented) servers.
const PEER_ATTRS = ['peer.service', 'db.name', 'db.system'];
const LAG = 4;            // seconds a trace must be finished before we fetch it
const POLL = 1000;        // ms between Tempo searches
const GRAPH_POLL = 3000;  // ms between service-graph queries
const CONCURRENCY = 8;

export class TempoSource {
  // env.get(url, params) -> Promise<json>; env.replace(str) -> str (dashboard variables)
  constructor(scene, env, o) {
    this.scene = scene;
    this.env = env;
    this.o = o;
    this.status = { error: null };
    this.errors = { graph: null, traces: null };
    this.seen = new Map();   // traceID -> first seen, for dedupe
    this.first = true;
    this.stopped = false;
    if (!o.tempoUrl) this.errors.traces = 'no Tempo data source selected';
    if (!o.promUrl) this.errors.graph = 'no metrics data source selected (set one, or the service map data source of the Tempo data source)';
    this.sync();
    if (o.promUrl) this.graphLoop();
    if (o.tempoUrl) this.hopLoop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.gt);
    clearTimeout(this.ht);
  }

  sync() {
    this.status.error = this.errors.graph || this.errors.traces;
  }

  async graphLoop() {
    if (this.stopped) return;
    try {
      this.scene.applyGraph(await this.serviceGraph());
      this.errors.graph = null;
    } catch (e) {
      this.errors.graph = `service graph: ${errText(e)}`;
    }
    this.sync();
    if (!this.stopped) this.gt = setTimeout(() => this.graphLoop(), GRAPH_POLL);
  }

  async hopLoop() {
    if (this.stopped) return;
    const t0 = Date.now();
    try {
      if (!document.hidden) await this.pollTraces();
      this.errors.traces = null;
    } catch (e) {
      this.errors.traces = `traces: ${errText(e)}`;
    }
    this.sync();
    if (!this.stopped) this.ht = setTimeout(() => this.hopLoop(), Math.max(50, POLL - (Date.now() - t0)));
  }

  promql(query) {
    return this.env.get(`${this.o.promUrl}/api/v1/query`, { query }).then((d) => d.data.result);
  }

  async serviceGraph() {
    const w = this.o.window || '1m';
    let sel = this.env.replace(this.o.labelFilter || '').trim().replace(/^\{|\}$/g, '').trim();
    const m = (name) => (sel ? `${name}{${sel}}` : name);
    const [rate, failed, sum] = await Promise.all([
      this.promql(`sum by (client, server, connection_type) (rate(${m('traces_service_graph_request_total')}[${w}]))`),
      this.promql(`sum by (client, server) (rate(${m('traces_service_graph_request_failed_total')}[${w}]))`),
      this.promql(`sum by (client, server) (rate(${m('traces_service_graph_request_server_seconds_sum')}[${w}]))`),
    ]);

    const edges = new Map();
    const key = (mm) => `${mm.client ?? '?'}|${mm.server ?? '?'}`;
    for (const r of rate) {
      const mm = r.metric;
      const k = key(mm);
      if (!edges.has(k)) edges.set(k, { source: mm.client ?? '?', target: mm.server ?? '?', type: mm.connection_type || '', rate: 0, errRate: 0, mean: null });
      edges.get(k).rate += num(r.value[1]) || 0;
    }
    for (const r of failed) {
      const e = edges.get(key(r.metric));
      if (e) e.errRate = num(r.value[1]) || 0;
    }
    for (const r of sum) {
      const e = edges.get(key(r.metric));
      const v = num(r.value[1]);
      if (e && v != null && e.rate > 0) e.mean = (v / e.rate) * 1000;
    }

    const nodes = new Map();
    const node = (id) => {
      if (!nodes.has(id)) nodes.set(id, { id, rate: 0, errRate: 0, outRate: 0, mean: null, kind: 'service', lat: 0 });
      return nodes.get(id);
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
    if (nodes.has('user')) nodes.get('user').kind = 'user';
    for (const n of nodes.values()) {
      if (n.rate > 0) n.mean = n.lat / n.rate;
      delete n.lat;
    }
    // Tempo labels a server with no instrumented caller "user". A service that also has real
    // callers would get a spurious user edge from partial traces; keep only significant ones.
    const called = new Set([...edges.values()].filter((e) => e.source !== 'user').map((e) => e.target));
    for (const [k, e] of edges) {
      if (e.source === 'user' && called.has(e.target) && e.rate < 0.05 * nodes.get(e.target).rate) edges.delete(k);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  async pollTraces() {
    const now = Date.now() / 1000;
    let q = this.env.replace(this.o.traceql || '').trim() || '{ true }';
    if (!/\bwith\s*\(/.test(q)) q += ' with (most_recent=true)';
    // Tempo aligns search ranges to minutes; ask for the last two and dedupe ourselves.
    const res = await this.env.get(`${this.o.tempoUrl}/api/search`, {
      q, limit: 400, spss: 1, start: Math.floor(now - 120), end: Math.floor(now + 60),
    });
    const fresh = [];
    for (const t of res.traces || []) {
      const start = Number(BigInt(t.startTimeUnixNano) / 1000000n) / 1000;
      const end = start + (t.durationMs || 0) / 1000;
      if (this.seen.has(t.traceID) || now - end < LAG) continue;
      fresh.push([start, t.traceID]);
    }
    fresh.sort((a, b) => b[0] - a[0]);
    const ids = fresh.slice(0, this.o.maxTraces || 30).map((f) => f[1]);
    for (const id of ids) this.seen.set(id, now);
    if (this.seen.size > 20000) {
      for (const k of [...this.seen.keys()].slice(0, this.seen.size - 20000)) this.seen.delete(k);
    }

    const hops = [];
    let i = 0;
    const worker = async () => {
      while (i < ids.length && !this.stopped) {
        const id = ids[i++];
        try {
          const d = await this.env.get(`${this.o.tempoUrl}/api/v2/traces/${id}`);
          hops.push(...hopsFromTrace(d.trace || d));
        } catch {
          // a single missing trace is not worth an error banner
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (this.stopped || !hops.length) return;
    hops.sort((a, b) => a.t - b.t);
    this.scene.ingest(hops, Date.now(), this.first);
    this.first = false;
  }
}

function errText(e) {
  return e?.data?.message || e?.data?.error || e?.message || e?.statusText || String(e);
}

function num(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
}

function attrMap(attrs) {
  const out = {};
  for (const a of attrs || []) {
    const v = a.value || {};
    for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
      if (k in v) { out[a.key] = v[k]; break; }
    }
  }
  return out;
}

// Tempo's v2 JSON carries ids base64-encoded; Grafana/Tempo links want hex.
function traceHex(id) {
  if (!id || id.length === 32) return id;
  try {
    return [...atob(id)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return id;
  }
}

const ns = (v) => BigInt(v || 0);

// One OTLP-JSON trace -> client->server hops, the way Tempo's service graph pairs spans.
export function hopsFromTrace(tr) {
  const spans = new Map();
  const children = new Map();
  for (const rs of tr.resourceSpans || tr.batches || []) {
    const svc = attrMap(rs.resource?.attributes)['service.name'] || 'unknown';
    for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
      for (const s of ss.spans || []) {
        s._svc = svc;
        s._attrs = attrMap(s.attributes);
        spans.set(s.spanId, s);
        if (s.parentSpanId) {
          if (!children.has(s.parentSpanId)) children.set(s.parentSpanId, []);
          children.get(s.parentSpanId).push(s);
        }
      }
    }
  }

  const hops = [];
  const emit = (src, dst, s, k) => {
    const a = s._attrs;
    const t0 = ns(s.startTimeUnixNano), t1 = ns(s.endTimeUnixNano);
    let code = parseInt(a['http.response.status_code'] ?? a['http.status_code'] ?? 0, 10) || 0;
    const err = s.status?.code === 'STATUS_CODE_ERROR' || code >= 500;
    hops.push({
      t: Number(t0 / 1000n) / 1000, d: Number((t1 - t0) / 1000n) / 1000,
      f: src, to: dst, n: s.name, c: code, e: err, k, tr: traceHex(s.traceId || ''),
    });
  };

  for (const s of spans.values()) {
    const kind = s.kind || '';
    if (kind === 'SPAN_KIND_SERVER' || kind === 'SPAN_KIND_CONSUMER') {
      if (!s.parentSpanId) { emit('user', s._svc, s, 'http'); continue; }
      const p = spans.get(s.parentSpanId);
      if (!p) continue;   // parent not (yet) in the trace
      if ((p.kind === 'SPAN_KIND_CLIENT' || p.kind === 'SPAN_KIND_PRODUCER') && p._svc !== s._svc) {
        emit(p._svc, s._svc, s, kind === 'SPAN_KIND_CONSUMER' ? 'messaging' : 'http');
      }
    } else if (kind === 'SPAN_KIND_CLIENT') {
      const kids = children.get(s.spanId) || [];
      if (kids.some((k) => k.kind === 'SPAN_KIND_SERVER' || k.kind === 'SPAN_KIND_CONSUMER')) continue;
      const a = s._attrs;
      const peer = PEER_ATTRS.map((k) => a[k]).find(Boolean);
      if (peer) emit(s._svc, String(peer), s, a['db.system'] ? 'db' : 'ext');
    }
  }
  hops.sort((a, b) => a.t - b.t);
  return hops;
}
