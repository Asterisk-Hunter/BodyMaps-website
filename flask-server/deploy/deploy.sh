#!/bin/bash
# One-paste deploy for bdmap1. Runs every step of the README's "Deploying
# Updates to the Server" section with waits and checks built in, and stops at
# the first failure NAMING the step - so the fallback is simply to continue
# manually from that numbered step in the README.
#
# Safe to re-run from the top at any time: every step is a no-op when its work
# is already done. `bash deploy.sh check` runs the preflight only and changes
# nothing.
#
# The paths are bdmap1's; the BODYMAPS_* variables exist so the script can be
# rehearsed on another machine and are never needed on the server.
set -u

REPO="${BODYMAPS_REPO:-/home/visitor/PanTS-Viewer}"
PY="${BODYMAPS_CONDA_BIN:-/home/visitor/.conda/envs/PanTS_backend/bin}"
PORT="${BODYMAPS_PORT:-8000}"
LOG="${BODYMAPS_GUNICORN_LOG:-/tmp/gunicorn.log}"
# One deploy at a time (and never while site_watchdog.sh is restarting the backend): both take this lock.
LOCK="${BODYMAPS_DEPLOY_LOCK:-/tmp/bodymaps-deploy.lock}"
# Restarting the backend ends any inference job it is running, so wait for them (seconds) first.
WAIT_FOR_JOBS="${BODYMAPS_WAIT_FOR_JOBS:-900}"
# This release also changes WebSocket authentication. An operator-owned hook
# must check restart readiness without changes, then restart the exact service.
LIVE_ROOMS_HOOK="${BODYMAPS_LIVE_ROOMS_RESTART_HOOK:-}"
LIVE_ROOMS_URL="${BODYMAPS_LIVE_ROOMS_URL:-http://127.0.0.1:8001}"

step=""
say() { printf '\n== %s ==\n' "$*"; }
die() {
  printf '\nDEPLOY FAILED at: %s\n' "$step"
  [ -n "${1:-}" ] && printf '%s\n' "$1"
  printf 'Nothing after this step ran. Fix it, then rerun this script (safe),\nor continue manually from the README step named above.\n'
  case "$step" in
    5.*|5b.*|6.*)
      if [ -n "${old_sha:-}" ] && [ "${old_sha:-}" != "${new_sha:-}" ]; then
        printf 'To go back to the previous version (%s) and restart on it:\n  cd %s && git checkout --detach %s && bash flask-server/deploy/start_backend.sh\n  (then, once fixed: git checkout main)\n' "$old_sha" "$REPO" "$old_sha"
        printf 'This is only the backend rollback step. Restore the matching frontend and restart Live Rooms with the same revision before reopening the site; see deploy/REDESIGN_RELEASE.md.\n'
      fi;;
  esac
  exit 1
}

step="preflight"
say "$step"
[ -d "$REPO/.git" ] || die "repo not found at $REPO - is this the right machine?"
for bin in gunicorn pip alembic python; do
  [ -x "$PY/$bin" ] || die "missing $PY/$bin - conda env not where expected"
done
# npm often lives behind nvm, which interactive shells load from ~/.bashrc but
# a script does not inherit. Find it before giving up: source nvm directly,
# then glob the usual install dirs, then ask a login+interactive shell.
if ! command -v npm >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  npm_dir=$(ls -d "$HOME"/.nvm/versions/node/*/bin /usr/local/node*/bin /opt/node*/bin 2>/dev/null | sort -V | tail -1)
  if [ -n "$npm_dir" ] && [ -x "$npm_dir/npm" ]; then
    export PATH="$npm_dir:$PATH"
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  found=$(bash -ilc 'command -v npm' 2>/dev/null | tail -1)
  if [ -n "$found" ] && [ -x "$found" ]; then
    export PATH="$(dirname "$found"):$PATH"
  fi
fi
command -v npm >/dev/null 2>&1 || die "npm not found anywhere. In your SSH session run:  bash -ilc 'command -v npm'  and send the output to the maintainer."
echo "npm: $(command -v npm)"
command -v curl >/dev/null 2>&1 || die "curl is not on PATH"
[ -n "$LIVE_ROOMS_HOOK" ] && [ -x "$LIVE_ROOMS_HOOK" ] || die "set BODYMAPS_LIVE_ROOMS_RESTART_HOOK to an executable supporting check/restart; see deploy/REDESIGN_RELEASE.md. Both Flask and Live Rooms must use the new access policy."
"$LIVE_ROOMS_HOOK" check || die "Live Rooms restart preflight failed; nothing was changed. See deploy/REDESIGN_RELEASE.md."
free_kb=$(df -Pk "$REPO" | awk 'NR==2 {print $4}')
[ "${free_kb:-0}" -ge 2097152 ] || die "less than 2 GB free disk at $REPO"
echo "preflight ok (repo, conda env, npm, curl, disk)"
if [ "${1:-}" = "check" ]; then
  echo "check mode: stopping here - nothing was changed."
  exit 0
