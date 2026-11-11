# trace-pong

Live service traffic replayed from Tempo traces on a service graph, drawn with WebGPU.

Every ball is one real call between two services from a recent trace. The request flies to the callee,
and the response returns once the span and its own calls are done. Errors explode in red. Nodes look
like Grafana's service graph: a health ring with mean latency and request rate inside.

Logged-in users (`user.id` / `enduser.id` on the root span, as set by Faro or an OAuth backend) get a node
each. The help screen (`H`) switches to one node per endpoint grouped by service (databases by server ›
database › table), user names instead of ids, and a radial or left-to-right layout.

## Requirements

* A browser with WebGPU (Chrome/Edge, Safari 26, Firefox with WebGPU enabled).
* A Tempo data source, with Tempo's metrics-generator `service-graphs` processor writing
  `traces_service_graph_*` series to a Prometheus/Mimir data source.

## Options

* **Tempo data source** and **Service graph metrics data source**. Empty means the first Tempo data source
  and its *service map* data source. All requests go through Grafana's data source proxy, so tenant
  headers and auth come from the data source settings.
* **TraceQL filter** picks the traces to replay. **Service graph label filter** (PromQL matchers) picks
  the topology. Both accept dashboard variables.
* **Traces per second**: the upper bound fetched from Tempo per viewer.
* **Trace sampling**: fetch only a share of the traces (50% down to 1%), picked by trace id, so all viewers
  see the same ones. Rates still come from the service graph.
* **Rename nodes**: one `name = new name` per line, e.g. `10.10.10.10 = prod-postgres`. Works for services,
  databases and database servers; nodes renamed to the same name merge.
* **Simulator** mode needs no data sources.

Drag to pan, ctrl+wheel to zoom, click to focus a service, and press `H` in the panel for keys and `D` for debug information (GPU adapter, frame timings).
