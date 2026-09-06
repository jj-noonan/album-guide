#!/usr/bin/env python3
"""
The recommendation engine, server-side.

A port of src/engine/recommend.ts. Two implementations of one scorer is a
liability, and the only thing that makes it tolerable is that they are checked
against each other: scripts/engine-parity-check.ts scores the same albums
through both and requires the same offers, not merely similar ones.

Why port it at all. The client can only score what it holds, and it holds
12,000 of 100,931 albums. Phase 1 narrowed that by fetching candidates, but the
candidate query has to guess what the scorer will want before the scorer has
seen anything. Scoring here removes the guess: the engine considers the whole
catalog.

Constants that describe a population — axis spreads, tag informativeness — are
read from data/engine-constants.json rather than measured here. Measuring them
would make them depend on which albums each side happens to hold, which is the
fault that made popularity mean two different things across the wire.
"""
from __future__ import annotations

import json
import math
import re
import random
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LEXICON = json.loads((ROOT / "data" / "lexicon.json").read_text())
CONSTANTS = json.loads((ROOT / "data" / "engine-constants.json").read_text())

AXES: list[str] = LEXICON["axes"]
AXIS_WEIGHT: dict[str, float] = LEXICON["axisWeight"]
WEIGHT_NORM: float = LEXICON["weightNorm"]
TAG_LEXICON: dict[str, dict[str, float]] = LEXICON["lexicon"]

AXIS_SD: dict[str, float] = CONSTANTS["axisSd"]
TAG_IDF: dict[str, float] = CONSTANTS["tagIdf"]
MEAN_IDF: float = CONSTANTS["meanIdf"]
NON_MUSICAL: set[str] = set(CONSTANTS["nonMusical"])

# Mirrors TUNING in src/engine/recommend.ts.
TUNING = CONSTANTS["tuning"]

NEUTRAL_OVERLAP = 0.12


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


# Read from the shared file rather than restated, so a deliberate bump to the
# era window cannot land on one side only.
ERA_MIN: int = LEXICON["eraMin"]
ERA_MAX: int = LEXICON["eraMax"]


def era_from_year(year: int | None) -> float:
    """1950 -> 0, 2025 -> 1. Mirrors eraFromYear."""
    if year is None:
        return 0.5
    return clamp01((year - ERA_MIN) / (ERA_MAX - ERA_MIN))


def derive_vector(tags: list[dict], year: int | None) -> dict[str, float]:
    """Seven axes from tags. Mirrors deriveVector."""
    sums = {a: 0.0 for a in AXES}
    weights = {a: 0.0 for a in AXES}
    for t in tags:
        profile = TAG_LEXICON.get(str(t.get("tag", "")).lower().strip())
        if not profile:
            continue
        w = math.sqrt(max(1, t.get("count") or 1))
        for axis, value in profile.items():
            sums[axis] += value * w
            weights[axis] += w
    vector = {
        a: clamp01(sums[a] / weights[a]) if weights[a] > 0 else 0.5
        for a in AXES
    }
    vector["era"] = era_from_year(year)
    return vector


def lexicon_coverage(tags: list[dict]) -> float:
    """Share of a record's tag weight the lexicon actually knows."""
    if not tags:
        return 0.0
    known = total = 0.0
    for t in tags:
        name = str(t.get("tag", "")).lower().strip()
        # Bookkeeping does not count against knowing the music. Mirrors
        # lexiconCoverage in src/data/lexicon.ts; if the two disagree the two
        # engines score different catalogs.
        if name in NON_MUSICAL or _non_musical_re(name):
            continue
        w = math.sqrt(max(1, t.get("count") or 1))
        total += w
        if TAG_LEXICON.get(name):
            known += w
    return known / total if total > 0 else 0.0


# Mirrors the filter in src/data/catalog.ts. An album the lexicon barely knows
# derives a vector of 0.5 on every axis, which makes it look deceptively
# similar to everything, so the client drops it rather than let it pollute the
# offers. The server has to drop the same ones or the two engines are choosing
# from different catalogs and no comparison between them means anything.
MIN_COVERAGE = 0.3
# Enough understood vocabulary to place a record regardless of share. Mirrors
# the filter in src/data/catalog.ts; if the two disagree the two engines score
# different catalogs, which parity cannot catch because it compares scores on a
# pool it is handed.
MIN_KNOWN_WEIGHT = 2.0


