#!/usr/bin/env python3
"""
Read-only HTTP access to the catalog.

Standard library only, deliberately. The whole job is three SELECTs behind
three URLs against a file nothing writes to at runtime; a framework here would
be more to install, more to patch and more to keep current than the thing it
serves. If this grows a write path the calculation changes.

    .venv/bin/python api/server.py --port 8787
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402
from scores import absolute_popularity, absolute_quality  # noqa: E402
DB = ROOT / "data" / "catalog-api.sqlite"

MBID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_IDS = 200
MAX_LIMIT = 500


def connect() -> sqlite3.Connection:
    # One connection per thread; read-only so they cannot block each other.
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def art_path(url: str | None) -> str | None:
    """Store the path, not the URL — the client rebuilds both size variants."""
    if not url:
        return None
    m = re.search(r"release/([0-9a-f-]+)/(\d+)", url)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def rows_to_items(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict]:
    """Shape rows into the client's Item, tags included."""
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    tags: dict[str, list] = {i: [] for i in ids}
    # Chunked: SQLite's parameter limit is 999 and a large id list would blow it.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        q = f"SELECT item_id, tag, count FROM item_tags WHERE item_id IN ({','.join('?' * len(chunk))})"
        for t in conn.execute(q, chunk):
            tags[t["item_id"]].append({"tag": t["tag"], "count": t["count"]})
    return [{
        "id": r["id"], "title": r["title"], "artistId": r["artist_id"],
        "artistName": r["artist_name"] or "", "year": r["year_start"],
        "art": art_path(r["art_url"]), "tags": tags.get(r["id"], []),
        "corridorIds": [],
        "listenCount": r["listen_count"], "listenerCount": r["listener_count"],
        "popularity": absolute_popularity(r["listener_count"]),
        "quality": absolute_quality(r["listen_count"], r["listener_count"],
                                    r["rating"], r["rating_votes"]),
        "country": r["artist_country"], "rating": r["rating"],
        "spotifyId": r["spotify_id"],
    } for r in rows]


SELECT = """
    SELECT i.id, i.title, i.artist_id, i.year_start, i.art_url,
           i.listen_count, i.listener_count, i.rating, i.rating_votes, i.spotify_id,
           a.name AS artist_name, a.country AS artist_country
    FROM items i LEFT JOIN artists a ON a.id = i.artist_id
"""
ELIGIBLE = """
    i.art_url IS NOT NULL
    AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)
"""


def get_items(conn, ids: list[str]) -> list[dict]:
    ids = [i for i in ids if MBID.match(i)][:MAX_IDS]
    if not ids:
        return []
    q = f"{SELECT} WHERE i.id IN ({','.join('?' * len(ids))})"
    return rows_to_items(conn, conn.execute(q, ids).fetchall())


# Built once at startup: the whole scorable catalog, shaped for the engine.
#
# Deriving vectors and tag sets per request would redo the same work for every
# card. ~92,000 albums at a few hundred bytes each is well inside the machine's
# memory, and it is read-only, so every thread shares one copy.
_POOL: list[dict] | None = None
_POOL_BY_ID: dict[str, dict] = {}


