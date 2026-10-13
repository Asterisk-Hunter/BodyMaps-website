# Website access policy

Workspace, Team, and browser-only local scan viewing are public. Visitors can
select and view their own files locally. Starting server inference or loading a
dataset sample prompts sign-in/sign-up before any protected upload or request.
First sign-in resets the local file selection at the account-isolation boundary;
the user then selects the scan for their signed-in workspace.

Dataset browsing/viewing, server uploads and inference, saved server results, AI,
shared reports, Live Rooms, quizzes and account features require sign-in. The
React route gate is backed by `api/access_policy.py`, installed once by `create_app`.
New API routes require a valid `bm_session` by default. Existing ownership,
role, quota, room-key, and attempt-key checks still run after the session gate.

New upload clients send the run's captured account ID in `X-Upload-Owner`.
If a supplied value differs from the authenticated account, the API rejects it
with `409` and code `account_changed` before reading the request body. This
prevents an in-flight upload from being assigned to a different account after
a browser account switch. The header never authenticates a caller; older
clients without it retain their existing cookie/ownership checks. Valid
machine-worker requests use their exact worker-token exemptions instead.

## Public allowlist

Only these existing routes can execute without a website session:

| Purpose | Method and path |
| --- | --- |
| Sign up / sign in | `POST /api/auth/register`, `POST /api/auth/login` |
| Clear an expired session | `POST /api/auth/logout` |
| Account recovery | `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` |
| Redeem email verification | `POST /api/auth/verify-email` |
| OAuth discovery and login | `GET /api/auth/oauth/providers`, `GET /api/auth/oauth/<provider>`, `GET /api/auth/oauth/<provider>/callback` |
| Health checks | `GET /api/ping`, `GET /api/health`, `GET /api/live-rooms/health`, WebSocket service `GET /health` |

HEAD is allowed where GET is listed. API OPTIONS requests return an empty
preflight response without executing a feature handler. No blanket `/auth/`,
`/share/`, or `/live-rooms/` exemption exists. There are no payment/webhook routes
in this release; future external callbacks need an individually reviewed entry
and their own provider signature verification.

Pull-worker lease, input, heartbeat, result, failure, and status endpoints accept
their configured `X-Worker-Token` without a browser session. Worker credentials
cannot unlock dataset or other website APIs. Existing worker route checks remain
in place. A missing or incorrect worker token does not create a guest exemption.

The separate Live Rooms WebSocket server validates the same session cookie
before upgrading a connection, before joining, and before incoming actions.
Idle/receive-only connections are rechecked every 15 seconds, with a five-second
account-lookup timeout that fails closed. Rejected sessions stop receiving
frames and close with code `4401`. Its existing origin allowlist and room/attempt
capability checks remain required. Both Flask and WebSocket services must be
restarted when releasing this policy. See [session retention](../flask-server/deploy/SESSION_RETENTION.md)
for the optional 14-day cookie setting.

## Cache and deployment requirements

All API responses override former public/immutable headers with
`Cache-Control: private, no-store, max-age=0`, `Vary: Cookie`, and
`X-Accel-Expires: 0`. This also applies to errors, conditional responses, and
Flask responses that hand file delivery to nginx. It trades browser/shared API
caching for session enforcement; CT reopening may require another transfer.

The tracked `flask-server/deploy/nginx-bodymaps.conf` only exposes dataset roots
through `internal` X-Accel locations. Public requests to those locations cannot
bypass Flask. Audit the actual deployed nginx and edge/CDN configuration before
release: remove any public dataset aliases and purge existing cached `/api/`
responses, and ensure no proxy rule overrides the new private cache policy.
Previously delivered files or still-fresh browser caches cannot be revoked by a
new server guard. This policy does not claim to erase data already downloaded.

SPA HTML, JavaScript, fonts, logos, team portraits, and authentication/legal pages
are static public assets required to render the sign-in experience; access to
feature data is enforced at the API and WebSocket boundaries.
