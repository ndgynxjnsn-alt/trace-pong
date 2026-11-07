# trace-pong

Live service traffic from **Grafana Tempo**, drawn with **WebGPU**: the service graph
looks like Tempo's, the motion is as loud as Logstalgia's, and it shows both the topology and the
traffic, as promviz/Vizceral do. Unlike those, every ball is a **real call from a real trace**.

![trace-pong](docs/screenshot.png)

* **Nodes** are services, as in Grafana's service graph: a ring with a green/red health arc, mean
  latency and request rate inside. Databases are blue, third-party APIs are purple and dashed,
  and incoming users are on the far left. Busy nodes heat up and glow.
* **Balls** are hops (one client→server call) taken from fresh Tempo traces. The request flies to the
  callee and bounces off its ring in a spray of sparks. The ball stays inside (orbiting) for the span's
  duration and its own downstream calls, then **bounces back** as the response. Each trace replays as a
  causal rally: a downstream call only leaves once the ball that caused it has arrived.
* **Errors** smash into the node and explode in red sparks, and the status code flies off at the
  caller. The ring's health arc turns red.
* Hover a service for its callers and callees with rate, latency and error rate.

## How it works

```
 Tempo  ── /api/search (TraceQL {true}, most_recent) ──┐
        ── /api/v2/traces/<id> ────────────────────────┤   server/tracepong.py   ── SSE  /api/stream  (hops)
 Mimir  ── traces_service_graph_* (PromQL) ────────────┘   (Python stdlib only)  ── JSON /api/graph   (topology + RED)
                                                                                 ── static web/
 Browser: WebGPU  (HDR scene → compute-shader sparks → dual-filter bloom → ACES composite) + 2D-canvas labels + DOM HUD
```

The browser can't call Tempo or Mimir directly: they send no CORS headers, and every browser would
fetch every trace again. A small backend does it once for everyone:

* **Topology and stats** come from the series that Tempo's metrics-generator (service-graphs
  processor) remote-writes to Mimir: `traces_service_graph_request_total`, `…_failed_total` and
  `…_server_seconds_{sum,count,bucket}`. These are the same numbers Grafana's service graph uses,
  including virtual nodes for uninstrumented databases and APIs (`peer.service`, `db.name`, `db.system`)
  and the `user` node for roots.
* **Traffic** comes from Tempo traces. Each second the server searches for the most recent traces, fetches
  the new ones by ID (up to `MAX_TRACES` per poll), and pairs spans the way the service-graph processor
  does: SERVER/CONSUMER span + parent CLIENT/PRODUCER span in another service, or a CLIENT span with
  no child and a peer attribute. The resulting hops (`from`, `to`, start, duration, status, trace id)
  stream to all browsers over Server-Sent Events.
* The browser replays hops on a clock running a few seconds behind real time. The delay adapts to how
  late hops arrive. The clock top left shows playback time.

### Rendering

Everything is drawn into an `rgba16float` HDR target with premultiplied blending: alpha 0 means
additive light. The passes are:

1. background: a drifting fbm nebula, a world-space dot grid, and heat glows behind busy nodes;
2. edges: tessellated Bézier curves with a soft glow, brighter with more traffic and redder with more errors;
3. balls with comet trails (instanced sprites), then nodes (SDF rings, health arc, load ring, halo);
4. sparks: a 32k-particle ring buffer in a storage buffer, integrated by a compute shader each frame and drawn as velocity-stretched streaks;
5. bloom: 6-level dual-filter (Kawase) down/up chain with soft threshold;
6. composite: ACES tonemap, slight chromatic aberration, vignette, film grain.

Text (labels, status codes, span names) is a 2D canvas on top, and the HUD is plain DOM. There is no build
step and no dependencies: ES modules plus WGSL.

### Prior art this borrows from

