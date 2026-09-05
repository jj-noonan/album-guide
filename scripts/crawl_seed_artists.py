#!/usr/bin/env python3
"""
Fetch full discographies for the evaluation seeds themselves.

Distinct from crawl_gaps.py, which fetches artists a seed is *similar to*. This
fetches the seed's own records, which is fair for held-out seeds too:
contamination comes from stocking the catalog with a seed's answers, not from
holding its albums. A seed with no albums produces no test at all, and a seed
with one produces two offers, which is noise dressed as a measurement.

The need showed up in coverage: with 100,675 albums held, Led Zeppelin had 2,
Fleetwood Mac 1, Daft Punk 1 and Portishead 1. crawl_gaps only ever looked for
artists missing entirely, so an artist present with a fraction of their
catalogue was invisible to it — a second kind of gap that no check was asking
about.

    .venv/bin/python -u scripts/crawl_seed_artists.py --min 6
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import crawl  # noqa: E402
import db  # noqa: E402
import seeds  # noqa: E402
from crawl_us import discography  # noqa: E402


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def norm(s: str) -> str:
    """Casefold and flatten the punctuation MusicBrainz varies on."""
    for a, b in (("\u2019", "'"), ("\u2018", "'"), ("\u201b", "'"),
                 ("\u2013", "-"), ("\u2014", "-"), ("\u00a0", " ")):
        s = s.replace(a, b)
    return " ".join(s.lower().split())


def find_artist(conn, name: str) -> tuple[str | None, int]:
    """Best matching artist id already held, and how many albums we have."""
    row = conn.execute(
        """SELECT a.id, COUNT(i.id) n FROM artists a
           LEFT JOIN items i ON i.artist_id = a.id
           WHERE a.name = ? GROUP BY a.id ORDER BY n DESC LIMIT 1""",
        (name,),
    ).fetchone()
    return (row["id"], row["n"]) if row else (None, 0)


def search_artist(name: str) -> dict | None:
    """Look an artist up by name when we do not already hold them."""
    data = crawl.mb_get("/artist", {"query": f'artist:"{name}"', "limit": 5})
    for a in (data or {}).get("artists", []):
        # Exact match, but on normalised punctuation. Fuzzy search happily
        # returns tribute bands and same-named locals, so the comparison stays
        # strict — it just stops failing on typography. MusicBrainz writes
        # D'Angelo with a right single quote, and an ASCII apostrophe in the
        # seed list missed him entirely while reporting "no exact match",
        # which reads like the artist is absent rather than mis-spelled.
        if norm(a.get("name", "")) == norm(name):
            return {
                "id": a["id"], "name": a["name"],
                "sortName": a.get("sort-name") or a["name"],
                "country": a.get("country"), "area": (a.get("area") or {}).get("name"),
                "beganYear": None, "endedYear": None,
            }
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=6,
                    help="fetch any seed holding fewer than this many albums")
    ap.add_argument("--hours", type=float, default=0)
    args = ap.parse_args()

    conn = db.connect()
    db.init(conn)
    names = seeds.all_artists()
    doc = seeds.load()
    held = set(seeds.held_out(doc))

    todo = []
    for name in names:
        aid, n = find_artist(conn, name)
        if n < args.min:
            todo.append((name, aid, n))

    log(f"{len(names)} seeds, {len(todo)} under {args.min} albums")
    deadline = time.time() + args.hours * 3600 if args.hours else None
    added = 0

    for n_i, (name, aid, have) in enumerate(todo, 1):
        if deadline and time.time() > deadline:
            log("time budget reached — stopping cleanly")
            break

        info = None
        if not aid:
            info = search_artist(name)
            if not info:
                log(f"  [{n_i}/{len(todo)}] {name}: no exact match in MusicBrainz, skipping")
                continue
            aid = info["id"]

        albums = discography(aid)
        if not albums:
            continue
        if info:
            db.upsert_artist(conn, info)
            conn.execute(
                "UPDATE artists SET area=?, checked_at=datetime('now') WHERE id=?",
                (info.get("area"), aid))
        known = db.existing_ids(conn, [a["id"] for a in albums])
        new = [a for a in albums if a["id"] not in known]
        with_art = crawl.attach_art(new) if new else []
        for alb in with_art:
            db.upsert_album(conn, {**alb, "artistName": name, "corridorIds": []})
        conn.commit()
        added += len(with_art)
        flag = " [held out]" if name in held else ""
        log(f"  [{n_i}/{len(todo)}] {name}: had {have}, +{len(with_art)}{flag}")

    log(f"done — added {added:,} albums across {len(todo)} seeds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
