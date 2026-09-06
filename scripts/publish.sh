#!/usr/bin/env bash
# Refresh the published catalog snapshot and deploy.
#
# The site serves a frozen export, so publishing means: re-export from SQLite,
# commit if the data actually changed, push. The Pages workflow does the rest.
set -uo pipefail
cd "$(dirname "$0")/.."

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "publishing — db state:"
.venv/bin/python -c "
import sys; sys.path.insert(0,'scripts'); import db
c = db.connect(); print('   ', db.stats(c)); print('   ', db.crawl_progress(c))"

# Freshly crawled albums have no listener count until a sweep ends, and the
# export stratifies by popularity — without this they would all pile into the
# bottom decile and crowd out the real deep cuts.
log "backfilling popularity before export"
.venv/bin/python scripts/backfill_popularity.py 2>&1 | tail -2

.venv/bin/python scripts/export_catalog.py || { log "export failed"; exit 1; }

if git diff --quiet -- src/data/catalog.json; then
  log "catalog unchanged — nothing to publish"
  exit 0
fi

ALBUMS=$(.venv/bin/python -c "import json;print(json.load(open('src/data/catalog.json'))['stats']['albums'])")
TOTAL=$(.venv/bin/python -c "import json;print(json.load(open('src/data/catalog.json'))['stats']['totalInDb'])")

git add src/data/catalog.json
git commit -q -m "Publish catalog snapshot: ${ALBUMS} of ${TOTAL} albums

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LwNoBivL7KZjNZ7H5NwKdN" || { log "commit failed"; exit 1; }

git push origin main || { log "push failed"; exit 1; }
log "published ${ALBUMS} of ${TOTAL} albums; Pages workflow triggered"

# The API serves its own copy of the database, so publishing the bundle alone
# leaves browsing on stale data while the offline floor is fresh — the opposite
# of what anyone would expect. Both move together or the two disagree about
# what the catalog contains.
if [ "${SKIP_API:-0}" = "1" ]; then
  log "SKIP_API=1 — leaving the API on its current snapshot"
  exit 0
fi
if ! command -v fly >/dev/null 2>&1; then
  log "flyctl not installed — the API still serves its previous snapshot."
  log "  install it, then: .venv/bin/python api/make-api-db.py && fly deploy"
  exit 0
fi

# Cheap, and it has caught a broken image twice. Better here than after a
# deploy has reported success and the URL has stopped answering.
log "checking for shadowed definitions"
.venv/bin/python api/dupe-check.py || { log "duplicate definitions — not deploying"; exit 1; }

log "checking the image has everything the server imports"
bash api/image-check.sh || { log "image check failed — not deploying the API"; exit 1; }

log "rebuilding the API database"
.venv/bin/python api/make-api-db.py || { log "api db build failed"; exit 1; }
log "deploying the API"
fly deploy || { log "fly deploy failed — the site is live on the new bundle,";                 log "  but the API is still on its previous snapshot"; exit 1; }
log "API updated; both halves now serve the same catalog"
