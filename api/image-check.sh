#!/usr/bin/env bash
#
# Does the image contain everything the server needs to start?
#
# The Dockerfile lists files explicitly and .dockerignore excludes everything
# else, so adding a runtime import without adding a COPY line produces an image
# that builds cleanly and dies on first import. That is a deploy which reports
# success and a URL that never answers, and it has now happened twice: once
# when Phase 2 added engine.py and the constants, and again when the scoring
# formulas moved into scores.py.
#
# Both times the local checks passed, because locally the whole repo is on
# disk. This copies exactly the paths the Dockerfile names into an empty
# directory and starts the server there, which is the only way to find out
# without paying for a deploy to tell you.
#
#   bash api/image-check.sh
set -uo pipefail
cd "$(dirname "$0")/.."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PORT=8899

missing=0
while read -r src dst; do
  [ -z "$src" ] && continue
  if [ ! -e "$src" ]; then
    echo "  MISSING from the repo: $src"
    missing=1
    continue
  fi
  mkdir -p "$STAGE/$(dirname "$src")"
  cp "$src" "$STAGE/$src"
done < <(grep '^COPY' api/Dockerfile | awk '{print $2, $3}')

[ "$missing" -eq 1 ] && { echo "IMAGE CHECK FAILED — a COPY names a file that does not exist"; exit 1; }

echo "staged $(find "$STAGE" -type f | wc -l | tr -d ' ') files from the Dockerfile"

HOST=127.0.0.1 PORT=$PORT "$PWD/.venv/bin/python" "$STAGE/api/server.py" > "$STAGE/log" 2>&1 &
srv=$!
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then break; fi
  kill -0 "$srv" 2>/dev/null || break
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
  echo "IMAGE CHECK FAILED — the server did not come up from the image's files:"
  sed 's/^/    /' "$STAGE/log" | tail -12
  kill "$srv" 2>/dev/null
  exit 1
fi

health=$(curl -s "http://127.0.0.1:$PORT/v1/health")
kill "$srv" 2>/dev/null
echo "IMAGE OK — $health"
