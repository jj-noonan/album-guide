"""
SQLite storage for the catalog.

Replaces the single JSON blob the crawler used to load and rewrite in full
after every tag — which was already 3 MB at 6k albums and would have been
hundreds of MB rewritten hundreds of times on a days-long run. Here a tag
costs a handful of INSERTs.

The tables mirror src/data/schema.ts exactly, so the TypeScript model and the
database stay one design rather than two that drift.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "catalog.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS artists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_name   TEXT,
  country     TEXT,
  began_year  INTEGER,
  ended_year  INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'album',
  title         TEXT NOT NULL,
  artist_id     TEXT REFERENCES artists(id),
  year_start    INTEGER,
  year_end      INTEGER,
  art_url       TEXT,
  art_thumb_url TEXT,
  listen_count  INTEGER,
  listener_count INTEGER,
  rating        REAL,
  rating_votes  INTEGER,
  obscurity     REAL,
  vector        TEXT,
  first_seen    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS item_corridors (
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  corridor_id TEXT NOT NULL,
  PRIMARY KEY (item_id, corridor_id)
);

CREATE TABLE IF NOT EXISTS edges (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id, relation)
);

-- Crawl bookkeeping: which corridor/tag pairs are harvested. Replaces the
-- doneTags array, and records enough to see where a run got thin.
CREATE TABLE IF NOT EXISTS crawl_tags (
  corridor_id TEXT NOT NULL,
  tag         TEXT NOT NULL,
  done_at     TEXT,
  found       INTEGER,
  selected    INTEGER,
  kept        INTEGER,
  PRIMARY KEY (corridor_id, tag)
);

-- A crawl work unit is (corridor, tag, decade), each paginated independently.
-- Persisting next_offset is what makes a long crawl productive: without it,
-- every pass re-requests the same relevance-ordered first pages and finds
-- nothing new. Slicing by decade also multiplies what the search API will
-- actually hand back, and balances eras structurally rather than by sampling.
CREATE TABLE IF NOT EXISTS crawl_units (
  corridor_id TEXT NOT NULL,
  tag         TEXT NOT NULL,
  decade      INTEGER NOT NULL,
  next_offset INTEGER NOT NULL DEFAULT 0,
  exhausted   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER,
  kept        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  PRIMARY KEY (corridor_id, tag, decade)
);

-- Progress for the US-artist crawl: one row per (corridor tag, page).
CREATE TABLE IF NOT EXISTS us_tags (
  tag         TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL DEFAULT 0,
  exhausted   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER,
  artists     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);

-- Artists whose discography we have already pulled, so a second corridor
-- naming the same artist costs nothing.
CREATE TABLE IF NOT EXISTS artist_done (
  artist_id TEXT PRIMARY KEY,
  albums    INTEGER NOT NULL DEFAULT 0,
  done_at   TEXT DEFAULT (datetime('now'))
);

-- Ingest queue. Nothing drains it yet; it exists so search-driven seeding has
-- somewhere to put work when we build it, without another migration.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_artist    ON items(artist_id);
CREATE INDEX IF NOT EXISTS idx_items_year      ON items(year_start);
CREATE INDEX IF NOT EXISTS idx_items_obscurity ON items(obscurity);
CREATE INDEX IF NOT EXISTS idx_items_listens   ON items(listen_count);
CREATE INDEX IF NOT EXISTS idx_tags_tag        ON item_tags(tag);
CREATE INDEX IF NOT EXISTS idx_corr_corridor   ON item_corridors(corridor_id);
CREATE INDEX IF NOT EXISTS idx_jobs_state      ON jobs(state, id);
CREATE INDEX IF NOT EXISTS idx_units_pending   ON crawl_units(exhausted, corridor_id);

-- Typeahead. prefix='2 3 4' pre-builds short-prefix indexes so autocomplete
-- doesn't pay a scan on every keystroke.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED,
  title,
  artist_name,
  prefix='2 3 4',
  tokenize="unicode61 remove_diacritics 2"
);
"""