def known_weight(tags: list[dict]) -> float:
    """Absolute weight of tags the lexicon understands."""
    w = 0.0
    for t in tags:
        name = str(t.get("tag", "")).lower().strip()
        if name in NON_MUSICAL or _non_musical_re(name):
            continue
        if TAG_LEXICON.get(name):
            w += math.sqrt(max(1, t.get("count") or 1))
    return w


def placeable(tags: list[dict]) -> bool:
    """Can the engine put this record on the axes at all?"""
    return lexicon_coverage(tags) >= MIN_COVERAGE or known_weight(tags) >= MIN_KNOWN_WEIGHT


def distance(a: dict[str, float], b: dict[str, float]) -> float:
    total = 0.0
    for axis in AXES:
        z = (a[axis] - b[axis]) / AXIS_SD[axis]
        d = z * AXIS_WEIGHT[axis]
        total += d * d
    return math.sqrt(total) / (WEIGHT_NORM * 3)


# Per-axis scaling, applied once at pool build instead of on every comparison.
_SCALE = [AXIS_WEIGHT[a] / AXIS_SD[a] for a in AXES]
_DIST_NORM = WEIGHT_NORM * 3


def scaled_vector(v: dict[str, float]) -> tuple[float, ...]:
    """
    A vector with the axis weighting and spread already folded in.

    distance divides by the axis spread and multiplies by the axis weight on
    every comparison — the same arithmetic on the same numbers, 88,887 times a
    request. Since ((a - b) / sd) * w equals (a*w/sd) - (b*w/sd), the scaling
    can be done once per album instead. Exactly equal, not approximately: the
    parity check would catch a difference in the last digit.
    """
    return tuple(v[a] * _SCALE[i] for i, a in enumerate(AXES))


