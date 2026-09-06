#!/usr/bin/env python3
"""
Refuse duplicate top-level definitions.

Python keeps the last definition silently, so a file with two get_search or two
get_random runs the stale one and every test passes — the tests import the
module and get whatever won. This has happened twice here, both times from
slice-based edits that inserted a new version without removing the old, and
both times it was found by noticing that a fix had changed nothing.

api/server.py had accumulated four: get_items, build_pool, get_recs and
get_random. Three were byte-identical and harmless; get_random was not, so the
shuffle ran the uniform version for hours after being changed.

    .venv/bin/python api/dupe-check.py
"""
from __future__ import annotations

import ast
import collections
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["api/server.py", "api/engine.py", "api/scores.py", "api/eval-full.py",
         "api/parity-check.py", "api/make-api-db.py",
         "scripts/export_catalog.py", "scripts/db.py", "scripts/crawl.py",
         "scripts/resolve_spotify.py"]


def main() -> int:
    bad = 0
    for rel in FILES:
        p = ROOT / rel
        if not p.exists():
            continue
        tree = ast.parse(p.read_text())
        names = [n.name for n in tree.body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        dupes = {n: c for n, c in collections.Counter(names).items() if c > 1}
        # Module-level constants shadow just as quietly.
        consts = [t.id for n in tree.body if isinstance(n, ast.Assign)
                  for t in n.targets if isinstance(t, ast.Name) and t.id.isupper()]
        cdupes = {n: c for n, c in collections.Counter(consts).items() if c > 1}
        if dupes or cdupes:
            bad += 1
            print(f"  {rel}")
            for n, c in {**dupes, **cdupes}.items():
                print(f"    {n} defined {c} times — the last one wins, silently")
    if bad:
        print(f"\n{bad} file(s) with shadowed definitions")
        return 1
    print(f"no shadowed definitions in {len(FILES)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