def connect(path: Path | str = DEFAULT_DB) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # WAL + NORMAL keeps bulk inserts fast without risking corruption on crash;
    # a days-long crawl will be interrupted at some point.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA cache_size=-64000")
    # Ratings, crawl and export all write; without this a concurrent writer
    # raises "database is locked" immediately instead of waiting its turn — it
    # aborted an export mid-run and nearly shipped a stale catalog.
    conn.execute("PRAGMA busy_timeout=60000")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # Columns added after the first databases were built.
    have = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
    for col, decl in (
        ("listener_count", "INTEGER"),
        ("rating", "REAL"),
        ("rating_votes", "INTEGER"),
        # Set by the exporter: is this album in the snapshot the site serves?
        ("exported", "INTEGER"),
        ("spotify_id", "TEXT"),
        ("spotify_checked_at", "TEXT"),
    ):
        if col not in have:
            conn.execute(f"ALTER TABLE items ADD COLUMN {col} {decl}")
    have_a = {r["name"] for r in conn.execute("PRAGMA table_info(artists)")}
    for col, decl in (("area", "TEXT"), ("checked_at", "TEXT")):
        if col not in have_a:
            conn.execute(f"ALTER TABLE artists ADD COLUMN {col} {decl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_artists_country ON artists(country)")

    # Only now that the columns certainly exist.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_listeners ON items(listener_count)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_rating ON items(rating_votes)")
    # Composite and covering: lets "unrated, most-listened first" be answered by
    # walking one index. With only idx_items_rating, SQLite found the NULL rows
    # but then had to read listener_count from the table for every one of them
    # and sort — tens of thousands of random reads on an 87MB file, which stalled
    # the ratings pass before it wrote a single row.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_items_unrated "
        "ON items(rating_votes, listener_count DESC)"
    )
    # Covers the priority order: unrated, deployed-first, then most-listened.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_items_ratequeue "
        "ON items(rating_votes, exported DESC, listener_count DESC)"
    )
    conn.commit()


def retrying(fn, *args, attempts: int = 6, **kwargs):
    """
    Run a write, waiting out a busy database rather than dying on it.

    Several processes write here at once — the crawler, the ratings pass, the
    Spotify resolver — and WAL plus a busy_timeout still isn't enough under
    sustained contention: two writers each committing every 25 rows will
    eventually collide, and an unhandled "database is locked" kills a job that
    was hours in. Backing off and retrying costs milliseconds and makes
    concurrent writers genuinely safe.
    """
    delay = 0.25
    for attempt in range(attempts):
        try:
            return fn(*args, **kwargs)
        except sqlite3.OperationalError as e:
            if "locked" not in str(e).lower() and "busy" not in str(e).lower():
                raise
            if attempt == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2
    return None


def upsert_artist(conn: sqlite3.Connection, a: dict) -> None:
    conn.execute(
        """INSERT INTO artists (id, name, sort_name, country, began_year, ended_year)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,
             sort_name=COALESCE(excluded.sort_name, artists.sort_name),
             country=COALESCE(excluded.country, artists.country)""",
        (a["id"], a["name"], a.get("sortName"), a.get("country"),
         a.get("beganYear"), a.get("endedYear")),
    )


