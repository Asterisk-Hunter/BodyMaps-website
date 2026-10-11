#!/bin/bash
# (Re)start the production gunicorn on bdmap1 and wait until it answers. Used by deploy.sh and by
# site_watchdog.sh so there is exactly one definition of "how the backend is started".
#
# It stops only the gunicorn bound to $PORT, never another gunicorn on the machine (a recovery
# preview on another port, someone's dev server). Stopping the backend ends any inference job it
# is running: callers decide whether that is acceptable (deploy.sh waits for jobs first).
#
#   bash flask-server/deploy/start_backend.sh
#
# The paths are bdmap1's; the BODYMAPS_* variables exist so the script can be rehearsed on another
# machine and are never needed on the server.
set -u

REPO="${BODYMAPS_REPO:-/home/visitor/PanTS-Viewer}"
PY="${BODYMAPS_CONDA_BIN:-/home/visitor/.conda/envs/PanTS_backend/bin}"
PORT="${BODYMAPS_PORT:-8000}"
LOG="${BODYMAPS_GUNICORN_LOG:-/tmp/gunicorn.log}"
# 16 threads, not 8: if some requests do get stuck on a hung dataset mount before the monitor
# notices (services/mount_health.py), the rest of the site still has threads to answer with.
THREADS="${BODYMAPS_GUNICORN_THREADS:-16}"
WAIT_SECONDS="${BODYMAPS_START_WAIT:-60}"

# Matches this gunicorn's command line only: "... --bind 127.0.0.1:<port> ... app:app".
PATTERN="gunicorn.*--bind 127\\.0\\.0\\.1:${PORT} .*app:app"

fail() { printf 'START FAILED: %s\n' "$1" >&2; exit 1; }

[ -x "$PY/gunicorn" ] || fail "missing $PY/gunicorn - conda env not where expected"
[ -d "$REPO/flask-server" ] || fail "repo not found at $REPO"

# Once the administrator has installed deploy/systemd/pants-flask.service, systemd owns the backend:
# killing it here would just make systemd start it again, and starting a second one would fail to
# bind. Restart a managed backend with `sudo systemctl restart pants-flask.service` instead.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet pants-flask.service 2>/dev/null; then
  fail "the backend is managed by systemd (pants-flask.service); restart it with: sudo systemctl restart pants-flask.service"
fi

pkill -f "$PATTERN" 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "$PATTERN" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  pkill -9 -f "$PATTERN"; sleep 2
fi
pgrep -f "$PATTERN" >/dev/null 2>&1 && fail "the old gunicorn on port $PORT refused to exit"

# setsid: a dropped SSH connection (or the end of a cron job) must not take the backend with it.
# 7>&- 8>&- 9>&-: our callers hold flock locks on those descriptors (deploy.sh, site_watchdog.sh). A
# lock belongs to the open file, so a long-lived child that inherited one would keep the lock held for
# as long as the backend runs and block every later deploy and watchdog run.
setsid nohup "$PY/gunicorn" \
  --worker-class gthread --workers 1 --threads "$THREADS" \
  --bind "127.0.0.1:$PORT" --timeout 3600 \
  --chdir "$REPO/flask-server" \
  app:app > "$LOG" 2>&1 < /dev/null 7>&- 8>&- 9>&- &
echo "started gunicorn on port $PORT with $THREADS threads (PID $!), log: $LOG"

tries=$(( WAIT_SECONDS / 2 ))
for i in $(seq 1 "$tries"); do
  if curl -sf -m 5 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
    echo "backend answers /api/ping"
    exit 0
  fi
  sleep 2
done
fail "the backend did not answer /api/ping within ${WAIT_SECONDS}s - traceback is in $LOG"