fi

step="lock"
command -v flock >/dev/null 2>&1 || die "flock is not installed (util-linux)"
exec 9>>"$LOCK" || die "cannot open the deploy lock $LOCK"
flock -n 9 || die "another deploy (or the watchdog restarting the site) holds $LOCK right now - wait for it to finish, then rerun"
health_body=$(mktemp) || die "cannot create a temporary health response file"
jar=""
trap 'rm -f "$health_body" "$jar"' EXIT

step="1. back up the database (README step 1)"
say "$step"
cd "$REPO/flask-server" || die
ts=$(date +%F-%H%M%S)
found=0
for db in *.db; do
  [ -e "$db" ] || continue
  # The running app uses WAL. Copying only *.db can omit committed accounts,
  # sessions and profile pictures still in its WAL; use SQLite's snapshot API.
  "$PY/python" - "$db" "$HOME/db-backup-$ts-$db" <<'PY' || die "database snapshot backup failed"
from pathlib import Path
import sqlite3
import sys
with sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
        assert target.execute("PRAGMA quick_check").fetchone()[0] == "ok"
PY
  found=1
done
if [ "$found" = 1 ]; then echo "backed up to ~/db-backup-$ts-*"; else echo "no db found (first deploy?) - continuing"; fi

step="2. pull latest main (README step 2)"
say "$step"
cd "$REPO" || die
git fetch || die "git fetch failed - network or credentials"
dirty=$(git status --porcelain --untracked-files=no)
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty"
  die "the server carries local edits (listed above). Per the README, do NOT force past this: discard each with 'git checkout -- <file>' or ask the maintainer, then rerun."
fi
git checkout main >/dev/null 2>&1 || die "could not switch to main"
old_sha=$(git rev-parse --short HEAD)
git pull --ff-only || die "pull was not a fast-forward - history diverged; ask the maintainer"
new_sha=$(git rev-parse --short HEAD)
echo "main: $old_sha -> $new_sha"

step="3. rebuild frontend and backend deps (README step 3)"
say "$step"
cd "$REPO/PanTS-Demo" || die
npm ci || die "npm ci failed"
npm run build || die "frontend build failed. nginx keeps serving the old site and the backend was NOT restarted - fix the build error and rerun."
"$PY/pip" install -r "$REPO/flask-server/requirements.txt" || die "pip install failed"
echo "frontend built; backend deps refreshed"

step="4. database migrations (README step 4)"
say "$step"
cd "$REPO/flask-server" || die
"$PY/alembic" upgrade head || die "alembic failed. The pre-migration backup from step 1 is at ~/db-backup-$ts-*"
echo "migrations at head"

step="4b. wait for running inference jobs"
say "$step"
active_jobs() {
  local code
  code=$(curl -sS -m 5 -o "$health_body" -w '%{http_code}' "http://127.0.0.1:$PORT/api/health") || return 1
  case "$code" in
    404) echo legacy; return 0;;
    200|503) ;;
    *) echo "Unexpected /api/health HTTP $code; refusing to assume that no inference is running." >&2; return 1;;
  esac
  "$PY/python" -c '
import json, sys
n = json.load(sys.stdin)["inference"]["active"]
assert type(n) is int and n >= 0
print(n)' < "$health_body" 2>/dev/null
}
waited=0
while :; do
  n=$(active_jobs) || die "cannot confirm the active job count; nothing was restarted. Restore /api/health before deploying."
  if [ "$n" = "legacy" ]; then echo "HTTP 404: the running backend predates /api/health; continuing without a job count"; break; fi
  if [ "$n" = "0" ]; then echo "no inference jobs running"; break; fi
  if [ "$waited" -ge "$WAIT_FOR_JOBS" ]; then
    die "$n inference job(s) are still running after ${WAIT_FOR_JOBS}s; restarting now would end them. Rerun when they finish (or raise BODYMAPS_WAIT_FOR_JOBS). Nothing was restarted."
  fi
  echo "$n inference job(s) running; waiting (${waited}s of ${WAIT_FOR_JOBS}s)"
  sleep 15; waited=$((waited + 15))
done

step="5. restart the backend (README step 5)"
say "$step"
BODYMAPS_REPO="$REPO" BODYMAPS_CONDA_BIN="$PY" BODYMAPS_PORT="$PORT" BODYMAPS_GUNICORN_LOG="$LOG" \
  bash "$REPO/flask-server/deploy/start_backend.sh" || die "the backend did not come back; see $LOG"

