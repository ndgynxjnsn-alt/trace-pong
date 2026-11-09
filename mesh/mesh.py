"""One process of the demo mesh. SERVICE=<name> picks the role from topology.py;
SERVICE=loadgen drives traffic at the gateway.

Instrumentation is the plain OpenTelemetry SDK, done by hand so the span shapes
are exactly what Tempo's service-graph processor pairs up:
  SERVER span per incoming request, CLIENT span per outgoing call,
  CLIENT spans with db.* / peer.service for uninstrumented dependencies (virtual nodes),
  PRODUCER -> CONSUMER spans for the simulated queue.

The load generator plays a browser app instrumented with Grafana Faro ("shop-web"): every
request is a root CLIENT span with Faro's user and session attributes, made by one of a
rotating set of fake OAuth users, and carries the user's JWT to the gateway.
"""
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry import context as otel_context
from opentelemetry import propagate, trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode

from topology import (FRONTEND_VIEWS, INCIDENT_LENGTH, INCIDENT_PERIOD, INCIDENTS,
                      TOPOLOGY, TRAFFIC_MIX)
from users import ActiveUsers, claims, make_users, token

SERVICE = os.environ.get("SERVICE", "gateway")
PORT = int(os.environ.get("PORT", "8080"))
NAMESPACE = os.environ.get("SERVICE_NAMESPACE", "trace-pong-demo")


def log(*args):
    print(f"[{SERVICE}]", *args, file=sys.stderr, flush=True)


def setup_tracing(name=SERVICE, extra=None):
    resource = Resource.create({
        "service.name": name,
        "service.namespace": NAMESPACE,
        "deployment.environment.name": os.environ.get("ENVIRONMENT", "demo"),
        **(extra or {}),
    })
    provider = TracerProvider(resource=resource)
    # Endpoint and headers come from OTEL_EXPORTER_OTLP_* env vars.
    provider.add_span_processor(BatchSpanProcessor(
        OTLPSpanExporter(), schedule_delay_millis=1000, max_export_batch_size=1024))
    trace.set_tracer_provider(provider)
    return trace.get_tracer("trace-pong-mesh")


