#!/usr/bin/env python3
"""trace-pong backend: a tiny, dependency-free bridge between the browser and the LGTM stack.

Why it exists: Tempo and Mimir don't send CORS headers, Tempo's search works in
minute-sized windows, and every browser would otherwise have to fetch every
trace itself. This server polls once and fans out to all browsers.

  GET /                 the web app (../web)
  GET /api/graph        service graph from Mimir (Tempo metrics-generator series)
  GET /api/stream       Server-Sent Events: individual hops (client -> server calls)
                        extracted from fresh Tempo traces, with their real timestamps
  GET /api/info         config, for the HUD

Env: TEMPO_URL, MIMIR_URL (Prometheus API root), TENANT (X-Scope-OrgID, optional),
     PORT (8077), LAG (seconds a trace must be old before fetching, default 4),
     MAX_TRACES (per poll, default 60), POLL (seconds, default 1).
"""
import base64
import json
import os
import queue
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

TEMPO = os.environ.get("TEMPO_URL", "http://localhost:3200").rstrip("/")
MIMIR = os.environ.get("MIMIR_URL", "http://localhost:9009/prometheus").rstrip("/")
TENANT = os.environ.get("TENANT", "")
PORT = int(os.environ.get("PORT", "8077"))
LAG = float(os.environ.get("LAG", "4"))
MAX_TRACES = int(os.environ.get("MAX_TRACES", "60"))
POLL = float(os.environ.get("POLL", "1"))
WEB_DIR = os.environ.get("WEB_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))

# Same precedence as Tempo's service-graph processor for virtual (uninstrumented) servers.
PEER_ATTRS = ("peer.service", "db.name", "db.system")


def log(*a):
    print("[trace-pong]", *a, flush=True)


def http_json(url, data=None, timeout=10):
    headers = {"Accept": "application/json"}
    if TENANT:
        headers["X-Scope-OrgID"] = TENANT
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# --------------------------------------------------------------------------
# Service graph (Mimir)
# --------------------------------------------------------------------------
def promql(q):
    d = http_json(f"{MIMIR}/api/v1/query", {"query": q})
    return d["data"]["result"]


def fnum(v):
    try:
        x = float(v)
        return x if x == x and x not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def service_graph(window="1m"):
    w = window
    queries = {
        "rate": f"sum by (client, server, connection_type) (rate(traces_service_graph_request_total[{w}]))",
        "failed": f"sum by (client, server) (rate(traces_service_graph_request_failed_total[{w}]))",
        "p90": f"histogram_quantile(0.9, sum by (client, server, le) (rate(traces_service_graph_request_server_seconds_bucket[{w}])))",
        "sum": f"sum by (client, server) (rate(traces_service_graph_request_server_seconds_sum[{w}]))",
    }
    with ThreadPoolExecutor(len(queries)) as ex:
        res = dict(zip(queries, ex.map(promql, queries.values())))

    edges = {}
    for r in res["rate"]:
        m = r["metric"]
        key = (m.get("client", "?"), m.get("server", "?"))
        e = edges.setdefault(key, {"source": key[0], "target": key[1], "type": m.get("connection_type", ""),
                                   "rate": 0.0, "errRate": 0.0, "p90": None, "mean": None})
        e["rate"] += fnum(r["value"][1]) or 0.0
    for name in ("failed", "p90", "sum"):
        for r in res[name]:
            m = r["metric"]
            e = edges.get((m.get("client", "?"), m.get("server", "?")))
            if not e:
                continue
            v = fnum(r["value"][1])
            if name == "failed":
                e["errRate"] = v or 0.0
            elif name == "p90":
                e["p90"] = v * 1000 if v is not None else None
            elif v is not None and e["rate"] > 0:
                e["mean"] = v / e["rate"] * 1000

    nodes = {}

    def node(n):
        return nodes.setdefault(n, {"id": n, "rate": 0.0, "errRate": 0.0, "outRate": 0.0,
                                    "mean": None, "p90": None, "kind": "service", "_lat": 0.0})

    for e in edges.values():
        s, t = node(e["source"]), node(e["target"])
        s["outRate"] += e["rate"]
        t["rate"] += e["rate"]
        t["errRate"] += e["errRate"]
        if e["mean"] is not None:
            t["_lat"] += e["mean"] * e["rate"]
        if e["p90"] is not None:
            t["p90"] = max(t["p90"] or 0, e["p90"])
        if e["type"] == "database":
            t["kind"] = "database"
        elif e["type"] == "messaging_system":
            pass
        elif e["type"] == "virtual_node" and e["source"] != "user":
            t["kind"] = "external"
    if "user" in nodes:
        nodes["user"]["kind"] = "user"
    for n in nodes.values():
        lat = n.pop("_lat")
        if n["rate"] > 0:
            n["mean"] = lat / n["rate"]
    # Tempo labels a server with no instrumented caller "user". A service that also
    # has real callers would otherwise get a spurious user edge when a trace was
    # partial; keep user edges only into services nobody else calls.
    called = {e["target"] for e in edges.values() if e["source"] != "user"}
    edges = {k: e for k, e in edges.items() if not (e["source"] == "user" and e["target"] in called
                                                    and e["rate"] < 0.05 * nodes[e["target"]]["rate"])}
    return {"ts": time.time(), "window": w, "nodes": list(nodes.values()), "edges": list(edges.values())}


# --------------------------------------------------------------------------
# Hops (Tempo traces)
# --------------------------------------------------------------------------
def attr_map(attrs):
    out = {}
    for a in attrs or []:
        v = a.get("value", {})
        for k in ("stringValue", "intValue", "doubleValue", "boolValue"):
            if k in v:
                out[a["key"]] = v[k]
                break
    return out


def trace_hex(tid):
    """Tempo's v2 JSON carries ids base64-encoded; Grafana/Tempo links want hex."""
    if not tid or len(tid) == 32:
        return tid
    try:
        return base64.b64decode(tid).hex()
    except Exception:
        return tid


def hops_from_trace(tr):
    """Turn one OTLP-JSON trace into client->server hops, the way Tempo's service graph pairs spans."""
    spans = {}
    children = {}
    for rs in tr.get("resourceSpans", []):
        svc = attr_map(rs.get("resource", {}).get("attributes")).get("service.name", "unknown")
        for ss in rs.get("scopeSpans", []):
            for s in ss.get("spans", []):
                s["_svc"] = svc
                s["_attrs"] = attr_map(s.get("attributes"))
                spans[s["spanId"]] = s
                if s.get("parentSpanId"):
                    children.setdefault(s["parentSpanId"], []).append(s)

    hops = []

    def emit(src, dst, s, kind):
        a = s["_attrs"]
        start = int(s["startTimeUnixNano"]) / 1e6
        dur = (int(s["endTimeUnixNano"]) - int(s["startTimeUnixNano"])) / 1e6
        code = a.get("http.response.status_code")
        try:
            code = int(code) if code is not None else 0
        except ValueError:
            code = 0
        err = (s.get("status", {}).get("code") == "STATUS_CODE_ERROR") or code >= 500
        hops.append({"t": round(start, 3), "d": round(dur, 3), "f": src, "to": dst, "n": s["name"],
                     "c": code, "e": err, "k": kind, "tr": trace_hex(s.get("traceId", ""))})

    for s in spans.values():
        kind = s.get("kind", "")
        if kind in ("SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER"):
            pid = s.get("parentSpanId")
            if not pid:
                emit("user", s["_svc"], s, "http")
                continue
            p = spans.get(pid)
            if p is None:
                continue  # parent not (yet) in the trace
            if p.get("kind") in ("SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER") and p["_svc"] != s["_svc"]:
                emit(p["_svc"], s["_svc"], s, "messaging" if kind == "SPAN_KIND_CONSUMER" else "http")
        elif kind in ("SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER"):
            kids = children.get(s["spanId"], [])
            if any(k.get("kind") in ("SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER") for k in kids):
                continue
            if kind == "SPAN_KIND_PRODUCER":
                continue  # consumer not seen (yet)
            a = s["_attrs"]
            peer = next((a[k] for k in PEER_ATTRS if a.get(k)), None)
            if peer:
                emit(s["_svc"], str(peer), s, "db" if a.get("db.system") else "ext")
    hops.sort(key=lambda h: h["t"])
    return hops


class HopPoller(threading.Thread):
    """Polls Tempo search for fresh traces, fetches them, broadcasts hops to subscribers."""

    def __init__(self):
        super().__init__(daemon=True)
        self.subs = set()
        self.lock = threading.Lock()
        self.seen = OrderedDict()           # traceID -> first seen, for dedupe
        self.backlog = deque(maxlen=4000)   # recent hops for newly connected browsers
        self.pool = ThreadPoolExecutor(16)
        self.stats = {"traces": 0, "hops": 0, "errors": 0, "lastPoll": 0, "found": 0, "newest": 0}

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.subs.add(q)
            backlog = list(self.backlog)
        return q, backlog

    def unsubscribe(self, q):
        with self.lock:
            self.subs.discard(q)

    def broadcast(self, msg):
        with self.lock:
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass  # slow client; it'll catch up with the next batch

    def search(self, now):
        # Tempo aligns search ranges to minutes; ask for the last two and dedupe ourselves.
        params = urllib.parse.urlencode({
            "q": "{ true } with (most_recent=true)", "limit": 400, "spss": 1,
            "start": int(now - 120), "end": int(now + 60)})
        return http_json(f"{TEMPO}/api/search?{params}").get("traces", [])

    def fetch(self, tid):
        try:
            d = http_json(f"{TEMPO}/api/v2/traces/{tid}")
            return hops_from_trace(d.get("trace", d))
        except Exception as e:
            self.stats["errors"] += 1
            return []

    def poll_once(self):
        now = time.time()
        traces = self.search(now)
        self.stats["found"] = len(traces)
        fresh = []
        newest = 0
        for t in traces:
            start = int(t["startTimeUnixNano"]) / 1e9
            newest = max(newest, start)
            # Wait until the trace (probably) finished arriving, then fetch it once.
            end = start + t.get("durationMs", 0) / 1000
            if t["traceID"] in self.seen or now - end < LAG:
                continue
            fresh.append((start, t["traceID"]))
        self.stats["newest"] = newest
        fresh.sort(reverse=True)
        fresh = fresh[:MAX_TRACES]
        for _, tid in fresh:
            self.seen[tid] = now
        while len(self.seen) > 20000:
            self.seen.popitem(last=False)
        hops = [h for hs in self.pool.map(self.fetch, [tid for _, tid in fresh]) for h in hs]
        hops.sort(key=lambda h: h["t"])
        self.stats["traces"] += len(fresh)
        self.stats["hops"] += len(hops)
        self.stats["lastPoll"] = now
        if hops:
            with self.lock:
                self.backlog.extend(hops)
            self.broadcast({"now": now * 1000, "hops": hops, "sampled": len(fresh), "found": len(traces)})

    def run(self):
        while True:
            t0 = time.time()
            try:
                self.poll_once()
            except Exception as e:
                self.stats["errors"] += 1
                log("poll failed:", e)
                time.sleep(2)
            time.sleep(max(0.05, POLL - (time.time() - t0)))


POLLER = HopPoller()

# graph cache: many browsers, one Mimir query per 2s
_graph_cache = {"t": 0, "w": None, "v": None}
_graph_lock = threading.Lock()


def cached_graph(window):
    with _graph_lock:
        if _graph_cache["v"] is not None and _graph_cache["w"] == window and time.time() - _graph_cache["t"] < 2:
            return _graph_cache["v"]
        v = service_graph(window)
        _graph_cache.update(t=time.time(), w=window, v=v)
        return v


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(url.query)
        if url.path == "/api/graph":
            window = qs.get("window", ["1m"])[0]
            if window not in ("30s", "1m", "2m", "5m", "15m"):
                window = "1m"
            try:
                self.send_json(cached_graph(window))
            except Exception as e:
                self.send_json({"error": str(e)}, 502)
        elif url.path == "/api/stream":
            self.stream()
        elif url.path == "/api/info":
            self.send_json({"tempo": TEMPO, "mimir": MIMIR, "tenant": TENANT, "lag": LAG,
                            "maxTraces": MAX_TRACES, "stats": POLLER.stats})
        else:
            super().do_GET()

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q, backlog = POLLER.subscribe()
        try:
            if backlog:
                self.wfile.write(f"data: {json.dumps({'now': time.time() * 1000, 'hops': backlog, 'backlog': True})}\n\n".encode())
                self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {json.dumps(msg)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            POLLER.unsubscribe(q)


def main():
    ThreadingHTTPServer.daemon_threads = True
    POLLER.start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"http://localhost:{PORT}  tempo={TEMPO} mimir={MIMIR} tenant={TENANT or '-'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
