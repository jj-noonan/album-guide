#!/usr/bin/env python3
"""
Resolve albums to exact Spotify IDs so the Play button opens the record itself.

Until now both streaming buttons opened a *search page*. MusicBrainz does hold
Spotify links, but on releases rather than release groups — two extra requests
per album, roughly 35 hours for this catalog. Apple's free iTunes API tops out
around 55% verified matches and cannot be tuned past it: searching "Pink Floyd
The Dark Side of the Moon" returns The Wall, Wish You Were Here and Meddle, but
never Dark Side, at any result depth.

Spotify's own search, with client credentials, resolves the album directly.

Matching is verified rather than trusted. A bare search happily returns a
different record by the same artist, and a confident link to the wrong album is
worse than an honest search page — so a result is only accepted when both the
album title and the artist line up after normalisation.

Credentials come from .env, which is gitignored. They stay server-side; the
deployed site only ever receives resolved URLs.

  python3 scripts/resolve_spotify.py 20000
"""
from __future__ import annotations

import base64
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import db  # noqa: E402


def safe_commit(conn) -> None:
    """Commit, waiting out another writer rather than dying on it."""
    db.retrying(conn.commit)

load_dotenv(HERE.parent / ".env")
TOKEN_URL = "https://accounts.spotify.com/api/token"
SEARCH_URL = "https://api.spotify.com/v1/search"

LONG_BAN = 300  # seconds; beyond this we stop rather than poll a ban


class RateLimited(RuntimeError):
    """Raised when Spotify imposes a ban too long to wait out."""

    def __init__(self, seconds: int):
        super().__init__(f"Spotify rate limit for {seconds}s ({seconds/3600:.1f}h)")
        self.seconds = seconds


_token: dict = {"value": None, "expires": 0.0}

# Spotify's limit is a rolling window of roughly 180 requests/minute. Running at
# 3/sec sat exactly on that ceiling and eventually drew a long Retry-After.
# Spotify's published guidance is vague, and the real limit is far stricter than
# the commonly-cited ~180/minute. Running at 3/sec drew a 82,646-second ban —
# 23 hours — so this is deliberately conservative. Throughput is not the
# constraint that matters here; staying un-banned is.
# 2.0s, not 1.2.
#
# Two bans so far, of 23 and 16 hours, both while pacing well under Spotify's
# documented limit — a development-mode app has a much smaller allowance than
# the published figure, and the real constraint turned out to be total volume
# rather than instantaneous rate. Grouping by artist cut the volume 2.7x;
# halving the rate on top costs another nine hours of unattended running and
# is worth it against losing a day to a third ban.
# Ten, not the documented fifty.
#
# Spotify's search caps `limit` at 50 in the reference and rejects anything
# above 10 for this app with "Invalid limit" — an undocumented restriction that
# comes with development mode. Worth knowing before the extension request is
# approved, because the page size triples on the far side of it.
PAGE = 10
# How many pages to ask for before giving up on an artist. Search returns
# albums by relevance rather than exhaustively, so a prolific artist's less
# famous records sit past the first page. Three costs 2,368 requests across the
# whole catalog against one, and finds records one page would miss.
MAX_PAGES = 3

MIN_INTERVAL = 2.0
_last_call = [0.0]


def paced() -> None:
    wait = MIN_INTERVAL - (time.time() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()


def token() -> str:
    """Client-credentials token, refreshed a minute before it lapses."""
    if _token["value"] and time.time() < _token["expires"] - 60:
        return _token["value"]
    cid = os.environ["SPOTIFY_CLIENT_ID"]
    sec = os.environ["SPOTIFY_CLIENT_SECRET"]
    auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    r = requests.post(TOKEN_URL, data={"grant_type": "client_credentials"},
                      headers={"Authorization": f"Basic {auth}"}, timeout=25)
    r.raise_for_status()
    d = r.json()
    _token["value"] = d["access_token"]
    _token["expires"] = time.time() + d.get("expires_in", 3600)
    return _token["value"]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    # Editions differ between services and shouldn't block a match.
    s = re.sub(r"\b(deluxe|remaster(ed)?|expanded|edition|version|anniversary|"
               r"reissue|bonus|track[s]?|explicit|mono|stereo)\b", " ", s)
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def accepts(want_title: str, want_artist: str, got_title: str, got_artist: str) -> bool:
    wt, gt = norm(want_title), norm(got_title)
    wa, ga = norm(want_artist), norm(got_artist)
    if not wt or not gt or not wa or not ga:
        return False
    title_ok = wt == gt or gt.startswith(wt) or wt.startswith(gt)
    artist_ok = wa == ga or wa in ga or ga in wa
    return title_ok and artist_ok


def artist_albums(artist: str, offset: int = 0) -> list[dict] | None:
    """
    Up to 50 of an artist's albums in one search.

    The resolver used to search per album: 107,640 requests for this catalog,
    which earned two rate-limit bans of 23 and 16 hours. Spotify's search takes
    an artist-scoped query and returns a page of their albums, so the same work
    costs 39,529 requests — 2.7x less — and the matching happens here rather
    than being paid for in round trips.

    Returns None on a transport failure, distinct from an empty list, which
    means the artist genuinely has nothing.
    """
    q = f'artist:"{artist}"'
    for attempt in range(4):
        paced()
        try:
            r = requests.get(SEARCH_URL,
                             params={"q": q, "type": "album",
                                     "limit": PAGE, "offset": offset},
                             headers={"Authorization": f"Bearer {token()}"}, timeout=25)
        except requests.RequestException:
            time.sleep(1 + attempt)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "2"))
            if wait > LONG_BAN:
                raise RateLimited(wait)
            print(f"  rate limited, waiting {wait + 1}s", flush=True)
            time.sleep(wait + 1)
            continue
        if r.status_code == 401:
            _token["value"] = None
            continue
        if r.status_code != 200:
            return None
        return r.json().get("albums", {}).get("items", [])
    return None


