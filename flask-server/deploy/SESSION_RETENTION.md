# Keep me signed in

Password registration and login accept JSON `remember_me` (boolean; default
`false`). Google and GitHub OAuth starts accept `remember_me=0` or `1` (default
`0`). Other values return 400. The checkbox should start unchecked.

With the option unchecked, the `bm_session` cookie is a browser-session cookie
without `Max-Age` or `Expires`. With it checked, the cookie lasts for the existing
14-day session lifetime. Both choices keep the cookie HttpOnly, SameSite=Lax,
and Secure when `SESSION_COOKIE_SECURE=true`; both still expire on the server
after 14 days and are revoked by logout, account deletion, or password reset.
This does not create an indefinite session or store tokens in local storage.

OAuth retention and the return route are saved in the signed Flask session under
that authorization attempt's random state. The callback cannot change the
choice through query parameters, and a second sign-in tab cannot overwrite the
first tab's preference. Authlib continues to validate provider state/tokens.
The production `SECRET_KEY` must remain stable across workers and releases, as
required by the existing OAuth flow.

Password reset signs the person in with a session-only cookie. Existing sessions
issued before this release retain their original expiry. Browser session
restoration can restore session cookies; this option controls cookie retention,
not a guaranteed sign-out on every browser process restart.

No session schema migration or provider callback URL change is required.

Live Rooms also revalidate the account before joining and before every incoming
room action. An idle or receive-only connection is checked every 15 seconds;
an account-store lookup has a five-second timeout and fails closed. Once a
session is rejected, the service suppresses outgoing frames and closes the
socket with code `4401` (`Sign in to continue`). This covers logout of the
connected session, password reset, account deletion and natural session expiry. Restart
the separate Live Rooms WebSocket service when deploying this change as well
as the Flask backend.
