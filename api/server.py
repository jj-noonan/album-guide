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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "catalog-api.sqlite"

MBID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_IDS = 200
MAX_LIMIT = 500


def connect() -> sqlite3.Connection:
    # One connection per thread; read-only so they cannot block each other.
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def absolute_popularity(listeners: int | None) -> float:
    """
    Listeners on a fixed 0-10 scale, independent of any population.

    Must match scripts/export_catalog.py exactly. A percentile would not: this
    server ranks over 100,931 albums and the client ships 12,000, so the same
    album would score differently either side of the wire and the engine's
    popularity target would quietly mean two things at once.
    """
    return round(min(10.0, 2.0 * math.log10(1.0 + max(0, listeners or 0))), 2)


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
        "country": r["artist_country"], "rating": r["rating"],
        "spotifyId": r["spotify_id"],
    } for r in rows]


SELECT = """
    SELECT i.id, i.title, i.artist_id, i.year_start, i.art_url,
           i.listen_count, i.listener_count, i.rating, i.spotify_id,
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


def get_recs(conn, item_id: str, dial: float, limit: int) -> dict:
    """
    Candidates for one card.

    Phase 1 returns a pool and lets the client score it, unchanged. The point of
    the split is that a regression stays attributable: if held-out agreement
    moves after this ships, it is the transport, because the scorer did not
    change. Phase 2 replaces this body with the scorer and returns offers.

    The pool is drawn around the dial's popularity target, which is what the
    engine's fame term aims at, so the candidates it needs are present without
    sending it the whole catalog.
    """
    if not MBID.match(item_id):
        return {"error": "bad id"}
    seed = conn.execute(f"{SELECT} WHERE i.id = ?", (item_id,)).fetchone()
    if not seed:
        return {"error": "not found"}

    # popularityNear 9.8 -> popularityFar 3.0, matching TUNING in the engine.
    target = 9.8 + (3.0 - 9.8) * max(0.0, min(1.0, dial))
    # Percentile band around the target, widened enough to cover the Gaussian.
    lo, hi = (target - 3.0) / 10.0, (target + 3.0) / 10.0
    total = conn.execute("SELECT COUNT(*) FROM items WHERE listener_count IS NOT NULL").fetchone()[0]
    q = f"""
        {SELECT}
        WHERE {ELIGIBLE} AND i.id != ?
          AND i.listener_count IS NOT NULL
          AND i.listener_count BETWEEN
              (SELECT listener_count FROM items WHERE listener_count IS NOT NULL
               ORDER BY listener_count LIMIT 1 OFFSET ?)
          AND (SELECT listener_count FROM items WHERE listener_count IS NOT NULL
               ORDER BY listener_count LIMIT 1 OFFSET ?)
        ORDER BY RANDOM() LIMIT ?
    """
    off_lo = max(0, int(total * lo))
    off_hi = min(total - 1, int(total * hi))
    rows = conn.execute(q, (item_id, off_lo, off_hi, limit)).fetchall()
    return {"seed": rows_to_items(conn, [seed])[0], "candidates": rows_to_items(conn, rows)}


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
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    n = Handler.conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    print(f"serving {n:,} albums on http://{args.host}:{args.port}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
