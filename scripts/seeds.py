#!/usr/bin/env python3
"""
Evaluation seeds, in batches, so held-out seeds can rotate.

Why batches. A held-out seed is one whose similar-artist list is never used to
decide what to crawl, so its agreement score measures the engine rather than
the crawler. That only holds while it stays unused — the moment a batch becomes
a crawl source, the catalog starts filling with its answers and its score stops
being independent.

So rotation is one-way. A batch goes clean -> held out -> crawl source, and
never back: `crawledFrom` records that it has been spent. Rotating means
promoting the current held-out batch to crawl source and holding out a batch
that has never been one. Reusing a spent batch would look like rotation and
quietly measure nothing, which is why this file refuses to do it.

Seed artists' own discographies are always fair to crawl, held out or not.
Contamination comes from crawling who a seed is *similar to*, not from holding
the seed's own records — and a seed with no albums generates no test at all.

    .venv/bin/python scripts/seeds.py            # show the current split
    .venv/bin/python scripts/seeds.py --rotate   # advance to the next batch
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SEEDS = Path(__file__).resolve().parent.parent / "data" / "seeds.json"


def load() -> dict:
    return json.loads(SEEDS.read_text())


def held_out(doc: dict | None = None) -> list[str]:
    doc = doc or load()
    return doc["batches"][str(doc["heldOutBatch"])]["artists"]


def tuning(doc: dict | None = None) -> list[str]:
    """Every seed that is not currently held out."""
    doc = doc or load()
    out: list[str] = []
    for key, batch in doc["batches"].items():
        if int(key) != doc["heldOutBatch"]:
            out.extend(batch["artists"])
    return out


def all_artists(doc: dict | None = None) -> list[str]:
    doc = doc or load()
    return [a for b in doc["batches"].values() for a in b["artists"]]


def rotate() -> int:
    """
    Retire the current held-out batch and hold out a clean one.

    The retiring batch is marked as a crawl source, because that is what it
    becomes the moment gap-crawling is allowed to read it.
    """
    doc = load()
    current = str(doc["heldOutBatch"])
    clean = [k for k, b in doc["batches"].items()
             if not b["crawledFrom"] and k != current]
    if not clean:
        print("No clean batch left to hold out. Add a new batch of artists that\n"
              "have never been used as a crawl source — reusing a spent one would\n"
              "look like rotation and measure nothing.", file=sys.stderr)
        return 1

    doc["batches"][current]["crawledFrom"] = True
    doc["heldOutBatch"] = int(sorted(clean, key=int)[0])
    SEEDS.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"batch {current} retired to crawl source; batch {doc['heldOutBatch']} now held out")
    print("Re-run fetch_similar.py to rebuild the fixture with the new split.")
    return 0


def main() -> int:
    if "--rotate" in sys.argv:
        return rotate()
    doc = load()
    for key, batch in sorted(doc["batches"].items(), key=lambda kv: int(kv[0])):
        if int(key) == doc["heldOutBatch"]:
            state = "HELD OUT — never a crawl source"
        elif batch["crawledFrom"]:
            state = "crawl source (spent)"
        else:
            state = "clean reserve"
        print(f"  batch {key}: {len(batch['artists']):3} artists — {state}")
    print(f"\n  {len(tuning(doc))} tuning, {len(held_out(doc))} held out, "
          f"{len(all_artists(doc))} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
