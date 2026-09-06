#!/usr/bin/env python3
"""
SQLite -> catalog.json for the browser app.

A stopgap by design: the app loads the whole catalog into the bundle, which
stops being viable in the tens of thousands. Until the API exists, the export
is capped and takes the most-listened albums, so a huge crawl still yields a
usable app instead of an unloadable one.

  python3 scripts/export_catalog.py --limit 12000
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


CAA_PREFIX = "https://coverartarchive.org/release/"


def art_path(url: str | None) -> str | None:
    """Strip the shared prefix and the size suffix; the client re-adds both."""
    if not url or not url.startswith(CAA_PREFIX):
        return url
    rest = url[len(CAA_PREFIX):]
    for suffix in ("-500.jpg", "-250.jpg", "-1200.jpg", ".jpg"):
        if rest.endswith(suffix):
            return rest[: -len(suffix)]
    return rest


PRIOR_RATING = 3.4  # catalog-wide expectation for an unrated record


def absolute_popularity(listeners: int | None) -> float:
    """
    Listeners on a fixed 0-10 scale, independent of any population.

    Shared with the API in api/server.py; the two must agree exactly or the
    engine's popularity targets mean different things either side of the wire.
    """
    import math
    return round(min(10.0, 2.0 * math.log10(1.0 + max(0, listeners or 0))), 2)


def percentile_rank(raw: dict[str, float]) -> dict[str, float]:
    """Map values to 0..10 by rank. Negatives mean "unknown" and stay at 0."""
    known = sorted((v, k) for k, v in raw.items() if v >= 0)
    n = max(1, len(known) - 1)
    out = {k: 0.0 for k in raw}
    for i, (_, k) in enumerate(known):
        out[k] = round((i / n) * 10, 1)
    return out


def scores(rows) -> dict[str, tuple[float, float]]:
    """
    Two 0-10 scores per album: popularity, then quality.

    Popularity is distinct listeners, not plays — plays are dominated by
    whoever put a record on two hundred times, while the number of separate
    people who reached for it is what the word actually means.

    Quality blends two things:

      devotion — listens per listener. It cleanly separates records people
        return to from records people tried once: Burial's Untrue scores 48
        plays per listener against Skrillex's 9.9, despite similar totals. It
        is shrunk toward the catalog mean by listener count, so an album with
        one obsessive listener doesn't outrank a classic.

      rating — the MusicBrainz community score, where it exists. Authoritative
        but sparse and expensive to collect, so it is a bonus on top of
        devotion rather than the basis.

    Both are percentile-ranked, which self-calibrates as the catalog grows and
    always spans the full range.
    """
    import statistics

    devotions = []
    for r in rows:
        listeners = r["listener_count"] or 0
        if listeners >= 5:
            devotions.append(min(DEVOTION_CAP, (r["listen_count"] or 0) / listeners))
    prior = statistics.median(devotions) if devotions else 8.0

    raw_pop: dict[str, float] = {}
    raw_q: dict[str, float] = {}
    for r in rows:
        listeners = r["listener_count"]
        listens = r["listen_count"] or 0
        raw_pop[r["id"]] = float(listeners) if listeners is not None else -1.0

        if listeners:
            # Cap first, then shrink: the two do different jobs. The cap removes
            # impossible ratios; the shrink withholds trust until enough people
            # have actually listened.
            listens = min(listens, DEVOTION_CAP * listeners)
            # Bayesian shrink toward the catalog median.
            #
            # k was 12, which trusted the ratio far too readily: an album with
            # 28 listeners kept 70% of its observed devotion and could score a
            # perfect 10 — 1,588 albums scored 9.5+ on fewer than 100 listeners,
            # a third of everything the engine considered excellent. Devotion is
            # a ratio, and a ratio over 28 people is noise, not acclaim.
            #
            # At k=80 an album needs a few hundred listeners before its own
            # ratio outweighs the catalog's: 28 listeners keeps 26%, 500 keeps
            # 86%. Records that are genuinely beloved still rise; records nobody
            # has heard no longer arrive pre-crowned.
            k = 80
            devotion = (listens + prior * k) / (listeners + k)
        else:
            devotion = prior * 0.6  # unknown reads slightly below average

        rating, votes = r["rating"], r["rating_votes"] or 0
        if rating is not None and votes >= 2:
            # Same shrink for a 5-star score with few votes.
            adj = (rating * votes + PRIOR_RATING * 6) / (votes + 6)
            # Centred on the prior, so an average rating is worth exactly 1.0.
            #
            # The earlier curve bottomed out at 0.65 and passed 1.0 well below
            # the median, which made *having* a rating a bonus in itself — 634
            # deployed albums gained more than a point of quality and not one
            # lost any. Since well-known records are far likelier to be rated,
            # that quietly smuggled popularity back into the quality score,
            # which is the bias this app exists to avoid. Now only the value
            # moves the needle: above the prior lifts, below it cuts.
            devotion *= 1 + ((adj - PRIOR_RATING) / 5.0) * 1.2
        raw_q[r["id"]] = devotion

    def percentiles(raw: dict[str, float]) -> dict[str, float]:
        known = sorted((v, k) for k, v in raw.items() if v >= 0)
        n = max(1, len(known) - 1)
        out = {k: 0.0 for k in raw}
        for i, (_, k) in enumerate(known):
            out[k] = round((i / n) * 10, 1)
        return out

    pop = percentiles(raw_pop)
    qual = percentiles(raw_q)
    return {k: (pop[k], qual[k]) for k in raw_pop}


# Share of the export reserved for artists confirmed to be from the US.
# Not a hard filter: several corridors are non-US lineages by definition
# (krautrock, Tropicália, ethio-jazz), and cutting them entirely would leave
# those roads with nothing on them. A strong majority plus intact lineages
# beats a pure-US catalog that can't branch.
US_SHARE = 0.72
# Artists whose origin MusicBrainz doesn't record are not the same as foreign
# ones — they get the remainder ahead of confirmed-elsewhere.
UNKNOWN_SHARE = 0.13

# Share of each origin group reserved for its most-listened albums outright.
#
# Without this the export dropped every one of the twelve biggest records it
# held — To Pimp a Butterfly, good kid m.A.A.d city, My Beautiful Dark Twisted
# Fantasy. Deciles are assigned by popularity but ranked internally by quality,
# and quality is devotion: listens per listener. A hit with devotion 19 loses
# its slot to a cult record with devotion 45, every time. Reserving a slice for
# raw reach is what keeps recognisable records in a catalog that otherwise
# selects relentlessly for the beloved-and-obscure.
ANCHOR_FRACTION = 0.18

# Devotion above this many plays per listener is treated as an artefact, not
# acclaim. The catalog's median is 7.6 and its 90th percentile 20.6, but the tail
# runs to 1,782 — 23,169 plays from thirteen people. That is a looping scrobbler,
# and shrinkage cannot rescue an observed value two hundred times the prior, so
# the ratio is capped before it is ever blended.
DEVOTION_CAP = 30.0


def origin_of(row) -> str:
    c = row["artist_country"]
    if c == "US":
        return "us"
    return "unknown" if c is None else "foreign"


def select(rows, score: dict[str, tuple[float, float]], limit: int | None):
    """
    Choose which albums make it into the capped export.

    Not simply the most-listened. Taking the top N by reach quietly truncates
    the whole obscure half of the catalog — and the far end of the terrain dial
    aims squarely at that half, so the app would ask for deep cuts it no longer
    contained. Instead: sample across all ten popularity deciles, tilted
    modestly toward the well-known because those are also what people search
    for, keeping the tail genuinely represented.

    Within each decile the highest-quality records win the slots, so a smaller
    export is a better one rather than merely a shorter one.
    """
    if not limit or len(rows) <= limit:
        return list(rows)

    # Split the budget by origin first, then stratify popularity inside each
    # group — so weighting toward the US doesn't quietly undo the decile
    # balance that keeps the far end of the terrain dial supplied.
    groups: dict[str, list] = {"us": [], "unknown": [], "foreign": []}
    for r in rows:
        groups[origin_of(r)].append(r)

    budget = {
        "us": round(limit * US_SHARE),
        "unknown": round(limit * UNKNOWN_SHARE),
    }
    budget["foreign"] = limit - budget["us"] - budget["unknown"]

    # A group that can't fill its share hands the surplus on rather than
    # shrinking the export.
    surplus = 0
    for key in ("us", "unknown", "foreign"):
        if len(groups[key]) < budget[key]:
            surplus += budget[key] - len(groups[key])
            budget[key] = len(groups[key])
    for key in ("us", "unknown", "foreign"):
        room = len(groups[key]) - budget[key]
        take = min(surplus, room)
        budget[key] += take
        surplus -= take

    out = []
    for key, members in groups.items():
        take = budget[key]
        if take <= 0 or not members:
            continue
        # Anchors first: the plainly most-listened records in this group.
        n_anchor = min(int(take * ANCHOR_FRACTION), len(members))
        anchors = sorted(
            members, key=lambda r: r["listener_count"] or 0, reverse=True
        )[:n_anchor]
        picked = {r["id"] for r in anchors}
        out.extend(anchors)
        # The remainder keeps the decile spread, so the terrain dial still has
        # material at every distance.
        rest = [r for r in members if r["id"] not in picked]
        out.extend(_by_decile(rest, take - len(anchors), score))

    # Rounding can leave slack; fill it with the best of what's left over.
    if len(out) < limit:
        chosen = {r["id"] for r in out}
        rest = sorted(
            (r for r in rows if r["id"] not in chosen),
            key=lambda r: score[r["id"]][1], reverse=True,
        )
        out.extend(rest[: limit - len(out)])
    return out[:limit]


def _by_decile(members, take: int, score) -> list:
    """Stratify one origin group across popularity deciles, best quality first."""
    if take <= 0 or not members:
        return []
    if len(members) <= take:
        return list(members)

    by_decile: dict[int, list] = {i: [] for i in range(10)}
    for r in members:
        by_decile[min(9, int(score[r["id"]][0]))].append(r)

    # 0.7 at the bottom rising to 1.3 at the top.
    weights = [0.7 + (i / 9) * 0.6 for i in range(10)]
    live = [i for i in range(10) if by_decile[i]]
    total = sum(weights[i] for i in live) or 1.0

    picked = []
    for i in live:
        n = round(take * weights[i] / total)
        ranked = sorted(by_decile[i], key=lambda r: score[r["id"]][1], reverse=True)
        picked.extend(ranked[:n])

    if len(picked) < take:
        chosen = {r["id"] for r in picked}
        rest = sorted((r for r in members if r["id"] not in chosen),
                      key=lambda r: score[r["id"]][1], reverse=True)
        picked.extend(rest[: take - len(picked)])
    return picked[:take]


def export(conn: sqlite3.Connection, out: Path, limit: int | None = None) -> dict:
    all_rows = conn.execute("""
        SELECT i.id, i.title, i.artist_id, i.year_start, i.art_url, i.art_thumb_url,
               i.listen_count, i.listener_count, i.rating, i.rating_votes, i.spotify_id,
               a.name AS artist_name, a.country AS artist_country
        FROM items i LEFT JOIN artists a ON a.id = i.artist_id
        WHERE i.art_url IS NOT NULL
          -- No tags means no vector: the client derives every axis from them
          -- and drops such albums anyway, so including one only wastes a slot.
          AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)
          -- Tempting to go further and drop albums the engine rarely offers
          -- — under ~28 listeners, or fewer than three tags — since a short
          -- walk never surfaces them and they appear to be dead weight. It was
          -- tried and measured, and it makes the catalog worse: distinct
          -- albums reachable over a 76,000-offer walk fell from 3,236 to
          -- 3,040, and over a short one from 1,895 to 1,727.
          --
          -- The thin tail is not wasted. Individually each of those records
          -- almost never wins, but collectively they are a large pool of
          -- occasional winners, and replacing them with more mid-catalog
          -- albums just adds competition to a band that is already crowded.
          -- Rarely offered is not the same as never offered, and only the
          -- second is dead weight.
    """).fetchall()

    # Score against the whole catalog, so percentiles mean the same thing
    # regardless of what the export happens to keep.
    score = scores(all_rows)
    rows = select(all_rows, score, limit)
    keep = {r["id"] for r in rows}

    # Re-rank both scores over the albums actually shipped.
    #
    # The scores above are percentiles over the whole database, which is the
    # right basis for *choosing* what to ship — but the export deliberately
    # over-samples the popular end, so those percentiles do not describe the
    # catalog the engine ends up with. Measured on the last export, 24% of
    # shipped albums landed in a single popularity bucket spanning 786 to
    # 10,711 listeners, and the engine cannot tell apart records that differ
    # by 13x in reach.
    #
    # That broke the dial rather than merely blurring it. Aiming at 8.4 for a
    # close pick, Nirvana's Nevermind (10.0) was further from target than a
    # record with 1,079 listeners (9.2) — so the fame term actively preferred
    # the middle of the pack to the records people know.
    #
    # Selection uses database ranks; the shipped numbers are ranks within the
    # shipped set, so 0..10 spans the catalog the engine can actually see.
    # Popularity is absolute, not a rank.
    #
    # It was a percentile, and a percentile describes a population rather than
    # a record: the same album scored differently depending on what it was
    # exported alongside. Ranking over the database put 24% of shipped albums
    # in one bucket spanning 786 to 10,711 listeners; ranking over the export
    # fixed that and created a subtler version of the same problem, because the
    # API serves 100,931 albums and the client ships 12,000, so "popularity
    # 9.8" meant ~12,000 listeners to one and ~620 to the other. Every fix that
    # keeps percentiles just moves which population it is wrong about.
    #
    # 2*log10(1+listeners) is stable by construction. 1,000 listeners is 6.0
    # here, in the export, in the API, and in a catalog ten times this size.
    # Log because reach is multiplicative — the interesting gap between 100 and
    # 1,000 listeners is the same size as the one between 10,000 and 100,000.
    ranked_qual = percentile_rank({r["id"]: score[r["id"]][1] for r in rows})
    score = {
        r["id"]: (absolute_popularity(r["listener_count"]), ranked_qual[r["id"]])
        for r in rows
    }

    tags: dict[str, list] = defaultdict(list)
    for r in conn.execute("SELECT item_id, tag, count FROM item_tags"):
        if r["item_id"] in keep:
            tags[r["item_id"]].append({"tag": r["tag"], "count": r["count"]})

    corridors: dict[str, list] = defaultdict(list)
    for r in conn.execute("SELECT item_id, corridor_id FROM item_corridors"):
        if r["item_id"] in keep:
            corridors[r["item_id"]].append(r["corridor_id"])

    albums = [{
        "id": r["id"], "title": r["title"], "artistId": r["artist_id"],
        "artistName": r["artist_name"] or "", "year": r["year_start"],
        # Just the path, not the URL. Every cover lives under the same Cover Art
        # Archive prefix, and the 500px and 250px variants differ only by a
        # suffix — so storing two full URLs per album repeated ~36 identical
        # characters 24,000 times. The client rebuilds both from this.
        "art": art_path(r["art_url"]),
        "tags": tags.get(r["id"], []), "corridorIds": corridors.get(r["id"], []),
        "listenCount": r["listen_count"],
        "listenerCount": r["listener_count"],
        "country": r["artist_country"],
        "rating": r["rating"],
        "spotifyId": r["spotify_id"],
        "popularity": score[r["id"]][0],
        "quality": score[r["id"]][1],
    } for r in rows]

    artist_ids = {a["artistId"] for a in albums if a["artistId"]}
    artists = [{
        "id": r["id"], "name": r["name"], "sortName": r["sort_name"],
        "country": r["country"], "beganYear": r["began_year"], "endedYear": r["ended_year"],
    } for r in conn.execute("SELECT * FROM artists") if r["id"] in artist_ids]

    done = [r["corridor_id"] for r in conn.execute(
        """SELECT corridor_id FROM crawl_tags WHERE done_at IS NOT NULL
           GROUP BY corridor_id""")]

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "stats": {
            "albums": len(albums), "artists": len(artists),
            "withArt": sum(1 for a in albums if a["art"]),
            "corridorsComplete": sorted(done),
            "totalInDb": db.stats(conn)["albums"],
        },
        "artists": artists, "albums": albums,
    }
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    tmp.replace(out)  # atomic: the dev server never reads a half-written file

    # Record what shipped, so the ratings pass can target exactly this set.
    # Deliberately after the file is on disk: this is bookkeeping, and a write
    # conflict here must never cost us the export.
    try:
        conn.execute("UPDATE items SET exported = 0 WHERE exported IS NOT 0")
        conn.executemany(
            "UPDATE items SET exported = 1 WHERE id = ?", [(r["id"],) for r in rows]
        )
        conn.commit()
    except sqlite3.OperationalError as e:
        print(f"  (could not mark exported set: {e})")

    return payload["stats"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(db.DEFAULT_DB))
    ap.add_argument("--out", default=str(ROOT / "src" / "data" / "catalog.json"))
    ap.add_argument("--limit", type=int, default=12000)
    args = ap.parse_args()

    conn = db.connect(args.db)
    db.init(conn)
    stats = export(conn, Path(args.out), args.limit or None)
    print(f"exported {stats['albums']} of {stats['totalInDb']} albums -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
