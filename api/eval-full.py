#!/usr/bin/env python3
"""
Evaluate the engine at the scale it actually runs at.

scripts/eval-recs.ts scores over the albums the client bundles — 11,476 of
100,931 — because that was the whole catalog the engine could see. It is not
any more. The API scores over 88,887, and every tuning constant in TUNING was
swept against the smaller pool: a Gaussian band tuned where a slice of the
catalog competes behaves differently where all of it does, and nothing has
measured which way.

Same ground truth as the TypeScript suite, same held-out split, same
bidirectional matching. The only thing that changes is the size of the pool the
engine chooses from, which is the point.

    .venv/bin/python api/eval-full.py
    .venv/bin/python api/eval-full.py --starts 8     # faster, coarser
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parent

import engine  # noqa: E402

DIALS = [0.0, 0.25, 0.5, 0.75, 1.0]


def load_pool(conn: sqlite3.Connection) -> tuple[list[dict], dict[str, dict]]:
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

    # Mirrors absolute_popularity / absolute_quality in api/server.py. Imported
    # rather than restated would be better; server.py starts a listener on
    # import, so the formulas are duplicated here and checked by api-check.
    import math

    def pop(listeners):
        return round(min(10.0, 2.0 * math.log10(1.0 + max(0, listeners or 0))), 2)

    PRIOR, CAP, PR = 7.85, 30.0, 3.4
    SLOPE = 6.0 / (math.log10(21.2) - math.log10(3.05))
    INTER = 2.0 - SLOPE * math.log10(3.05)

    def qual(listens, listeners, rating, votes):
        n = max(0, listeners or 0)
        if n == 0:
            return 4.5
        plays = min(max(0, listens or 0), CAP * n)
        d = (plays + PRIOR * 80) / (n + 80)
        votes = votes or 0
        if rating is not None and votes >= 2:
            adj = (rating * votes + PR * 6) / (votes + 6)
            d *= 1 + ((adj - PR) / 5.0) * 1.2
        return 0.0 if d <= 0 else round(max(0.0, min(10.0, SLOPE * math.log10(d) + INTER)), 2)

    pool = []
    for r in rows:
        t = tags.get(r["id"], ())
        if engine.lexicon_coverage(t) < engine.MIN_COVERAGE:
            continue
        pool.append({
            "id": r["id"], "idBytes": r["id"].encode(), "artistId": r["artist_id"],
            "popularity": pop(r["listener_count"]),
            "quality": qual(r["listen_count"], r["listener_count"],
                            r["rating"], r["rating_votes"]),
            "sv": engine.scaled_vector(engine.derive_vector(t, r["year_start"])),
            "tagSet": engine.musical_tags(t),
        })
    return pool, {p["id"]: p for p in pool}


_SHARED: dict = {}


def _init_worker(pool, graph, tuning):
    """Each process gets one copy of the pool; it is read-only."""
    _SHARED["pool"] = pool
    _SHARED["graph"] = graph
    engine.TUNING.update(tuning)


def _eval_seed(job):
    """One seed's offers across every dial. Returns counts, not objects."""
    seed_id, accepted, held, starts, dials = job
    pool = _SHARED["pool"]
    graph = _SHARED["graph"]

    def knows(a, b):
        return b in graph.get(a, ()) or a in graph.get(b, ())

    per_dial = {d: [0, 0] for d in dials}
    quals = {d: [] for d in dials}
    offered = set()
    near = [0, 0]
    for start in starts:
        for dial in dials:
            for b in engine.pick_branches(start, pool, dial, {start["id"]}):
                a = b["item"]["artistId"]
                ok = bool(a) and (a in accepted or a == seed_id or knows(seed_id, a))
                per_dial[dial][1] += 1
                quals[dial].append(b["item"]["quality"])
                offered.add(b["item"]["id"])
                if ok:
                    per_dial[dial][0] += 1
                if dial == 0.0:
                    near[1] += 1
                    if ok:
                        near[0] += 1
    return seed_id, held, per_dial, quals, offered, near


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--starts", type=int, default=20)
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                    help="override a TUNING constant for this run, e.g. --set jitter=0.3")
    ap.add_argument("--min-quality", type=float, default=0.0,
                    help="score only albums at or above this quality. A quality "
                         "floor, deliberately not a popularity floor: quality is "
                         "devotion, so a low score means people tried it and did "
                         "not return, while low popularity is the obscurity this "
                         "app exists to reach into.")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--limit-pool", type=int, default=0,
                    help="score against only the N most-listened albums, to "
                         "compare like with like against the bundled suite")
    args = ap.parse_args()

    for kv in args.set:
        k, v = kv.split("=", 1)
        if k not in engine.TUNING:
            print(f"unknown tuning key {k!r}", file=sys.stderr)
            return 1
        engine.TUNING[k] = float(v)
        print(f"override: {k} = {engine.TUNING[k]}")

    fx = json.loads((ROOT / "data" / "similar-artists.json").read_text())
    graph = {}
    gp = ROOT / "data" / "similarity-graph.json"
    if gp.exists():
        graph = {k: set(v) for k, v in json.loads(gp.read_text())["edges"].items()}

    def knows(a: str, b: str) -> bool:
        return b in graph.get(a, ()) or a in graph.get(b, ())

    conn = sqlite3.connect(f"file:{ROOT/'data'/'catalog-api.sqlite'}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    pool, by_id = load_pool(conn)

    if args.min_quality > 0:
        before = len(pool)
        pool = [p for p in pool if p["quality"] >= args.min_quality]
        by_id = {p["id"]: p for p in pool}
        print(f"quality floor {args.min_quality}: {before:,} -> {len(pool):,} albums")

    if args.limit_pool:
        pool = sorted(pool, key=lambda p: -p["popularity"])[: args.limit_pool]
        by_id = {p["id"]: p for p in pool}
    print(f"pool: {len(pool):,} albums")

    by_artist: dict[str, list[dict]] = {}
    for p in pool:
        if p["artistId"]:
            by_artist.setdefault(p["artistId"], []).append(p)

    group = {"tuning": [0, 0], "held": [0, 0]}
    per_dial = {d: [0, 0] for d in DIALS}
    per_seed: dict[str, list] = {}
    qual_by_dial: dict[float, list[float]] = {d: [] for d in DIALS}
    offered: set[str] = set()
    offers_made = 0

    jobs = []
    names = {}
    for seed_id, seed in fx["seeds"].items():
        starts = by_artist.get(seed_id, [])[: args.starts]
        if not starts:
            continue
        names[seed_id] = (seed["name"], "held" if seed.get("heldOut") else "tuning")
        jobs.append((seed_id, {s["mbid"] for s in seed["similar"]},
                     bool(seed.get("heldOut")), starts, DIALS))

    import multiprocessing as mp
    workers = args.workers or max(1, mp.cpu_count() - 2)
    print(f"scoring {len(jobs)} seeds across {workers} workers")
    with mp.Pool(workers, initializer=_init_worker,
                 initargs=(pool, graph, dict(engine.TUNING))) as mpool:
        for seed_id, held, pd, qs, off, near in mpool.imap_unordered(_eval_seed, jobs):
            name, bucket = names[seed_id]
            for d in DIALS:
                per_dial[d][0] += pd[d][0]
                per_dial[d][1] += pd[d][1]
                qual_by_dial[d].extend(qs[d])
                offers_made += pd[d][1]
            offered |= off
            group[bucket][0] += near[0]
            group[bucket][1] += near[1]
            per_seed[name] = [near[0], near[1], bucket]

    # Chance, computed the same way the hits are counted — including reverse
    # graph matches, or the baseline would be narrower than the test and the
    # lift would be manufactured.
    #
    # This matters more here than in the bundled suite. Raw agreement is lower
    # at full scale simply because a seed's neighbours are a smaller share of
    # 88,887 than of 11,476; without a baseline the drop reads as the engine
    # getting worse when it may be the opposite.
    by_artist_count: dict[str, int] = {}
    for p_ in pool:
        if p_["artistId"]:
            by_artist_count[p_["artistId"]] = by_artist_count.get(p_["artistId"], 0) + 1
    chances = []
    for seed_id, seed in fx["seeds"].items():
        if seed_id not in by_artist:
            continue
        acc = {s["mbid"] for s in seed["similar"]}
        for other in list(by_artist_count):
            if other not in acc and knows(seed_id, other):
                acc.add(other)
        reachable = sum(by_artist_count.get(a, 0) for a in acc) + by_artist_count.get(seed_id, 0)
        chances.append(reachable / max(1, len(pool)))
    chance = sum(chances) / max(1, len(chances))

    print("\nagreement by terrain setting:")
    for d in DIALS:
        hits, tot = per_dial[d]
        bar = "#" * round(60 * hits / max(1, tot))
        print(f"  dial {d:.2f}  {hits:5}/{tot:<5} {100*hits/max(1,tot):5.1f}%  {bar}")

    def rate(g):
        return 100 * g[0] / max(1, g[1])

    def interval(g) -> tuple[float, float]:
        """
        Wilson score interval, 95%.

        Every proportion here is a handful of hundreds of offers, and I read a
        4.8-point difference between two held-out batches as a finding when it
        was inside the noise of both. Printing the interval next to the number
        makes that mistake take deliberate effort rather than inattention.

        Wilson rather than the normal approximation because these proportions
        sit far enough from 0.5, on samples small enough, that the simple
        formula is visibly wrong at the edges.
        """
        n, k = g[1], g[0]
        if n == 0:
            return (0.0, 0.0)
        z = 1.96
        phat = k / n
        denom = 1 + z * z / n
        centre = (phat + z * z / (2 * n)) / denom
        half = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom
        return (100 * (centre - half), 100 * (centre + half))

    print("\nnear-end agreement by seed group:")
    tlo, thi = interval(group['tuning'])
    print(f"  tuning seeds   {rate(group['tuning']):5.1f}%  "
          f"({group['tuning'][0]}/{group['tuning'][1]})  95% CI {tlo:.1f}-{thi:.1f}")
    # Held-out is a gate, not a target.
    #
    # Sweeping a constant and picking whichever value maximises this number
    # turns the held-out set into a second tuning set, one slow read at a time.
    # The discipline is: optimise on tuning seeds, then require that held-out
    # agrees before taking the change. A value that wins here and not there is
    # noise; a value that wins there and loses here is overfitting.
    lo, hi = interval(group['held'])
    print(f"  HELD OUT       {rate(group['held']):5.1f}%  "
          f"({group['held'][0]}/{group['held'][1]})  "
          f"95% CI {lo:.1f}-{hi:.1f}  <- the number to trust")
    print(f"                 a change is only a result if it clears "
          f"+/-{(hi - lo) / 2:.1f} points")
    print(f"  gap            {rate(group['tuning']) - rate(group['held']):+.1f} points")
    print(f"\n  chance         {100*chance:5.2f}%  (mean share of the pool that counts as a hit)")
    print(f"  LIFT held-out  {rate(group['held']) / max(1e-9, 100*chance):5.1f}x")
    print(f"  LIFT overall   {100*per_dial[0.0][0]/max(1,per_dial[0.0][1]) / max(1e-9, 100*chance):5.1f}x")

    med = lambda xs: statistics.median(xs) if xs else 0  # noqa: E731
    cat_q = med([p["quality"] for p in pool])
    print(f"\noffered quality by dial (catalog median {cat_q:.1f}):")
    for d in DIALS:
        print(f"  dial {d:.2f}  {med(qual_by_dial[d]):5.1f}  "
              f"{med(qual_by_dial[d]) - cat_q:+.1f}")

    print(f"\nreach: {len(offered):,} distinct albums offered of {len(pool):,} "
          f"({100*len(offered)/len(pool):.1f}%), "
          f"{offers_made/max(1,len(offered)):.1f}x repeats over {offers_made:,} offers")

    print("\nweakest seeds at the near end:")
    ranked = sorted(per_seed.items(), key=lambda kv: kv[1][0] / max(1, kv[1][1]))
    for name, (h, t, b) in ranked[:8]:
        print(f"  {name:<24} {h:3}/{t:<3} {100*h/max(1,t):5.1f}%  {'[held out]' if b=='held' else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
