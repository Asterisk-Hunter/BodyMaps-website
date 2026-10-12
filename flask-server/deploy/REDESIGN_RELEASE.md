# Releasing the authenticated website redesign

Keep the redesign local until the reviewed preview is approved. Release the
merged code from `main`, preserving the current mount guard, watchdog, unified
case numbering and CancerVerse masks. Do not copy an old frontend/backend tree
over the live checkout.

## Before deployment

1. Review the actual nginx and edge-cache configuration. Keep dataset aliases
   internal, preserve private/no-store API headers, and purge old shared API
   cache entries. Apply the exact avatar upload location from
   `nginx-bodymaps.conf`, validate with `nginx -t`, then reload during the agreed
   release window. See `PROFILE_PICTURES.md`.
2. Confirm a consistent backup of the account database, stable `SECRET_KEY`,
   production Secure session cookies, and the existing Google/GitHub callback
   configuration. Run `alembic upgrade head` before starting the new backend:
   `a0c94f83b7d2` adds account pictures and `b72e86dc109a` adds nullable inference
   pipeline metadata. Existing accounts, sessions and completed jobs are retained.
3. Arrange restart access for **both** Flask and the separate Live Rooms
   WebSocket process. Restarting only Flask leaves the old WebSocket access
   rules active. Check the actual service manager and interpreter on this host;
   do not use a broad `pkill` or assume the example systemd unit is installed.
4. Record whether each optional stage is **real** or **preview only** for this
   release. For real execution, follow [the processing pipeline runbook](../../docs/processing-pipeline.md)
   to stage the actual OpenVAE checkpoint and verify all enabled stages on an
   isolated GPU run. File/runtime availability is a preflight, not proof that a
   real model ran successfully. Missing real-stage dependencies remain visibly
   unavailable; do not substitute a model or silently skip a requested stage.
   For an approved preview-only release, build the frontend with
   `VITE_OPENVAE_UI_PREVIEW=true` and/or `VITE_SHAPEKIT_UI_PREVIEW=true`.
   These flags default off. An enabled preview is labelled **Preview only** in
   the picker and **Not run** in progress/results, and its stage is excluded
   from inference requests. Preview releases do not require those unused
   optional runtimes or checkpoints; the actual segmentation service still
   needs its ordinary dependencies and validation. The original CT and real
   segmentation result receive no preview transformation. Verify the chosen
   build flags and labels after release; do not represent preview UI as a GPU test.

## Required Live Rooms restart hook

### Explicit release with the current proxy unchanged

If an operator has approval to release the redesign before nginx administration
is available, build with `VITE_LIVE_ROOMS_ENABLED=false` and
`VITE_AVATAR_MAX_BYTES=921600`. This constrained release keeps public Live Rooms
unavailable: creation and direct room entry must show the unavailable notice
before creating a room, loading its data, or opening a WebSocket. Solo scan
viewing and solo learning activities remain available. The picture picker must
advertise and enforce the 900 KB limit, leaving multipart overhead below the
existing 1 MiB proxy limit. The backend's 5 MiB validation is unchanged.

This is a separately reviewed rollout, not a no-op WebSocket restart hook for
`deploy.sh`. Confirm there is no active older public WebSocket process; an
existing process must still receive authentication fixes or be stopped through
its exact service manager. Preserve nginx unchanged, take a consistent SQLite
backup, apply the additive migrations, restart only the identified production
Flask process, and publish the matching staged frontend. Clearly record both
limitations in the release. Use the existing job health counters and an agreed
quiet window immediately before gracefully stopping Gunicorn; the counter
alone is not an admission lock. Do not force-kill inference work.

After IT adds the reviewed WebSocket route and exact avatar allowance, start or
restart the matching authenticated WebSocket service, verify signed-in and
anonymous upgrade behavior through public HTTPS, and rebuild with Live Rooms
enabled and the normal picture limit. Installing a loopback service alone does
not make public Live Rooms reachable. Optional processing preview flags are
independent of these proxy constraints.

`deploy.sh` requires `BODYMAPS_LIVE_ROOMS_RESTART_HOOK` to name an executable
operator-owned file. This is an explicit release prerequisite, including for
`deploy.sh check`; it is not an automatic sudo or process-discovery fallback.
The file accepts exactly one argument:

- `check`: verify that the expected service and restart authorization exist,
  without restarting, writing configuration or prompting for a password.
- `restart`: restart that exact service using its configured service manager
  and return nonzero if the restart fails.

For the system service described in `LIVE_ROOMS.md`, an administrator can
prepare a root-owned executable like this after verifying the unit paths:

```bash
#!/bin/bash
set -eu
case "${1:-}" in
  check)
    systemctl cat bodymaps-live-rooms.service >/dev/null
    sudo -n -l /usr/bin/systemctl restart bodymaps-live-rooms.service >/dev/null
    ;;
  restart) sudo -n /usr/bin/systemctl restart bodymaps-live-rooms.service ;;
  *) exit 2 ;;
esac
```

The administrator grants only the required command through their normal
authorization process. If Live Rooms uses a user service or another supervisor,
the operator supplies the corresponding two operations instead. A host that
does not run Live Rooms needs a separately reviewed deployment plan; do not use
a no-op hook to bypass this prerequisite.

Set `BODYMAPS_LIVE_ROOMS_RESTART_HOOK` to that file before running the README's
deployment command. `BODYMAPS_LIVE_ROOMS_URL` defaults to
`http://127.0.0.1:8001`; change it only to the confirmed local service address.
`deploy.sh check` calls only the hook's read-only `check` operation and exits
before locks, backup, build, migration or restarts.

## Automated release verification

The deployment preserves the existing inference-job wait. Only HTTP 404 from a
legacy backend deliberately permits deployment without a job count; timeout,
401/403, other unexpected statuses or an invalid count stop the deployment.
`GET`/`HEAD /api/health` remain public and read cached operational state, so the
watchdog never needs a browser session.

After restarting both services, checks require a healthy WebSocket process and
an HTTP 401 for an anonymous WebSocket upgrade. The script verifies anonymous
dataset denial, then uses its existing disposable test account for search,
mask HEAD requests and plan checks, and logs that session out. No full scan is
downloaded. If storage is degraded, mask verification is explicitly reported as
unavailable and must be repeated after recovery.

Finish in the approved Chrome profile: sign in through the existing providers,
browse both datasets, open a PanTS and CancerVerse case, check masks, reports,
uploads, account picture persistence and Live Rooms. Confirm logout blocks
protected pages and invalidates an open room connection. Repeat with the
optional Keep me signed in setting. This browser review is required in addition
to script checks.

If rollback is needed, leave the additive avatar table in place. Roll back and
restart both application processes together and rebuild/restore the matching
frontend; a backend-only restart is not a complete release rollback.