def build_pool(conn: sqlite3.Connection) -> None:
    """
    Load the scorable catalog into memory, as small as it will go.

    The first attempt held 296 MB and was OOM-killed on a 256 MB machine. Three
    things accounted for it, none of them the database — SQLite memory-maps
    that and reads pages on demand.

    The intermediate tag structures cost 109 MB and are only needed while
    building, so they are dropped before serving. Each entry kept a full
    sqlite3.Row of every column, when scoring needs six fields and the two
    chosen albums can be re-queried by id. And each kept both the raw vector
    and its scaled form, when only the scaled one is ever read.

    Tag strings are interned: 356,000 tag rows draw on about 5,800 distinct
    words, so without it the same word is stored thousands of times over.
    """
    global _POOL
    rows = conn.execute(
        """SELECT i.id, i.artist_id, i.year_start, i.listen_count,
                  i.listener_count, i.rating, i.rating_votes
           FROM items i
           WHERE i.art_url IS NOT NULL
             AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)"""
    ).fetchall()

    tags: dict[str, list] = {}
    for t in conn.execute("SELECT item_id, tag, count FROM item_tags"):
        tags.setdefault(t["item_id"], []).append(
            {"tag": sys.intern(t["tag"]), "count": t["count"]}
        )

    pool = []
    for r in rows:
        t = tags.get(r["id"], ())
        # The same coverage filter the client applies. An album the lexicon
        # barely knows derives a dead-centre vector and looks similar to
        # everything; dropping it here keeps both engines choosing from the
        # same catalog.
        if engine.lexicon_coverage(t) < engine.MIN_COVERAGE:
            continue
        pool.append({
            "id": r["id"],
            "idBytes": r["id"].encode(),
            "artistId": r["artist_id"],
            "popularity": absolute_popularity(r["listener_count"]),
            "quality": absolute_quality(r["listen_count"], r["listener_count"],
                                        r["rating"], r["rating_votes"]),
            "sv": engine.scaled_vector(engine.derive_vector(t, r["year_start"])),
            "tagSet": engine.musical_tags(t),
        })

    tags.clear()
    del rows
    _POOL = pool
    _POOL_BY_ID.clear()
    _POOL_BY_ID.update({p["id"]: p for p in pool})


def get_recs(conn, item_id: str, dial: float, limit: int) -> dict:
    """
    Two scored offers for one card, chosen from the whole catalog.

    Phase 1 returned a candidate pool and let the client score it, which meant
    the query had to guess what the scorer would want before the scorer had
    seen anything. This removes the guess. The engine is a port of the client's
    and is checked against it — api/parity-check.py requires the same albums in
    the same roles for the same seeds at every dial setting, not merely similar
    ones.
    """
    if not MBID.match(item_id):
        return {"error": "bad id"}
    if _POOL is None:
        return {"error": "not ready"}
    seed = _POOL_BY_ID.get(item_id)
    if seed is None:
        # Known to the catalog but not scorable — no art, no tags, or too
        # little lexicon coverage to place on the axes.
        row = conn.execute(f"{SELECT} WHERE i.id = ?", (item_id,)).fetchone()
        return {"error": "not found"} if row is None else {"error": "not scorable"}

    offers = engine.pick_branches(seed, _POOL, dial, {item_id})
    # Re-queried rather than carried: three rows per request costs nothing,
    # where holding every column of 89,000 albums in memory cost the machine.
    wanted = [item_id] + [o["item"]["id"] for o in offers]
    full = {i["id"]: i for i in get_items(conn, wanted)}
    return {
        "seed": full.get(item_id),
        "offers": [{
            "role": o["role"],
            "distance": round(o["distance"], 6),
            "score": o["score"],
            "item": full.get(o["item"]["id"]),
        } for o in offers if full.get(o["item"]["id"])],
    }


def get_random(conn, exclude: set[str], seed: str) -> dict | None:
    """
    One album at random from everything scorable.

    The shuffle is the move the engine cannot make — a record chosen with the
    rules switched off. Drawn from the client's bundle it was choosing from
    11,476 of 100,931, which is the same rules by another name: the 88% least
    likely to be bundled could never turn up. This draws from all of it.

    Seeded from the card it was rolled on, so the same card offers the same
    surprise. A shuffle that changes every render is not a door, it is a slot
    machine, and stepping back would land somewhere new each time.
    """
    if _POOL is None:
        return None
    n = len(_POOL)
    if not n:
        return None
    start = int(engine.hash01(f"wild:{seed}") * n)
    for i in range(n):
        cand = _POOL[(start + i) % n]
        if cand["id"] not in exclude:
            items = get_items(conn, [cand["id"]])
            return items[0] if items else None
    return None