def scaled_distance(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """distance() over pre-scaled vectors."""
    total = 0.0
    for x, y in zip(a, b):
        d = x - y
        total += d * d
    return math.sqrt(total) / _DIST_NORM


def musical_tags(tags: list[dict]) -> set[str]:
    """Tag names minus the bookkeeping ones. Mirrors isMusicalTag."""
    out = set()
    for t in tags:
        name = str(t.get("tag", ""))
        if name and name not in NON_MUSICAL and not _non_musical_re(name):
            out.add(name)
    return out


# Must match NON_MUSICAL_RE in src/data/catalog.ts exactly, including being a
# search rather than a match: the TypeScript uses .test(), which is unanchored,
# so re.match here silently kept tags the client dropped — "5+ wochen" among
# them — and the two engines were filtering different catalogs.
_NON_MUSICAL_RE = re.compile(
    r"^\d{4}$|charts?$|^jahrescharts|^offizielle|^top \d+$|wochen$|^\d+[–-]\d+\s",
    re.I,
)


def _non_musical_re(tag: str) -> bool:
    return bool(_NON_MUSICAL_RE.search(tag))


def idiom_overlap(a_tags: set[str], b_tags: set[str]) -> float:
    """Idf-weighted overlap coefficient, shrunk by evidence. Mirrors idiomOverlap."""
    if not a_tags or not b_tags:
        return 0.5
    small, large = (a_tags, b_tags) if len(a_tags) <= len(b_tags) else (b_tags, a_tags)
    shared_mass = 0.0
    small_mass = 0.0
    for t in small:
        w = TAG_IDF.get(t, MEAN_IDF)
        small_mass += w
        if t in large:
            shared_mass += w
    if small_mass <= 0:
        return NEUTRAL_OVERLAP
    raw = shared_mass / small_mass
    evidence = min(1.0, math.sqrt(small_mass / TUNING["evidenceFull"]))
    return raw * evidence + NEUTRAL_OVERLAP * (1 - evidence)


def hash01(s: str) -> float:
    """Mirrors hash01 in recommend.ts exactly — the same stable tie-break."""
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    # `% 100000 / 100000`, exactly as the TypeScript does it. Dividing by 2**32
    # instead gives a plausible number in the same range and a different
    # tie-break for every pair, which is a scorer that agrees on every
    # component and disagrees on every answer.
    return ((h & 0xFFFFFFFF) % 100000) / 100000.0


def fnv_state(s: str) -> int:
    """FNV-1a state after consuming a prefix, so it need not be rehashed."""
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def hash01_from(state: int, tail: bytes) -> float:
    """
    Finish a hash begun at `state`.

    hash01 was 75% of scoring time: it re-hashed the 36-character seed id for
    every one of 88,887 candidates, 19 million ord() calls per request. FNV-1a
    is a streaming hash, so the seed's contribution is computed once per call
    and only the candidate's id is walked — over precomputed bytes, which also
    removes the per-character ord(). Same arithmetic, same results; the parity
    check would catch it if not.
    """
    h = state
    for b in tail:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return ((h & 0xFFFFFFFF) % 100000) / 100000.0


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def score_candidates(
    seed: dict[str, Any],
    pool: list[dict[str, Any]],
    dial: float,
    exclude: set[str],
) -> list[dict[str, Any]]:
    """
    Score every candidate against the seed. Mirrors the loop in pickBranches.

    `seed` and pool entries carry a precomputed `vector` and `tagSet`, because
    deriving them per candidate would redo the same work for every card.
    """
    target_r = lerp(TUNING["radiusNear"], TUNING["radiusFar"], dial)
    sigma = lerp(TUNING["sigmaNear"], TUNING["sigmaFar"], dial)
    target_pop = lerp(TUNING["popularityNear"], TUNING["popularityFar"], dial)
    q_weight = lerp(TUNING["qualityWeightNear"], TUNING["qualityWeightFar"], dial)

    out = []
    seed_sv, seed_tags, seed_id = seed["sv"], seed["tagSet"], seed["id"]
    seed_artist = seed.get("artistId")
    seed_state = fnv_state(seed_id)
    pop_sigma = TUNING["popularitySigma"]
    jitter_amt = TUNING["jitter"]
    idiom_weight = TUNING["idiomWeight"]

    for item in pool:
        if item["id"] == seed_id or item["id"] in exclude:
            continue
        d = scaled_distance(seed_sv, item["sv"])
        band = math.exp(-((d - target_r) ** 2) / (2 * sigma * sigma))
        pop_gap = item["popularity"] - target_pop
        fame = math.exp(-(pop_gap * pop_gap) / (2 * pop_sigma * pop_sigma))
        merit = 1 - q_weight + (item["quality"] / 10) * q_weight * 2
        same_artist = TUNING["sameArtistPenalty"] if item.get("artistId") == seed_artist else 1
        jitter = 1 - jitter_amt + 2 * jitter_amt * hash01_from(seed_state, item["idBytes"])
        overlap = idiom_overlap(seed_tags, item["tagSet"])
        idiom = 1 - idiom_weight + idiom_weight * overlap
        combined = band * idiom
        out.append({
            "item": item,
            "d": d,
            "overlap": overlap,
            "score": combined * fame * merit * same_artist * jitter,
        })
    return out


def pick_branches(
    seed: dict[str, Any],
    pool: list[dict[str, Any]],
    dial: float,
    exclude: set[str],
) -> list[dict[str, Any]]:
    """
    Two offers for one card. Mirrors pickBranches.

    Roles split at the median idiom overlap of the candidates actually in hand,
    not a fixed threshold — among records at the right remove, 34% share half
    their tags at the near end and 3% at the far end, so any constant cutoff
    starves one role at one end of the dial.
    """
    scored = score_candidates(seed, pool, dial, exclude)
    if len(scored) < 2:
        return []

    overlaps = sorted(s["overlap"] for s in scored)
    median_ov = overlaps[len(overlaps) // 2]

    closer = [s for s in scored if s["overlap"] > median_ov]
    further = [s for s in scored if s["overlap"] <= median_ov]

    by_score = lambda s: -s["score"]  # noqa: E731
    pool_size = TUNING["poolSize"]
    a = sorted(closer, key=by_score)[:pool_size] or sorted(scored, key=by_score)[:pool_size]
    b = sorted(further, key=by_score)[:pool_size] or sorted(scored, key=by_score)[:pool_size]

    best = None
    span = TUNING["pairSearch"]
    for ca in a[:span]:
        for cb in b[:span]:
            if ca["item"]["id"] == cb["item"]["id"]:
                continue
            divergence = scaled_distance(ca["item"]["sv"], cb["item"]["sv"])
            total = ca["score"] + cb["score"] + divergence * TUNING["divergenceBonus"]
            if best is None or total > best[2]:
                best = (ca, cb, total)
    if best is None:
        return []

    return [
        {"role": "deeper", "item": best[0]["item"], "distance": best[0]["d"],
         "score": best[0]["score"]},
        {"role": "wider", "item": best[1]["item"], "distance": best[1]["d"],
         "score": best[1]["score"]},
    ]
