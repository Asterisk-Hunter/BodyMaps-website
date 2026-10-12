# BodyMaps Live Rooms deployment

Live Rooms use existing Flask service for creation, snapshots, and exports, plus separate async WebSocket process on `127.0.0.1:8001`. Room files live under `${SESSIONS_DIR_PATH}/live_rooms` and expire after 24 hours. Both REST and WebSocket access require a signed-in account as well as the room/attempt capability; only health endpoints remain public.

For the authenticated redesign release, follow [the coordinated release
procedure](REDESIGN_RELEASE.md). The main deployment script requires an explicit
read-only restart preflight and restart hook for this service, then checks that
anonymous WebSocket upgrades return 401. A Flask-only restart is insufficient.

For an explicitly approved release on a host whose nginx configuration cannot
yet proxy WebSockets, build with `VITE_LIVE_ROOMS_ENABLED=false` and follow the
constrained-release section of `REDESIGN_RELEASE.md`. Creation and direct room
entry show an unavailable message; they must not create room records or retry
an unreachable socket. Solo viewing and solo learning remain available. A
healthy loopback WebSocket process does not prove public connectivity. Enable
the feature only after the matched service, nginx route, and public HTTPS
authentication checks pass.

## Install and verify

```bash
cd /home/visitor/PanTS-Viewer/flask-server
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest tests/unit/test_live_room_store.py
./.venv/bin/python -m py_compile live_rooms_ws.py services/live_room_store.py api/live_rooms.py
```

`PANTS_PATH`, `SESSIONS_DIR_PATH`, and `DATABASE_URL` come from existing `flask-server/.env`. The WebSocket service loads the same file and must use the same account/session database as Flask. Service user needs read access to dataset tree and write access to session directory.

Set `LIVE_ROOMS_ALLOWED_ORIGINS` to an exact comma-separated list of browser origins. Production defaults to `https://bodymaps.wse.jhu.edu`; wildcards are rejected. A deployment override can be placed in `/etc/bodymaps/live-rooms.env`.

## Enable services

```bash
sudo cp deploy/systemd/bodymaps-live-rooms.service /etc/systemd/system/
sudo cp deploy/systemd/bodymaps-live-rooms-cleanup.service /etc/systemd/system/
sudo cp deploy/systemd/bodymaps-live-rooms-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bodymaps-live-rooms.service bodymaps-live-rooms-cleanup.timer
curl -fsS http://127.0.0.1:8001/health
```

Install updated `deploy/nginx-bodymaps.conf`, then validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Development

Run services in separate terminals:

```bash
cd flask-server
python app.py
python live_rooms_ws.py
```

Vite proxies `/api` to Flask and `/ws` to `VITE_WS_BASE` (default `ws://127.0.0.1:8001`).

## Operations

- REST health: `GET /api/live-rooms/health`
- WebSocket health: `GET http://127.0.0.1:8001/health`
- Logs: `journalctl -u bodymaps-live-rooms.service`
- Cleanup logs: `journalctl -u bodymaps-live-rooms-cleanup.service`
- Room key exists only in URL fragment and `X-Room-Key`; never add fragment or key to analytics/logs.
- Quiz creation returns `quiz_host_claim` plus the temporary protocol 1 alias `quiz_host_secret` for the 24-hour rolling room window. New clients send `quiz_host_claim` in `hello`, then send `host.claim_ack` after receiving and storing `room.ready`; until that acknowledgement, retrying the claim reissues a usable resume credential for the same host identity.
- A room link permits collaboration only after account sign-in; it does not define per-account invitations or roles. The session is checked before join/actions and every 15 seconds while connected. See [session retention](SESSION_RETENTION.md) for revocation timing; restart both Flask and the WebSocket service when deploying authentication changes.
- Canonical `image_only` and `mask_only` stay read-only. Exports materialize under session directory only.