def get_search(conn, text: str, limit: int) -> list[dict]:
    """
    Find an album by name, or an artist by name.

    Ranked on match quality before popularity. Ranking on listeners alone made
    "sun ra" return Isaiah Rashad: prefix tokens matched "Sun's" and "Rashad",
    and those records are far better known than anything Sun Ra recorded. What
    a person typing two words wants is the artist called that, so an exact
    artist match outranks everything, then a title match, then reach.
    """
    text = text.strip()
    if len(text) < 2:
        return []
    words = re.findall(r"\w+", text.lower())[:6]
    if not words:
        return []

    match = " ".join(f'"{w}"*' for w in words)
    q = f"""
        {SELECT}, (
            CASE
                WHEN lower(a.name) = ?            THEN 3
                WHEN lower(a.name) LIKE ? THEN 2
                WHEN lower(i.title) LIKE ? THEN 1
                ELSE 0
            END
        ) AS quality
        JOIN items_fts f ON f.item_id = i.id
        WHERE items_fts MATCH ? AND {ELIGIBLE}
        ORDER BY quality DESC, i.listener_count DESC NULLS LAST
        LIMIT ?
    """
    joined = " ".join(words)
    like = f"%{joined}%"
    try:
        rows = conn.execute(q, (joined, like, like, match, limit)).fetchall()
    except sqlite3.OperationalError:
        rows = []

    if not rows:
        # FTS tokenises on punctuation, so "usa" cannot match a title written
        # "U.S.A." and the query returns nothing at all rather than something
        # imperfect. A substring pass costs a scan and only runs when the index
        # has already failed, which is rare and always better than no answer.
        flat = re.sub(r"[^a-z0-9]", "", joined)
        q2 = f"""
            {SELECT}
            WHERE {ELIGIBLE} AND (
                replace(replace(replace(lower(i.title), '.', ''), ' ', ''), '-', '') LIKE ?
                OR replace(replace(lower(a.name), '.', ''), ' ', '') LIKE ?
            )
            ORDER BY i.listener_count DESC NULLS LAST LIMIT ?
        """
        rows = conn.execute(q2, (f"%{flat}%", f"%{flat}%", limit)).fetchall()

    return rows_to_items(conn, rows)


class Handler(BaseHTTPRequestHandler):
    conn: sqlite3.Connection

    def _send(self, code: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The catalog is public and the site is served from another origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        # Read-only data that changes only when a crawl finishes.
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        one = lambda k, d="": (q.get(k) or [d])[0]
        try:
            limit = max(1, min(MAX_LIMIT, int(one("limit", "60"))))
        except ValueError:
            limit = 60

        try:
            if u.path == "/v1/items":
                self._send(200, {"items": get_items(self.conn, one("ids").split(","))})
            elif u.path == "/v1/recs":
                try:
                    dial = float(one("dial", "0"))
                except ValueError:
                    dial = 0.0
                out = get_recs(self.conn, one("id"), dial, limit)
                self._send(404 if out.get("error") == "not found" else 200, out)
            elif u.path == "/v1/random":
                ex = {i for i in one("exclude").split(",") if MBID.match(i)}
                item = get_random(self.conn, ex, one("seed") or "x")
                self._send(200, {"item": item})
            elif u.path == "/v1/search":
                self._send(200, {"items": get_search(self.conn, one("q"), limit)})
            elif u.path == "/v1/health":
                n = self.conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
                self._send(200, {"ok": True, "albums": n})
            else:
                self._send(404, {"error": "no such endpoint"})
        except Exception as e:  # noqa: BLE001
            # Never leak a stack trace to a public endpoint.
            self.log_error("%s", e)
            self._send(500, {"error": "internal"})

    def log_message(self, fmt, *args):
        pass  # quiet by default; errors still go through log_error


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8787)))
    # Containers need 0.0.0.0. Bound to localhost a Fly machine passes its own
    # health check and refuses every request from outside it, which presents as
    # a deploy that "worked" and a URL that times out.
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()
    if not DB.exists():
        print(f"no {DB} — run api/make-api-db.py first", file=sys.stderr)
        return 1
    Handler.conn = connect()
    build_pool(Handler.conn)
    print(f"engine pool: {len(_POOL or []):,} scorable albums", flush=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    n = Handler.conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    print(f"serving {n:,} albums on http://{args.host}:{args.port}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
