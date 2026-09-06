#!/usr/bin/env python3
"""
Build the read-only database the API serves.

The crawl database carries a lot the API has no use for — queue state, per-tag
offsets, artist bookkeeping — which is dead weight in an image layer that has
to be pushed on every data update. Dropping it and vacuuming takes 143 MB to
122 MB.

Deliberately a copy rather than the live file. The crawler writes continuously,
and serving the same file would mean a reader and a long-running writer sharing
a database across a network boundary, which is how WAL corruption stories
start. A copy is also reproducible: the API serves exactly what was built, not
whatever the crawler happens to have reached.

    .venv/bin/python api/make-api-db.py
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "catalog.sqlite"
OUT = ROOT / "data" / "catalog-api.sqlite"

# Everything the crawler needs and a reader does not.
DROP = [
    "crawl_units", "crawl_tags", "us_tags", "artist_done", "jobs",
    "item_corridors",
]


def main() -> int:
    if not SRC.exists():
        print(f"no {SRC}", file=sys.stderr)
        return 1

    tmp = OUT.with_suffix(".building")
    # Copy through SQLite's own backup API rather than the filesystem: the
    # crawler may be mid-write, and a byte copy of a live WAL database can land
    # torn in a way that only shows up under a later query.
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    dst = sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    src.close()

    for table in DROP:
        dst.execute(f"DROP TABLE IF EXISTS {table}")
    dst.commit()
    # Indexes the API's own queries need; the crawler's are dropped with VACUUM.
    dst.execute("CREATE INDEX IF NOT EXISTS idx_api_artist ON items(artist_id)")
    dst.execute("CREATE INDEX IF NOT EXISTS idx_api_pop ON items(listener_count DESC)")
    dst.commit()
    dst.execute("VACUUM")
    dst.close()

    tmp.replace(OUT)
    mb = OUT.stat().st_size / 1024 / 1024
    src_mb = SRC.stat().st_size / 1024 / 1024
    conn = sqlite3.connect(OUT)
    n = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    conn.close()
    print(f"{OUT.name}: {mb:.0f} MB (from {src_mb:.0f} MB), {n:,} albums")
    return 0


if __name__ == "__main__":
    sys.exit(main())
