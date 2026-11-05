"""The demo shop's call graph.

Every real service runs the same image (mesh.py) with SERVICE=<name>. A route is
a list of steps executed in order; a step is one of

    ("call",  service, method, path, probability)       HTTP call to another service
    ("par",   [call, call, ...])                        HTTP calls in parallel
    ("db",    system, db_name, operation, table, ms, p)  database call (uninstrumented -> virtual node)
    ("ext",   peer_service, method, path, ms, p)        third-party API (uninstrumented -> virtual node)
    ("pub",   topic, service, path, p)                  publish to a queue; the consumer is `service`
    ("work",  ms)                                       local CPU / wait time (lognormal around ms)

Each route also has an error probability and a status code for it.
"""

# route -> (steps, error probability, error status)
TOPOLOGY = {
    "gateway": {
        "GET /api/products": ([
            ("call", "auth", "GET", "/verify", 0.6),
            ("call", "catalog", "GET", "/products", 1.0),
        ], 0.002, 502),
        "GET /api/products/{id}": ([
            ("par", [
                ("call", "catalog", "GET", "/products/{id}", 1.0),
                ("call", "recommendation", "GET", "/recs", 0.8),
                ("call", "pricing", "GET", "/price", 1.0),
            ]),
        ], 0.002, 502),
        "GET /api/search": ([
            ("call", "search", "GET", "/search", 1.0),
        ], 0.002, 502),
        "POST /api/cart": ([
            ("call", "auth", "GET", "/verify", 1.0),
            ("call", "cart", "POST", "/cart/items", 1.0),
        ], 0.002, 502),
        "POST /api/checkout": ([
            ("call", "auth", "GET", "/verify", 1.0),
            ("call", "checkout", "POST", "/checkout", 1.0),
        ], 0.002, 502),
        "POST /api/login": ([
            ("call", "auth", "POST", "/login", 1.0),
        ], 0.002, 502),
        "GET /api/recommendations": ([
            ("call", "auth", "GET", "/verify", 0.5),
            ("call", "recommendation", "GET", "/recs", 1.0),
        ], 0.002, 502),
    },
    "auth": {
        "POST /login": ([
            ("db", "postgresql", "users-db", "SELECT", "users", 6, 1.0),
            ("work", 25),  # password hashing
            ("db", "redis", None, "SET", "session", 1, 1.0),
        ], 0.04, 401),
        "GET /verify": ([
            ("db", "redis", None, "GET", "session", 1, 1.0),
            ("db", "postgresql", "users-db", "SELECT", "users", 4, 0.1),
        ], 0.01, 401),
    },
    "catalog": {
        "GET /products": ([
            ("db", "redis", None, "GET", "products", 1, 1.0),
            ("db", "postgresql", "catalog-db", "SELECT", "products", 12, 0.4),
        ], 0.003, 500),
        "GET /products/{id}": ([
            ("db", "postgresql", "catalog-db", "SELECT", "products", 5, 1.0),
            ("call", "inventory", "GET", "/stock/{id}", 0.5),
        ], 0.02, 404),
    },
    "search": {
        "GET /search": ([
            ("db", "elasticsearch", None, "search", "products", 18, 1.0),
            ("call", "catalog", "GET", "/products/{id}", 0.3),
        ], 0.005, 500),
    },
    "recommendation": {
        "GET /recs": ([
            ("db", "redis", None, "HGETALL", "features", 2, 1.0),
            ("work", 15),  # model inference
            ("call", "catalog", "GET", "/products", 0.7),
        ], 0.005, 500),
    },
    "cart": {
        "POST /cart/items": ([
            ("db", "redis", None, "HSET", "cart", 1, 1.0),
            ("call", "pricing", "GET", "/price", 1.0),
        ], 0.005, 500),
        "GET /cart": ([
            ("db", "redis", None, "HGETALL", "cart", 1, 1.0),
        ], 0.002, 500),
    },
    "pricing": {
        "GET /price": ([
            ("call", "currency", "GET", "/convert", 0.8),
            ("db", "postgresql", "catalog-db", "SELECT", "prices", 4, 0.6),
        ], 0.004, 500),
    },
    "currency": {
        "GET /convert": ([
            ("db", "redis", None, "GET", "fx", 1, 1.0),
            ("ext", "ecb-rates-api", "GET", "/rates", 80, 0.08),
        ], 0.004, 503),
    },
    "checkout": {
        "POST /checkout": ([
            ("call", "cart", "GET", "/cart", 1.0),
            ("par", [
                ("call", "pricing", "GET", "/price", 1.0),
                ("call", "pricing", "GET", "/price", 0.6),
                ("call", "shipping", "POST", "/quote", 1.0),
            ]),
            ("call", "inventory", "POST", "/reserve", 1.0),
            ("call", "payment", "POST", "/charge", 1.0),
            ("pub", "orders", "notification", "/consume/orders", 1.0),
        ], 0.01, 500),
    },
    "inventory": {
        "GET /stock/{id}": ([
            ("db", "postgresql", "inventory-db", "SELECT", "stock", 3, 1.0),
        ], 0.003, 500),
        "POST /reserve": ([
            ("db", "postgresql", "inventory-db", "UPDATE", "stock", 9, 1.0),
        ], 0.03, 409),
    },
    "payment": {
        "POST /charge": ([
            ("call", "fraud", "POST", "/score", 1.0),
            ("ext", "stripe-api", "POST", "/v1/charges", 120, 1.0),
        ], 0.03, 402),
    },
    "fraud": {
        "POST /score": ([
            ("db", "redis", None, "GET", "risk", 1, 1.0),
            ("work", 30),  # model scoring
        ], 0.005, 500),
    },
    "shipping": {
        "POST /quote": ([
            ("call", "currency", "GET", "/convert", 1.0),
            ("ext", "dhl-api", "POST", "/rates", 90, 1.0),
        ], 0.01, 503),
    },
    "notification": {
        "POST /consume/orders": ([
            ("work", 5),
            ("ext", "smtp-relay", "POST", "/send", 40, 1.0),
        ], 0.01, 500),
    },
}

# Load generator mix at the gateway: route -> weight
TRAFFIC_MIX = {
    "GET /api/products": 30,
    "GET /api/products/{id}": 25,
    "GET /api/search": 15,
    "GET /api/recommendations": 10,
    "POST /api/cart": 10,
    "POST /api/login": 5,
    "POST /api/checkout": 5,
}

# Incidents rotate so the graph has something to show: every INCIDENT_PERIOD
# seconds one service misbehaves for INCIDENT_LENGTH seconds. All services
# compute this from wall-clock time, so they agree without talking.
INCIDENT_PERIOD = 240
INCIDENT_LENGTH = 70
INCIDENTS = [
    ("payment", "errors", 0.35),     # payment provider rejects
    ("search", "latency", 6.0),      # elasticsearch is slow
    ("inventory", "errors", 0.25),   # reservation conflicts
    ("currency", "latency", 8.0),    # fx api crawls
    ("auth", "errors", 0.2),         # token validation fails
    ("catalog", "latency", 4.0),
]