step="5b. restart Live Rooms with the new access policy"
say "$step"
"$LIVE_ROOMS_HOOK" restart || die "Live Rooms restart failed; do not consider this release complete. See deploy/REDESIGN_RELEASE.md."
rooms_up=0
for i in $(seq 1 10); do
  curl -fsS -m 3 "$LIVE_ROOMS_URL/health" >/dev/null 2>&1 && { rooms_up=1; break; }
  sleep 1
done
[ "$rooms_up" = 1 ] || die "Live Rooms did not answer its health check after restart"
rooms_nonce=$("$PY/python" -c 'import base64, os; print(base64.b64encode(os.urandom(16)).decode("ascii"))') \
  || die "cannot generate the Live Rooms handshake nonce"
rooms_guest_code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $rooms_nonce" \
  -H 'Origin: https://bodymaps.wse.jhu.edu' \
  "$LIVE_ROOMS_URL/ws/live-rooms/00000000-0000-0000-0000-000000000000")
[ "$rooms_guest_code" = "401" ] || die "Live Rooms guest handshake returned $rooms_guest_code, expected 401 - its access policy did not deploy"

step="6. verify (README step 6)"
say "$step"
up=0
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1 && { up=1; break; }
  sleep 2
done
[ "$up" = 1 ] || die "backend did not answer /api/ping within 60s - traceback is in $LOG"
echo "ping ok"
health_code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")
if [ "$health_code" = "200" ]; then echo "health ok (dataset storage answering)"
elif [ "$health_code" = "503" ]; then echo "WARNING: /api/health says the dataset storage is DOWN - the site is up but cannot serve scans (not caused by this deploy)"
else die "/api/health returned $health_code, expected 200 - see $LOG"; fi
for path in /api/search /api/get-segmentations/17.nii.gz; do
  guest_code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path")
  [ "$guest_code" = "401" ] || die "guest $path returned $guest_code, expected 401 - website access policy did not deploy"
done
echo "guest dataset gates ok (401)"
gate_code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/upload-inference-chunk")
[ "$gate_code" = "401" ] || die "guest upload returned $gate_code, expected 401 - the access tiers did not deploy"
echo "guest gate ok (401)"
jar=$(mktemp) || die "cannot create a temporary session cookie jar"
# SES mailbox simulator: accepts the verification mail without a bounce, so
# deploy checks never hurt sender reputation. Harmless when SMTP is unset
# (the message just goes to the log like any other).
throwaway="success+deploy-$ts@simulator.amazonses.com"
register_code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -c "$jar" -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$throwaway\",\"password\":\"delete-me-$ts\"}" \
  "http://127.0.0.1:$PORT/api/auth/register") || die "register request failed - see $LOG"
[ "$register_code" = "201" ] || die "register returned $register_code, expected 201 - see $LOG"
curl -fsS -m 20 -b "$jar" "http://127.0.0.1:$PORT/api/search?limit=1" | "$PY/python" -c '
import json, sys
assert isinstance(json.load(sys.stdin)["items"], list)
print("authenticated search ok")
' || die "authenticated search failed - see $LOG"
# HEAD exercises authenticated mask routing without downloading a full CT mask.
seg_code=$(curl -sS -I -m 15 -b "$jar" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/get-segmentations/17.nii.gz")
if [ "$seg_code" = "200" ]; then echo "authenticated segmentations ok (200)"
elif [ "$health_code" = "503" ] && [ "$seg_code" = "503" ]; then echo "WARNING: mask verification unavailable while dataset storage is down"
else die "authenticated segmentations returned $seg_code, expected 200 - see $LOG"; fi
curl -fsS -m 10 -b "$jar" "http://127.0.0.1:$PORT/api/me/usage" | "$PY/python" -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("plan") == "free", "fresh account plan is %r, expected free" % d.get("plan")
assert d["limits"]["daily_scans"] == 1, "daily_scans is %r, expected 1" % d["limits"]["daily_scans"]
print("tier ok: fresh account on free, 1 scan/day")
' || die "tier check failed - see the assertion above and $LOG"
curl -fsS -m 10 -b "$jar" -X POST "http://127.0.0.1:$PORT/api/auth/logout" >/dev/null || die "deployment test session logout failed"
rm -f "$jar"
echo "(throwaway account $throwaway can be deleted from Settings -> People, or ignored)"
if grep -qi "SMTP is not configured" "$LOG" 2>/dev/null; then
  echo "NOTE: SMTP is not configured - verification links go to $LOG instead of inboxes (README step 4b turns real email on; the site works fine meanwhile)"
else
  echo "mail: no 'SMTP is not configured' lines in the log"
fi

printf '\nDEPLOY OK  main %s -> %s\n' "$old_sha" "$new_sha"
