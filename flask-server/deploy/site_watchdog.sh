#!/bin/bash
# Site watchdog for bdmap1: run it from cron once a minute. It does three things and nothing else:
#
#   1. tells people when the site is down, degraded, or back (to a chat webhook, if configured);
#   2. restarts the backend when it has stopped answering for several minutes in a row, but ONLY
#      when the cause is the backend itself (see below), at most once per cooldown and a few times
#      a day, and never while a deploy is running;
#   3. keeps a log of every decision in $WATCHDOG_STATE_DIR/watchdog.log.
#
# Why not simply "restart when it is down": on Oct 10 the site died because the dataset mount hung.
# Restarting does nothing for that (the new process hangs on the same mount, and a restart ends
# running inference jobs), so a hung mount only produces an alert. A restart happens only when the
# mount answers and the backend does not.
#
#   * * * * * /home/visitor/PanTS-Viewer/flask-server/deploy/site_watchdog.sh >> /home/visitor/.bodymaps-watchdog/cron.log 2>&1
#
# Settings (all optional; put them in ~/.bodymaps-watchdog.env, which this script reads, mode 600):
#   BODYMAPS_ALERT_WEBHOOK   chat webhook URL (Teams/Slack-style {"text": "..."} POST); unset = log only
#   WATCHDOG_AUTORESTART     1 (default) restart an unresponsive backend; 0 = alert only
#   WATCHDOG_FAILS           consecutive bad minutes before a restart (default 4)
#   WATCHDOG_MIN_RESTART_GAP seconds between restarts (default 1800)
#   WATCHDOG_MAX_PER_DAY     restarts per rolling day before it only alerts (default 4)
set -u

HOME_DIR="${HOME:-/home/visitor}"
ENV_FILE="${WATCHDOG_ENV_FILE:-$HOME_DIR/.bodymaps-watchdog.env}"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

REPO="${BODYMAPS_REPO:-/home/visitor/PanTS-Viewer}"
PORT="${BODYMAPS_PORT:-8000}"
BASE_URL="${BODYMAPS_WATCHDOG_URL:-http://127.0.0.1:$PORT}"
STATE_DIR="${WATCHDOG_STATE_DIR:-$HOME_DIR/.bodymaps-watchdog}"
DEPLOY_LOCK="${BODYMAPS_DEPLOY_LOCK:-/tmp/bodymaps-deploy.lock}"
MOUNT_PROBE_PATH="${BODYMAPS_MOUNT_PROBE_PATH:-/mnt/bodymaps}"
FAILS_NEEDED="${WATCHDOG_FAILS:-4}"
MIN_GAP="${WATCHDOG_MIN_RESTART_GAP:-1800}"
MAX_PER_DAY="${WATCHDOG_MAX_PER_DAY:-4}"
AUTORESTART="${WATCHDOG_AUTORESTART:-1}"
CURL="${WATCHDOG_CURL:-curl}"
START_CMD="${WATCHDOG_START_CMD:-bash $REPO/flask-server/deploy/start_backend.sh}"
# Default probe: stat a random, nonexistent child of the mount (forces a real round trip to the NFS
# server); "no such file" is healthy, a hang is killed after 8 s and counts as down.
MOUNT_PROBE_CMD="${WATCHDOG_MOUNT_PROBE_CMD:-}"
NOW="${WATCHDOG_NOW:-$(date +%s)}"

mkdir -p "$STATE_DIR" 2>/dev/null || { echo "cannot create $STATE_DIR" >&2; exit 0; }
LOG="$STATE_DIR/watchdog.log"
log() { printf '%s %s\n' "$(date -d "@$NOW" '+%F %T' 2>/dev/null || date '+%F %T')" "$*" >> "$LOG"; }

# One run at a time (a restart can take over a minute); a deploy in progress means: do nothing.
exec 8>"$STATE_DIR/watchdog.lock"
flock -n 8 || exit 0
if [ -w "$DEPLOY_LOCK" ]; then
  ( flock -n 7 ) 7>>"$DEPLOY_LOCK" || { log "deploy in progress; skipping this check"; exit 0; }
fi

alert() {  # alert "message": always logged; posted to the webhook when configured
  log "ALERT: $1"
  [ -n "${BODYMAPS_ALERT_WEBHOOK:-}" ] || return 0
  local text
  text="$(printf '%s' "[BodyMaps] $1" | tr -d '\r\n"\\' | cut -c1-400)"
  "$CURL" -s -m 10 -o /dev/null -X POST -H 'Content-Type: application/json' \
    -d "{\"text\": \"$text\"}" "$BODYMAPS_ALERT_WEBHOOK" || log "webhook post failed"
}