# --------------------------------------------------------------------------
# Incidents: deterministic from wall clock, so every container agrees
# --------------------------------------------------------------------------
def incident():
    now = time.time()
    if now % INCIDENT_PERIOD > INCIDENT_LENGTH:
        return None
    return INCIDENTS[int(now // INCIDENT_PERIOD) % len(INCIDENTS)]


def latency_factor():
    inc = incident()
    if inc and inc[0] == SERVICE and inc[1] == "latency":
        return inc[2]
    return 1.0


def extra_error_rate():
    inc = incident()
    if inc and inc[0] == SERVICE and inc[1] == "errors":
        return inc[2]
    return 0.0


def nap(ms, factor=1.0):
    """Sleep a lognormal amount around `ms` milliseconds."""
    t = ms * factor * random.lognormvariate(0, 0.45)
    time.sleep(min(t, 15000) / 1000.0)


# --------------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------------
def compile_routes(routes):
    compiled = []
    for key, spec in routes.items():
        method, pattern = key.split(" ", 1)
        regex = "^" + re.sub(r"\{[^/]+\}", "[^/]+", pattern) + "$"
        compiled.append((method, re.compile(regex), pattern, spec))
    return compiled


def fill(path):
    return re.sub(r"\{[^/]+\}", lambda _: str(random.randint(1, 500)), path)


class Mesh:
    def __init__(self, tracer):
        self.tracer = tracer
        self.routes = compile_routes(TOPOLOGY.get(SERVICE, {}))
        self.pool = ThreadPoolExecutor(max_workers=64)
        self.bearer = None   # only the frontend sends tokens

    # ---- outgoing ---------------------------------------------------------
    def http_call(self, service, method, path, kind=SpanKind.CLIENT, attrs=None):
        url = f"http://{service}:{PORT}{fill(path)}"
        name = f"{method} {path}"
        with self.tracer.start_as_current_span(name, kind=kind) as span:
            span.set_attribute("http.request.method", method)
            span.set_attribute("url.full", url)
            span.set_attribute("server.address", service)
            span.set_attribute("server.port", PORT)
            for k, v in (attrs or {}).items():
                span.set_attribute(k, v)
            headers = {}
            propagate.inject(headers)
            if self.bearer:
                headers["Authorization"] = self.bearer
            req = urllib.request.Request(url, method=method, headers=headers,
                                         data=b"{}" if method in ("POST", "PUT") else None)
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    code = resp.status
            except urllib.error.HTTPError as e:
                code = e.code
            except Exception as e:  # connection refused, timeout
                span.record_exception(e)
                code = 503
            span.set_attribute("http.response.status_code", code)
            if code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            return code

    def db_call(self, system, server, database, operation, table, ms):
        """Uninstrumented database: Tempo names the virtual node after db.name (or db.system).
        server.address / db.namespace / db.collection.name give the server > database > table path."""
        name = f"{operation} {database}.{table}" if database else f"{operation} {table}"
        with self.tracer.start_as_current_span(name, kind=SpanKind.CLIENT) as span:
            span.set_attribute("db.system", system)
            span.set_attribute("server.address", server)
            if database:
                span.set_attribute("db.name", database)          # older semconv; Tempo's virtual node
                span.set_attribute("db.namespace", database)
            span.set_attribute("db.operation", operation)
            span.set_attribute("db.operation.name", operation)
            span.set_attribute("db.collection.name", table)
            if system == "postgresql":
                span.set_attribute("db.sql.table", table)
                verb = {"SELECT": "SELECT * FROM", "UPDATE": "UPDATE", "INSERT": "INSERT INTO", "DELETE": "DELETE FROM"}
                span.set_attribute("db.statement", f"{verb.get(operation, operation)} {table} WHERE id = $1")
            nap(ms, latency_factor())
            # occasional db failure
            if random.random() < 0.002:
                span.set_status(Status(StatusCode.ERROR, "connection reset"))
                return 500
            return 200

    def ext_call(self, peer, method, path, ms):
        with self.tracer.start_as_current_span(f"{method} {path}", kind=SpanKind.CLIENT) as span:
            span.set_attribute("peer.service", peer)
            span.set_attribute("http.request.method", method)
            span.set_attribute("url.full", f"https://{peer}{path}")
            span.set_attribute("server.address", peer)
            nap(ms, latency_factor())
            code = 200 if random.random() > 0.01 else 503
            span.set_attribute("http.response.status_code", code)
            if code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            return code

    def publish(self, topic, service, path):
        with self.tracer.start_as_current_span(f"{topic} publish", kind=SpanKind.PRODUCER) as span:
            span.set_attribute("messaging.system", "kafka")
            span.set_attribute("messaging.destination.name", topic)
            span.set_attribute("messaging.operation.type", "publish")
            headers = {"X-Topic": topic}
            propagate.inject(headers)
            nap(2)
        # Deliver asynchronously, like a broker would. Consumer continues the trace.
        def deliver():
            time.sleep(random.uniform(0.01, 0.12))
            try:
                req = urllib.request.Request(f"http://{service}:{PORT}{path}", method="POST",
                                             headers=headers, data=b"{}")
                urllib.request.urlopen(req, timeout=20).close()
            except Exception:
                pass
        self.pool.submit(deliver)
        return 200

    # ---- step execution ---------------------------------------------------
    def run_step(self, step):
        kind = step[0]
        if kind == "call":
            _, svc, method, path, p = step
            return self.http_call(svc, method, path) if random.random() < p else 200
        if kind == "par":
            ctx = otel_context.get_current()

            def run(s):
                token = otel_context.attach(ctx)
                try:
                    return self.run_step(s)
                finally:
                    otel_context.detach(token)
            return max(f.result() for f in [self.pool.submit(run, s) for s in step[1]])
        if kind == "db":
            _, system, server, db, op, table, ms, p = step
            return self.db_call(system, server, db, op, table, ms) if random.random() < p else 200
        if kind == "ext":
            _, peer, method, path, ms, p = step
            return self.ext_call(peer, method, path, ms) if random.random() < p else 200
        if kind == "pub":
            _, topic, svc, path, p = step
            return self.publish(topic, svc, path) if random.random() < p else 200
        if kind == "work":
            nap(step[1], latency_factor())
            return 200
        return 200

    def handle(self, method, path, headers):
        for m, regex, pattern, (steps, err_p, err_code) in self.routes:
            if m == method and regex.match(path):
                break
        else:
            return 404
        ctx = propagate.extract(headers)
        consumer = path.startswith("/consume/")
        name = f"{headers.get('x-topic', 'queue')} process" if consumer else f"{method} {pattern}"
        kind = SpanKind.CONSUMER if consumer else SpanKind.SERVER
        with self.tracer.start_as_current_span(name, context=ctx, kind=kind) as span:
            if consumer:
                span.set_attribute("messaging.system", "kafka")
                span.set_attribute("messaging.destination.name", headers.get("x-topic", "queue"))
                span.set_attribute("messaging.operation.type", "process")
            else:
                span.set_attribute("http.request.method", method)
                span.set_attribute("http.route", pattern)
                span.set_attribute("url.path", path)
                # the gateway is the OAuth resource server: it reads the user from the bearer token
                auth = headers.get("authorization", "")
                if SERVICE == "gateway" and auth.startswith("Bearer "):
                    c = claims(auth[7:])
                    if c:
                        span.set_attribute("user.id", c["sub"])
                        span.set_attribute("enduser.id", c["sub"])
            nap(1.5, latency_factor())
            code = 200
            for step in steps:
                c = self.run_step(step)
                if c >= 500 and random.random() < 0.8:
                    code = 502 if SERVICE == "gateway" else 500
                    break
                if 400 <= c < 500 and step[0] == "call" and step[1] == "auth":
                    code = c
                    break
            if code == 200 and random.random() < err_p + extra_error_rate():
                code = err_code
            if not consumer:
                span.set_attribute("http.response.status_code", code)
            if code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            return code


def serve(mesh):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _do(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
            if self.path == "/health":
                code = 200
            else:
                try:
                    code = mesh.handle(self.command, self.path.split("?")[0],
                                       {k.lower(): v for k, v in self.headers.items()})
                except Exception as e:  # never kill the server
                    log("error", e)
                    code = 500
            body = json.dumps({"service": SERVICE, "status": code}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_DELETE = _do

        def log_message(self, *a):
            pass

    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.request_queue_size = 256
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT} with {len(mesh.routes)} routes")
    srv.serve_forever()


# --------------------------------------------------------------------------
# Load generator
# --------------------------------------------------------------------------
def loadgen():
    """A Faro-instrumented browser app, used by a rotating set of logged-in OAuth users."""
    target = os.environ.get("TARGET", "gateway")
    base = float(os.environ.get("RPS", "12"))
    app = os.environ.get("FRONTEND_NAME", "shop-web")
    tracer = setup_tracing(app, {"telemetry.sdk.language": "webjs", "service.version": "2.4.1"})
    routes, weights = zip(*TRAFFIC_MIX.items())
    users = ActiveUsers(make_users(), size=int(os.environ.get("ACTIVE_USERS", "18")))
    sessions = {}
    pool = ThreadPoolExecutor(max_workers=128)
    stats = {"ok": 0, "err": 0}

    def fire():
        route = random.choices(routes, weights)[0]
        method, path = route.split(" ", 1)
        user = users.pick()
        session = sessions.setdefault(user["sub"], str(uuid.uuid4()))
        view = FRONTEND_VIEWS.get(route, "/")
        url = f"http://{target}:{PORT}{fill(path)}"
        # Faro's fetch instrumentation: a root CLIENT span with user and session meta
        with tracer.start_as_current_span(f"HTTP {method}", kind=SpanKind.CLIENT) as span:
            span.set_attribute("http.request.method", method)
            span.set_attribute("url.full", url)
            span.set_attribute("user.id", user["sub"])
            span.set_attribute("user.email", user["email"])
            span.set_attribute("user.name", user["preferred_username"])
            span.set_attribute("user.full_name", user["name"])
            span.set_attribute("session.id", session)
            span.set_attribute("view.name", view)
            span.set_attribute("page.url", "https://shop.example" + view.replace(":id", str(random.randint(1, 500))))
            headers = {"Authorization": f"Bearer {token(user)}"}
            propagate.inject(headers)
            nap(3)   # the browser's own work before the request goes out
            req = urllib.request.Request(url, method=method, headers=headers,
                                         data=b"{}" if method in ("POST", "PUT") else None)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    code = resp.status
                stats["ok"] += 1
            except urllib.error.HTTPError as e:
                code = e.code
                stats["err"] += 1
            except Exception as e:
                span.record_exception(e)
                code = 0
                stats["err"] += 1
            if code:
                span.set_attribute("http.response.status_code", code)
            if code == 0 or code >= 500:
                span.set_status(Status(StatusCode.ERROR))

    burst_until = 0.0
    last_log = time.time()
    t0 = time.time()
    while True:
        now = time.time()
        # Breathing traffic: slow wave + faster ripple + random flash crowds.
        rate = base * (1 + 0.45 * math.sin((now - t0) * 2 * math.pi / 180)
                       + 0.15 * math.sin((now - t0) * 2 * math.pi / 23))
        if now > burst_until and random.random() < 0.002:
            burst_until = now + random.uniform(5, 15)
            log("flash crowd!")
        if now < burst_until:
            rate *= 2.5
        pool.submit(fire)
        time.sleep(random.expovariate(max(rate, 0.5)))
        if now - last_log > 30:
            log(f"rate={rate:.1f}/s ok={stats['ok']} err={stats['err']} incident={incident()}")
            last_log = now


if __name__ == "__main__":
    if SERVICE == "loadgen":
        time.sleep(5)
        loadgen()
    else:
        serve(Mesh(setup_tracing()))