def upsert_album(conn: sqlite3.Connection, alb: dict) -> None:
    """Insert or refresh one album plus its tags and corridor memberships."""
    conn.execute(
        """INSERT INTO items
             (id, kind, title, artist_id, year_start, art_url, art_thumb_url,
              listen_count, listener_count)
           VALUES (?, 'album', ?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,
             art_url=COALESCE(excluded.art_url, items.art_url),
             art_thumb_url=COALESCE(excluded.art_thumb_url, items.art_thumb_url),
             -- Never overwrite a known listen count with an unknown one.
             listen_count=COALESCE(excluded.listen_count, items.listen_count),
             listener_count=COALESCE(excluded.listener_count, items.listener_count),
             updated_at=datetime('now')""",
        (alb["id"], alb["title"], alb["artistId"], alb.get("year"),
         alb.get("artUrl"), alb.get("artThumbUrl"),
         alb.get("listenCount"), alb.get("listenerCount")),
    )

    if alb.get("tags"):
        conn.executemany(
            """INSERT INTO item_tags (item_id, tag, count) VALUES (?,?,?)
               ON CONFLICT(item_id, tag) DO UPDATE SET
                 count=MAX(item_tags.count, excluded.count)""",
            [(alb["id"], t["tag"], t.get("count", 1)) for t in alb["tags"]],
        )

    if alb.get("corridorIds"):
        conn.executemany(
            "INSERT OR IGNORE INTO item_corridors (item_id, corridor_id) VALUES (?,?)",
            [(alb["id"], c) for c in alb["corridorIds"]],
        )

    conn.execute("DELETE FROM items_fts WHERE item_id = ?", (alb["id"],))
    conn.execute(
        "INSERT INTO items_fts (item_id, title, artist_name) VALUES (?,?,?)",
        (alb["id"], alb["title"], alb.get("artistName", "")),
    )


def done_tags(conn: sqlite3.Connection) -> set[str]:
    return {
        f"{r['corridor_id']}/{r['tag']}"
        for r in conn.execute("SELECT corridor_id, tag FROM crawl_tags WHERE done_at IS NOT NULL")
    }


def mark_tag(conn: sqlite3.Connection, corridor: str, tag: str,
             found: int, selected: int, kept: int) -> None:
    conn.execute(
        """INSERT INTO crawl_tags (corridor_id, tag, done_at, found, selected, kept)
           VALUES (?,?,datetime('now'),?,?,?)
           ON CONFLICT(corridor_id, tag) DO UPDATE SET
             done_at=datetime('now'), found=excluded.found,
             selected=excluded.selected, kept=excluded.kept""",
        (corridor, tag, found, selected, kept),
    )


def has_album(conn: sqlite3.Connection, item_id: str) -> bool:
    return conn.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone() is not None


def existing_ids(conn: sqlite3.Connection, ids: list[str]) -> set[str]:
    """Bulk membership test — one query instead of one per candidate."""
    out: set[str] = set()
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        q = f"SELECT id FROM items WHERE id IN ({','.join('?' * len(chunk))})"
        out.update(r["id"] for r in conn.execute(q, chunk))
    return out


def stats(conn: sqlite3.Connection) -> dict:
    one = lambda q: conn.execute(q).fetchone()[0]
    return {
        "albums": one("SELECT COUNT(*) FROM items"),
        "artists": one("SELECT COUNT(*) FROM artists"),
        "withArt": one("SELECT COUNT(*) FROM items WHERE art_url IS NOT NULL"),
        "withListens": one("SELECT COUNT(*) FROM items WHERE listener_count IS NOT NULL"),
        "withRating": one("SELECT COUNT(*) FROM items WHERE rating IS NOT NULL"),
        "tagsDone": one("SELECT COUNT(*) FROM crawl_tags WHERE done_at IS NOT NULL"),
    }


def set_popularity(conn: sqlite3.Connection, rows: dict[str, tuple[int, int]]) -> None:
    """rows: mbid -> (total listens, distinct listeners)."""
    conn.executemany(
        """UPDATE items SET listen_count=?, listener_count=?, updated_at=datetime('now')
           WHERE id=?""",
        [(v[0], v[1], k) for k, v in rows.items()],
    )


def set_rating(conn: sqlite3.Connection, mbid: str, value: float | None, votes: int) -> None:
    retrying(
        conn.execute,
        """UPDATE items SET rating=?, rating_votes=?, updated_at=datetime('now') WHERE id=?""",
        (value, votes, mbid),
    )


