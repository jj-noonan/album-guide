#!/usr/bin/env bash
#
# Supervisor for the long-running data jobs.
#
# Both are resumable and idempotent — every completed lookup is committed to
# SQLite immediately — so restarting one costs nothing but the request in
# flight. They hit different APIs (Spotify vs MusicBrainz) so they do not
# compete for rate limit, only for the database, which the retry/backoff in
# db.py now handles.
#
# Exists because this shell's children get reaped regularly; supervising both
# from one process means one thing to restart rather than two, and they come
# back on their own between kills.
#
#   bash scripts/run_jobs.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
LOG=data/jobs.log

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

#
# Restart on exit, tracked by PID.
#
# This used to ask `pgrep -f "bin/python -u <script>"` whether the job was
# already up. It never matched: a venv python is a shim, and macOS reports
# argv[0] as the resolved framework path (.../MacOS/Python), so the string
# "bin/python" is absent from the command line the supervisor was searching.
# The guard therefore read "not running" every time and started another worker
# each minute. Eighteen were live against a 1 req/sec API before it was caught.
#
# Holding the PID removes the guesswork: `kill -0` asks the kernel about this
# exact child instead of asking a text search about a process that resembles
# it. It also cannot match the supervisor, the monitor, or a shell whose
# command line happens to contain the script name.
supervise() {
  local name="$1"; shift
  # Empty, not 0: `kill -0 0` signals the caller's own process group and
  # therefore SUCCEEDS, which would make the guard read "already running" on
  # the first tick and never start the job at all.
  local pid=""
  while true; do
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      # Reap a finished child before replacing it, so exits do not accumulate
      # as zombies for the life of the supervisor.
      [ -n "$pid" ] && wait "$pid" 2>/dev/null
      $PY -u "$@" >> "$LOG" 2>&1 &
      pid=$!
      log "started $name (pid $pid)"
    fi
    sleep 60
  done
}

log "supervisor up"
# Verified clear on 2026-09-05: the 23h ban from 2026-09-03 has lapsed and a
# live search returns results on the rotated credentials. Paced at ~0.8/sec,
# not the 3/sec that earned the ban.
supervise "spotify" scripts/resolve_spotify.py 30000 &
supervise "ratings" scripts/backfill_ratings.py 25000 &
wait
