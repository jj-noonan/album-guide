#!/usr/bin/env python3
"""
Do both engines make the same decision?

Two implementations of one scorer are only tolerable if they are checked
against each other, and "similar offers" is not a check — a subtly wrong port
gives plausible answers indefinitely. This requires the same album ids, in the
same roles, for the same seeds, at every dial setting.

    npx vite-node scripts/engine-parity.ts     # what TypeScript decided
    .venv/bin/python api/parity-check.py       # does Python agree
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import engine  # noqa: E402

ROOT = HERE.parent
EXPECTED = json.loads((ROOT / "data" / "parity-ts.json").read_text())
CATALOG = json.loads((ROOT / "src" / "data" / "catalog.json").read_text())


def build_pool() -> tuple[list[dict], dict[str, dict]]:
    """The same albums the client holds, shaped as the Python engine wants."""
    pool = []
    for a in CATALOG["albums"]:
        tags = a.get("tags") or []
        if engine.lexicon_coverage(tags) < engine.MIN_COVERAGE:
            continue
        item = {
            "id": a["id"],
            "idBytes": a["id"].encode(),
            "artistId": a.get("artistId"),
            "popularity": a.get("popularity", 5.0),
            "quality": a.get("quality", 4.5),
            "vector": engine.derive_vector(tags, a.get("year")),
            "sv": engine.scaled_vector(engine.derive_vector(tags, a.get("year"))),
            "tagSet": engine.musical_tags(tags),
        }
        pool.append(item)
    return pool, {i["id"]: i for i in pool}


def main() -> int:
    # The client drops albums whose tags the lexicon barely covers; the pool
    # here must match or the candidate sets differ and nothing is comparable.
    pool, by_id = build_pool()
    print(f"pool: {len(pool):,} albums")

    if EXPECTED["tuning"] != engine.TUNING:
        differing = {k for k in EXPECTED["tuning"]
                     if EXPECTED["tuning"][k] != engine.TUNING.get(k)}
        print(f"FAIL: tuning differs between engines: {differing}", file=sys.stderr)
        return 1
    print("tuning matches")

    same = diff = missing = 0
    examples = []
    for key, expected in EXPECTED["cases"].items():
        seed_id, dial = key.rsplit("|", 1)
        seed = by_id.get(seed_id)
        if not seed:
            missing += 1
            continue
        got = engine.pick_branches(seed, pool, float(dial), {seed_id})
        got_keys = [f"{b['role']}:{b['item']['id']}" for b in got]
        if got_keys == expected:
            same += 1
        else:
            diff += 1
            if len(examples) < 4:
                examples.append((key, expected, got_keys))

    total = same + diff
    print(f"\n{same}/{total} cases agree exactly")
    if missing:
        print(f"({missing} seeds not in the shipped catalog, skipped)")
    for key, exp, got in examples:
        print(f"\n  {key}\n    ts: {exp}\n    py: {got}")

    if diff:
        print(f"\n{diff} DISAGREE — the port is not equivalent", file=sys.stderr)
        return 1
    print("\nengines are equivalent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