def match_albums(wanted: list, candidates: list[dict], artist: str) -> dict[str, str]:
    """
    Pair our albums with Spotify's, by the same rules as before.

    Matching locally rather than per request is the point of the rewrite, and
    the acceptance test is unchanged: a title and an artist must both agree, so
    a near-miss stays unresolved rather than sending someone to the wrong
    record. A wrong link is worse than a search page.
    """
    out: dict[str, str] = {}
    for row in wanted:
        for a in candidates:
            names = ", ".join(x["name"] for x in a.get("artists", []))
            if accepts(row["title"], artist, a.get("name", ""), names):
                out[row["id"]] = a["id"]
                break
    return out


def resolve(title: str, artist: str) -> str | None:
    q = f'album:"{title}" artist:"{artist}"'
    for attempt in range(4):
        paced()
        try:
            r = requests.get(SEARCH_URL, params={"q": q, "type": "album", "limit": 10},
                             headers={"Authorization": f"Bearer {token()}"}, timeout=25)
        except requests.RequestException:
            time.sleep(1 + attempt)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "2"))
            if wait > LONG_BAN:
                # A ban measured in hours is not something to wait out or retry
                # into — continuing to poll during one can extend it. Stop, and
                # let the run resume later; every lookup so far is committed.
                raise RateLimited(wait)
            print(f"  rate limited, waiting {wait + 1}s", flush=True)
            time.sleep(wait + 1)
            continue
        if r.status_code == 401:
            _token["value"] = None
            continue
        if r.status_code != 200:
            return None
        for a in r.json().get("albums", {}).get("items", []):
            names = ", ".join(x["name"] for x in a.get("artists", []))
            if accepts(title, artist, a.get("name", ""), names):
                return a["id"]
        return None
    return None


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    conn = db.connect()
    db.init(conn)
    artists = db.missing_spotify_by_artist(conn, limit)
    pending = sum(a["pending"] for a in artists)
    print(f"resolving {pending:,} albums across {len(artists):,} artists "
          f"({pending / max(1, len(artists)):.1f} per request)", flush=True)

    hit = checked = 0
    start_t = time.time()
    for n, art in enumerate(artists, 1):
        wanted = db.unresolved_for_artist(conn, art["artist_id"])
        if not wanted:
            continue
        try:
            # Page only while something is still unmatched. Most artists have a
            # handful of records and are done after one request.
            candidates: list[dict] = []
            found: dict[str, str] = {}
            for page in range(MAX_PAGES):
                got = artist_albums(art["artist"], offset=page * PAGE)
                if got is None:
                    candidates = None  # type: ignore[assignment]
                    break
                if not got:
                    break
                candidates.extend(got)
                found = match_albums(wanted, candidates, art["artist"])
                if len(found) >= len(wanted) or len(got) < PAGE:
                    break
        except RateLimited as e:
            print(f"\nstopping: {e}")
            print(f"resolved {hit:,} of {checked:,} checked; rerun after it lifts.")
            safe_commit(conn)
            return 2

        # A transport failure is not evidence about the album. Leave those
        # unchecked so a later run retries them, rather than marking them
        # resolved-to-nothing and never looking again.
        if candidates is None:
            continue

        for row in wanted:
            db.set_spotify(conn, row["id"], found.get(row["id"]))
            checked += 1
        hit += len(found)
        safe_commit(conn)

        if n % 200 == 0:
            rate = n / max(1e-6, time.time() - start_t)
            print(f"  {n:,}/{len(artists):,} artists — {hit:,}/{checked:,} albums matched "
                  f"({100*hit/max(1,checked):.0f}%, {rate:.1f} artists/sec)", flush=True)

    safe_commit(conn)
    total = conn.execute("SELECT COUNT(*) FROM items WHERE spotify_id IS NOT NULL").fetchone()[0]
    print(f"done: {hit:,}/{checked:,} matched; {total:,} albums now have a Spotify link")
    return 0


if __name__ == "__main__":
    sys.exit(main())