* **Logstalgia** (C++/OpenGL/SDL): Pong on web-server logs. Each request is a ball flying from the
  client column towards a paddle by the URL list, with bloom, response codes popping up and
  misses for errors. trace-pong keeps the balls, the glow and the bursts, and maps them onto a service graph.
* **Vizceral / promviz** (three.js/WebGL): a left-to-right layered service graph with particles
  emitted along edges at a rate proportional to RPS, where red particles are errors. The particles are
  synthetic, sampled from rates. trace-pong uses the same layered layout but replays real calls.
* **Grafana's service graph / Node Graph** (Tempo): nodes as rings with a success/error arc and
  `ms/r · r/s` inside, plus a hover table of edges. trace-pong copies that information design.

## Run it

You need Docker and a browser with WebGPU (Chrome/Edge 113+, Safari 26, or Firefox with WebGPU).

```bash
# 1. the LGTM stack (the repo one level up, single node). Grafana is optional.
(cd .. && docker compose up -d alloy tempo mimir loki)

# 2. the demo shop (14 services + load generator) and trace-pong
docker compose up -d --build

open http://localhost:8077          # or http://localhost:8077/?sim for the built-in simulator
```

To develop without Docker, run `TEMPO_URL=http://localhost:3200 MIMIR_URL=http://localhost:9009/prometheus python3 server/tracepong.py`.

| Env | Default | |
|---|---|---|
| `TEMPO_URL` | `http://localhost:3200` | Tempo HTTP API |
| `MIMIR_URL` | `http://localhost:9009/prometheus` | Prometheus API root (Mimir, Prometheus, …) |
| `TENANT` | – | sent as `X-Scope-OrgID` (multi-tenant clusters) |
| `LAG` | `4` | seconds a trace must be finished before it is fetched |
| `MAX_TRACES` | `60` | traces fetched per poll |
| `POLL` | `1` | seconds between polls |
| `TITLE` | `trace-pong` | title shown top left and in the browser tab |

**Tempo setting.** By default, Tempo 3's query-frontend hides the newest 30 s from search
(`query_frontend.query_end_cutoff: 30s`). For near-live playback, the stack's
`tempo-config.yml` sets this to `2s`. With the default, trace-pong still works, but runs about 35 s behind.

Tempo's metrics-generator must have the `service-graphs` processor enabled and remote-write to the
Mimir that trace-pong reads.

### Controls

Drag to pan, wheel to zoom, double-click to re-fit. Click a service to pin focus. <kbd>space</kbd>
pauses, <kbd>+</kbd>/<kbd>-</kbd> change ball speed, <kbd>[</kbd>/<kbd>]</kbd> change latency stretch
(how long balls stay inside a service), and <kbd>B</kbd>/<kbd>L</kbd>/<kbd>F</kbd> toggle bloom and labels or re-fit. <kbd>H</kbd> shows help.
URL options: `?sim`, `?window=5m` (rate window), `?nobloom`.

## The demo shop (`mesh/`)

There is one small Python image, and `SERVICE=<name>` picks the role from `mesh/topology.py`. There are 14 instrumented
services (gateway, auth, catalog, search, recommendation, cart, pricing, currency, checkout, inventory,
payment, fraud, shipping, notification) that call each other over HTTP. They use uninstrumented
dependencies that Tempo turns into virtual nodes: `users-db`, `catalog-db`, `inventory-db`, `redis`,
`elasticsearch`, `stripe-api`, `dhl-api`, `ecb-rates-api` and `smtp-relay`. A simulated Kafka hop
(producer → consumer spans) runs from checkout to notification. Spans are created by hand with the
OpenTelemetry SDK, so their shapes match exactly what the service-graph processor pairs, and they are exported over OTLP to Alloy.

The load generator's traffic varies over time, with occasional flash crowds. Every 4 minutes one service
has a 70 s **incident** (errors or latency), computed from wall-clock time so all containers agree.
The incidents rotate through payment, search, inventory, currency, auth and catalog.