mount_answers() {
  if [ -n "$MOUNT_PROBE_CMD" ]; then bash -c "$MOUNT_PROBE_CMD" >/dev/null 2>&1; return $?; fi
  timeout -s KILL 8 stat "$MOUNT_PROBE_PATH/.watchdog-probe-$$-$RANDOM" >/dev/null 2>&1
  local rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]         # 1 = "no such file": the server answered
}

read_state() { cat "$STATE_DIR/$1" 2>/dev/null || echo "${2:-}"; }
write_state() { printf '%s' "$2" > "$STATE_DIR/$1"; }
notify_once() {  # notify_once <reason> <message>: one alert per reason until the incident ends
  [ "$(read_state notified none)" = "$1" ] && return 0
  write_state notified "$1"; alert "$2"
}

# ---- observe -------------------------------------------------------------------------------
body="$STATE_DIR/last_health.json"
code="$("$CURL" -s -m 10 -o "$body" -w '%{http_code}' "$BASE_URL/api/health" 2>/dev/null || true)"
[ -n "$code" ] || code=000
if [ "$code" = "404" ]; then            # an older backend without /api/health: fall back to /api/ping
  code="$("$CURL" -s -m 10 -o "$body" -w '%{http_code}' "$BASE_URL/api/ping" 2>/dev/null || true)"
  [ -n "$code" ] || code=000
fi

if [ "$code" = "200" ]; then
  now_state=ok
elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
  # A session/proxy policy error is an answering backend, not a dead one.
  # Restarting cannot repair access rules and would end active inference jobs.
  now_state=health_auth
elif [ "$code" = "503" ] && grep -q 'degraded' "$body" 2>/dev/null; then
  now_state=mount_down
elif mount_answers; then
  now_state=unresponsive                # the mount is fine, so the backend is the problem
else
  now_state=mount_down                  # nothing answers because the mount hung, which a restart cannot fix
fi

prev_state="$(read_state state ok)"
fails="$(read_state fails 0)"

# ---- decide --------------------------------------------------------------------------------
case "$now_state" in
  health_auth)
    write_state fails 0; write_state state health_auth
    notify_once health_auth "health endpoint returned HTTP $code: check the health access/proxy configuration. Backend restart skipped because it cannot fix authentication rules."
    ;;
  ok)
    [ "$prev_state" != ok ] && alert "site is back (was: $prev_state)"
    write_state fails 0; write_state state ok; write_state notified none
    ;;
  mount_down)
    [ "$prev_state" != mount_down ] && alert "dataset storage is not answering (/mnt/bodymaps). Scans and masks cannot be served; search and the low-res viewer may still work. A restart would not help: the storage admin needs to fix the NFS server."
    write_state fails 0; write_state state mount_down; write_state notified none
    ;;
  unresponsive)
    fails=$((fails + 1)); write_state fails "$fails"; write_state state unresponsive
    log "backend not answering (HTTP $code), bad check $fails of $FAILS_NEEDED"
    if [ "$fails" -lt "$FAILS_NEEDED" ]; then exit 0; fi
    last="$(read_state last_restart 0)"
    # restarts in the last 24 h, one epoch per line
    recent="$(awk -v now="$NOW" '$1 > now - 86400' "$STATE_DIR/restarts" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$AUTORESTART" != 1 ]; then
      notify_once manual "backend has not answered for $fails minutes (HTTP $code); automatic restart is off - restart it by hand"
    elif [ $((NOW - last)) -lt "$MIN_GAP" ]; then
      notify_once cooldown "backend still not answering ($fails minutes); restart skipped because one ran $(( (NOW - last) / 60 )) minutes ago"
    elif [ "$recent" -ge "$MAX_PER_DAY" ]; then
      notify_once cap "backend not answering and $recent restarts already ran in the last 24 h; not restarting again, someone should look"
    else
      alert "backend has not answered for $fails minutes while the storage is fine; restarting it now"
      write_state last_restart "$NOW"; echo "$NOW" >> "$STATE_DIR/restarts"
      tail -n 50 "$STATE_DIR/restarts" > "$STATE_DIR/restarts.tmp" && mv "$STATE_DIR/restarts.tmp" "$STATE_DIR/restarts"
      # Holding the deploy lock while restarting keeps a deploy from starting underneath it.
      if ( flock -n 7 || exit 99; $START_CMD ) 7>>"$DEPLOY_LOCK" >> "$LOG" 2>&1; then
        alert "backend restarted and answering"
        write_state fails 0; write_state state ok; write_state notified none
      else
        alert "restart FAILED; see $LOG on the server"
      fi
    fi
    ;;
esac
exit 0