def missing_ratings(conn: sqlite3.Connection, limit: int) -> list[str]:
    """
    Albums still lacking a rating lookup, in priority order.

    MusicBrainz has no bulk ratings endpoint — one request per album at
    1 req/sec — so coverage will always be partial and the ORDER is what makes
    it valuable.

    Deployed albums come first. The export samples across every popularity
    decile, so ranking purely by listeners would leave the obscure half of the
    live catalog unrated for many hours — and that half is exactly what the far
    end of the terrain dial serves. Within each group, most-listened first.

    Once the deployed set is covered this naturally rolls onto everything else,
    so freshly crawled albums keep getting picked up rather than needing a
    separate pass.
    """
    return [
        r["id"] for r in conn.execute(
            """SELECT id FROM items
               WHERE rating_votes IS NULL
               ORDER BY exported DESC, listener_count DESC
               LIMIT ?""", (limit,))
    ]


def missing_listen_counts(conn: sqlite3.Connection, limit: int = 100000) -> list[str]:
    return [
        r["id"] for r in conn.execute(
            "SELECT id FROM items WHERE listener_count IS NULL LIMIT ?", (limit,)
        )
    ]


def json_dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False)


# ── crawl units ────────────────────────────────────────────────────────────


def unit_state(conn: sqlite3.Connection) -> dict[tuple, sqlite3.Row]:
    return {
        (r["corridor_id"], r["tag"], r["decade"]): r
        for r in conn.execute("SELECT * FROM crawl_units")
    }


def save_unit(conn: sqlite3.Connection, corridor: str, tag: str, decade: int,
              next_offset: int, exhausted: bool, total: int | None, kept: int) -> None:
    conn.execute(
        """INSERT INTO crawl_units
             (corridor_id, tag, decade, next_offset, exhausted, total, kept, updated_at)
           VALUES (?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(corridor_id, tag, decade) DO UPDATE SET
             next_offset=excluded.next_offset,
             exhausted=excluded.exhausted,
             total=COALESCE(excluded.total, crawl_units.total),
             kept=crawl_units.kept + excluded.kept,
             updated_at=datetime('now')""",
        (corridor, tag, decade, next_offset, 1 if exhausted else 0, total, kept),
    )


def crawl_progress(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        """SELECT COUNT(*) AS units,
                  SUM(exhausted) AS done,
                  SUM(COALESCE(total, 0)) AS reachable,
                  SUM(next_offset) AS seen
           FROM crawl_units"""
    ).fetchone()
    return {
        "units": row["units"] or 0,
        "exhausted": row["done"] or 0,
        "reachable": row["reachable"] or 0,
        "scanned": row["seen"] or 0,
    }


# ── artist origin ──────────────────────────────────────────────────────────


def artists_missing_origin(conn: sqlite3.Connection, limit: int) -> list[str]:
    """Artists never looked up, most-albums-first so the catalog moves soonest."""
    return [
        r["id"] for r in conn.execute(
            """SELECT a.id FROM artists a
               LEFT JOIN items i ON i.artist_id = a.id
               WHERE a.checked_at IS NULL
               GROUP BY a.id
               ORDER BY COUNT(i.id) DESC
               LIMIT ?""", (limit,))
    ]


