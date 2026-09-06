#!/usr/bin/env python3
"""
Exercise the API against a live local server.

Search is the part worth pinning. Its failures are quiet: a wrong join returned
real albums for the wrong query and looked like poor ranking, and prefix
matching plus popularity ordering answered "sun ra" with Isaiah Rashad. Both
look like a working search having an off day.

    .venv/bin/python api/server.py --port 8787 &
    .venv/bin/python api/api-check.py
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8787"
failures: list[str] = []


def get(path: str, **params):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")
    if not ok:
        failures.append(label)


h = get("/v1/health")
check("health reports the catalog", h.get("albums", 0) > 90000, f"{h.get('albums'):,} albums")

# Each of these must find the named artist. All three are absent from the
# bundled catalog, which is the entire reason the API exists.
for q, artist in [("wilco", "Wilco"), ("joni mitchell", "Joni Mitchell"),
                  ("sun ra", "Sun Ra"), ("charles mingus", "Charles Mingus"),
                  ("townes van zandt", "Townes Van Zandt")]:
    items = get("/v1/search", q=q, limit=3)["items"]
    top = items[0]["artistName"] if items else "(nothing)"
    check(f'search "{q}" finds {artist}', top == artist, f"top hit {top}")

# Punctuation the FTS tokeniser splits: "U.S.A." must still be findable.
items = get("/v1/search", q="born in the usa", limit=3)["items"]
check("search survives punctuation", bool(items) and "Born in the U.S.A." in items[0]["title"],
      items[0]["title"] if items else "(nothing)")

# Items by id, and the shape the client expects.
seed = get("/v1/search", q="wilco", limit=1)["items"][0]
one = get("/v1/items", ids=seed["id"])["items"]
check("items by id round-trips", len(one) == 1 and one[0]["id"] == seed["id"])
check("item carries tags", len(one[0]["tags"]) > 0, f"{len(one[0]['tags'])} tags")
check("item carries art path", bool(one[0]["art"]), str(one[0]["art"]))

# Recommendations: two scored offers, chosen over the whole catalog.
near = get("/v1/recs", id=seed["id"], dial=0)
far = get("/v1/recs", id=seed["id"], dial=1)
check("recs returns two offers", len(near.get("offers", [])) == 2,
      " | ".join(f"{o['role']}: {o['item']['artistName']} — {o['item']['title']}"
                 for o in near.get("offers", [])))
check("offers carry both roles",
      {o["role"] for o in near.get("offers", [])} == {"deeper", "wider"})
check("recs echoes the seed", (near.get("seed") or {}).get("id") == seed["id"])
check("offers are complete enough to score from next",
      all(o["item"].get("tags") and o["item"].get("art") for o in near.get("offers", [])))

def med_listeners(payload):
    xs = sorted((o["item"]["listenerCount"] or 0) for o in payload.get("offers", []))
    return xs[len(xs) // 2] if xs else 0

n, f = med_listeners(near), med_listeners(far)
check("the dial moves what is offered", n > f,
      f"near median {n:,} listeners vs far {f:,}")

# Bad input must not 500.
check("rejects a malformed id", get("/v1/recs", id="nonsense", dial=0).get("error") == "bad id")
check("empty search is empty, not an error", get("/v1/search", q="x")["items"] == [])

print("\n" + ("all checks passed" if not failures else f"{len(failures)} FAILED"))
sys.exit(1 if failures else 0)
