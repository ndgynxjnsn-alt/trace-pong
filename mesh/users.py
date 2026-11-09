"""Fake OAuth users for the simulated Faro frontend.

Deterministic, so every restart produces the same people. Each user has the claims an OIDC
provider would hand out (sub, email, name, preferred_username), and `token()` wraps them in an
unsigned-looking JWT that the gateway decodes like a real resource server would read claims.
"""
import base64
import json
import random
import time

FIRST = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Alan", "Radia",
         "Edsger", "Hedy", "Tim", "Katherine", "Guido", "Sophie", "Bjarne", "Anita", "Niklaus", "Joan",
         "Donald", "Shafi", "Vint", "Lynn", "Yukihiro", "Carol", "Rob", "Mary", "John", "Evelyn"]
LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie", "Allen",
        "Turing", "Perlman", "Dijkstra", "Lamarr", "Berners-Lee", "Johnson", "van Rossum", "Wilson",
        "Stroustrup", "Borg", "Wirth", "Clarke", "Knuth", "Goldwasser", "Cerf", "Conway",
        "Matsumoto", "Shaw", "Pike", "Keller", "McCarthy", "Berezin"]
DOMAINS = ["gmail.com", "outlook.com", "proton.me", "example.com", "fastmail.com"]


def _provider_id(rng):
    kind = rng.choice(["google-oauth2", "auth0", "github", "okta"])
    if kind == "google-oauth2":
        return f"google-oauth2|{rng.randrange(10**20, 10**21)}"
    if kind == "auth0":
        return f"auth0|{rng.getrandbits(96):024x}"
    if kind == "github":
        return f"github|{rng.randrange(10**6, 10**8)}"
    alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "okta|00u" + "".join(rng.choice(alnum) for _ in range(17))


def make_users(n=64, seed=42):
    rng = random.Random(seed)
    users, seen = [], set()
    while len(users) < n:
        first, last = rng.choice(FIRST), rng.choice(LAST)
        if (first, last) in seen:
            continue
        seen.add((first, last))
        handle = f"{first[0]}{last.split()[-1]}".lower().replace("-", "")
        users.append({
            "sub": _provider_id(rng),
            "name": f"{first} {last}",
            "preferred_username": f"{handle}{rng.randrange(1, 99)}",
            "email": f"{first}.{last.replace(' ', '')}@{rng.choice(DOMAINS)}".lower(),
            # some people use the shop a lot more than others
            "weight": rng.paretovariate(1.3),
        })
    return users


def _b64(obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(user):
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT", "kid": "demo-key-1"}
    claims = {"iss": "https://login.shop.example/", "aud": "shop-api", "sub": user["sub"],
              "email": user["email"], "name": user["name"], "preferred_username": user["preferred_username"],
              "iat": now, "exp": now + 3600, "scope": "openid profile email"}
    sig = base64.urlsafe_b64encode(random.randbytes(32)).rstrip(b"=").decode()
    return f"{_b64(header)}.{_b64(claims)}.{sig}"


def claims(bearer):
    """Read the claims of a bearer token (no verification: it's a demo)."""
    try:
        payload = bearer.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None


class ActiveUsers:
    """Users come and go: a rotating set of people currently using the shop."""

    def __init__(self, users, size=18, churn_s=6.0):
        self.users = users
        self.size = size
        self.churn_s = churn_s
        self.active = random.sample(users, size)
        self.last = time.time()

    def pick(self):
        now = time.time()
        if now - self.last > self.churn_s:
            self.last = now
            leaving = random.randrange(len(self.active))
            idle = [u for u in self.users if u not in self.active]
            self.active[leaving] = random.choice(idle)
        return random.choices(self.active, [u["weight"] for u in self.active])[0]