def set_artist_origin(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    """rows: (id, country|None, area|None). checked_at marks it as looked up,
    so a legitimately blank country is never mistaken for pending work."""
    conn.executemany(
        """UPDATE artists SET country=?, area=?, checked_at=datetime('now')
           WHERE id=?""",
        [(country, area, aid) for aid, country, area in rows],
    )


def origin_summary(conn: sqlite3.Connection) -> dict:
    one = lambda q: conn.execute(q).fetchone()[0]
    return {
        "artists": one("SELECT COUNT(*) FROM artists"),
        "checked": one("SELECT COUNT(*) FROM artists WHERE checked_at IS NOT NULL"),
        "us": one("SELECT COUNT(*) FROM artists WHERE country='US'"),
        "foreign": one(
            "SELECT COUNT(*) FROM artists WHERE country IS NOT NULL AND country<>'US'"),
        "unknown": one(
            "SELECT COUNT(*) FROM artists WHERE checked_at IS NOT NULL AND country IS NULL"),
        "usAlbums": one(
            """SELECT COUNT(*) FROM items i JOIN artists a ON a.id=i.artist_id
               WHERE a.country='US'"""),
    }


# ── US-artist crawl bookkeeping ────────────────────────────────────────────


def us_tag_state(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    return {r["tag"]: r for r in conn.execute("SELECT * FROM us_tags")}


def save_us_tag(conn: sqlite3.Connection, tag: str, next_offset: int,
                exhausted: bool, total: int | None, artists: int) -> None:
    conn.execute(
        """INSERT INTO us_tags (tag, next_offset, exhausted, total, artists, updated_at)
           VALUES (?,?,?,?,?,datetime('now'))
           ON CONFLICT(tag) DO UPDATE SET
             next_offset=excluded.next_offset,
             exhausted=excluded.exhausted,
             total=COALESCE(excluded.total, us_tags.total),
             artists=us_tags.artists + excluded.artists,
             updated_at=datetime('now')""",
        (tag, next_offset, 1 if exhausted else 0, total, artists),
    )


def artists_pending(conn: sqlite3.Connection, ids: list[str]) -> list[str]:
    """Which of these US artists we have not pulled a discography for yet."""
    if not ids:
        return []
    out = []
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        q = f"SELECT artist_id FROM artist_done WHERE artist_id IN ({','.join('?' * len(chunk))})"
        seen = {r["artist_id"] for r in conn.execute(q, chunk)}
        out.extend(a for a in chunk if a not in seen)
    return out


def mark_artist_done(conn: sqlite3.Connection, artist_id: str, albums: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO artist_done (artist_id, albums) VALUES (?,?)",
        (artist_id, albums),
    )


def us_progress(conn: sqlite3.Connection) -> dict:
    one = lambda q: conn.execute(q).fetchone()[0]
    return {
        "tags": one("SELECT COUNT(*) FROM us_tags"),
        "tagsDone": one("SELECT COUNT(*) FROM us_tags WHERE exhausted=1"),
        "artistsSeen": one("SELECT COUNT(*) FROM artist_done"),
        "reachable": one("SELECT COALESCE(SUM(total),0) FROM us_tags"),
    }


# ── Spotify album resolution ───────────────────────────────────────────────


def missing_spotify_by_artist(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    """
    Unresolved albums grouped by artist, most-listened artists first.

    One Spotify search scoped to an artist returns up to 50 of their albums, so
    resolving by artist asks for 2.7x less than resolving album by album —
    107,640 requests against 39,529. That ratio is the whole reason this
    exists: two rate-limit bans, of 23 and 16 hours, came from the volume
    rather than the pace.

    Ordered by the artist's best-known record, so a run cut short by a ban has
    still covered what people are most likely to look for.
    """
    return list(conn.execute(
        """SELECT a.id AS artist_id, a.name AS artist,
                  MAX(i.listener_count) AS reach,
                  COUNT(*) AS pending
           FROM items i JOIN artists a ON a.id = i.artist_id
           WHERE i.spotify_checked_at IS NULL
           GROUP BY a.id
           ORDER BY MAX(i.exported) DESC, reach DESC
           LIMIT ?""", (limit,)))


def unresolved_for_artist(conn: sqlite3.Connection, artist_id: str) -> list[sqlite3.Row]:
    return list(conn.execute(
        """SELECT id, title FROM items
           WHERE artist_id = ? AND spotify_checked_at IS NULL""", (artist_id,)))


def missing_spotify(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    """
    Albums with no Spotify lookup yet, deployed first then most-listened.

    Same priority as ratings, for the same reason: coverage will always be
    partial, so it should cover what people can actually see.
    """
    return list(conn.execute(
        """SELECT i.id, i.title, a.name AS artist FROM items i
           JOIN artists a ON a.id = i.artist_id
           WHERE i.spotify_checked_at IS NULL
           ORDER BY i.exported DESC, i.listener_count DESC
           LIMIT ?""", (limit,)))


def set_spotify(conn: sqlite3.Connection, item_id: str, album_id: str | None) -> None:
    """Records the lookup either way, so a genuine miss is never retried forever."""
    retrying(
        conn.execute,
        """UPDATE items SET spotify_id=?, spotify_checked_at=datetime('now')
           WHERE id=?""", (album_id, item_id))
