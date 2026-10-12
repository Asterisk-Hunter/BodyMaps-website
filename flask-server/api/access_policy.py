"""Application-wide session boundary for website APIs.

Keep this deny-by-default: a new API is private unless its exact endpoint and
HTTP method are reviewed here. A capability key alone no longer grants guest
access to shared reports, Live Rooms, or educational content.
"""

from __future__ import annotations

import hmac
import os

from flask import Flask, jsonify, request

from api import auth


# Account entry/recovery must work before a session exists. These are endpoint
# identities, not prefix exemptions: /auth/me, avatars, and coupons stay private.
PUBLIC_ENDPOINT_METHODS = {
    "auth.register": frozenset({"POST"}),
    "auth.login": frozenset({"POST"}),
    "auth.logout": frozenset({"POST"}),
    "auth.forgot_password": frozenset({"POST"}),
    "auth.reset_password": frozenset({"POST"}),
    "auth.verify_email": frozenset({"POST"}),
    "oauth.providers": frozenset({"GET", "HEAD"}),
    "oauth.oauth_start": frozenset({"GET", "HEAD"}),
    "oauth.oauth_callback": frozenset({"GET", "HEAD"}),
    "api.ping": frozenset({"GET", "HEAD"}),
    # Cached infrastructure health and job counts keep deploy/watchdog checks
    # independent of browser sessions, including during a storage outage.
    "api.health": frozenset({"GET", "HEAD"}),
    "live_rooms.live_rooms_health": frozenset({"GET", "HEAD"}),
}

# These are machine-to-machine routes, not public website features. An exact
# token is mandatory; its presence never exempts other data/model endpoints.
WORKER_ENDPOINT_METHODS = {
    "api.lease_next_pull_job": frozenset({"GET", "HEAD"}),
    "api.download_pull_job_input": frozenset({"GET", "HEAD"}),
    "api.heartbeat_pull_job": frozenset({"POST"}),
    "api.complete_pull_job": frozenset({"POST"}),
    "api.fail_pull_job": frozenset({"POST"}),
    "api.get_pull_inference_job": frozenset({"GET", "HEAD"}),
}

API_BLUEPRINTS = frozenset({"api", "auth", "oauth", "admin", "analytics", "education", "live_rooms"})


def _valid_worker_token() -> bool:
    expected = os.environ.get("WORKER_API_TOKEN", "").strip()
    provided = request.headers.get("X-Worker-Token", "").strip()
    return bool(expected and provided and hmac.compare_digest(provided, expected))


def install_access_policy(app: Flask, *, api_prefix: str = "/api") -> None:
    """Install once on the Flask application, after registering its blueprints."""
    if app.extensions.get("bodymaps_access_policy"):
        return
    app.extensions["bodymaps_access_policy"] = True
    prefix = "/" + api_prefix.strip("/")

    def is_api_request() -> bool:
        # The path test also covers unknown/new blueprints under the API prefix;
        # the blueprint test covers Flask's normalized legacy BASE_PATH routes.
        return (
            request.blueprint in API_BLUEPRINTS
            or request.path == prefix
            or request.path.startswith(prefix + "/")
        )

    @app.before_request
    def require_website_session():
        if not is_api_request():
            return None
        if request.method == "OPTIONS":
            # Browser preflight contains no credentials. Respond without ever
            # dispatching to a data handler, including custom OPTIONS handlers.
            return app.make_default_options_response()
        if request.method in WORKER_ENDPOINT_METHODS.get(request.endpoint, ()) and _valid_worker_token():
            return None
        public = request.method in PUBLIC_ENDPOINT_METHODS.get(request.endpoint, ())
        upload_owner = request.headers.get("X-Upload-Owner")
        if public and upload_owner is None:
            return None
        user = auth.current_user()
        # A browser can change accounts in another tab before an in-flight
        # upload learns about the change. Bind new clients' requests to the
        # account captured when the run began, before parsing or saving a body.
        # This is a consistency check, not authentication or ownership proof;
        # existing sessions and endpoint-specific authorization still apply.
        if user is not None and upload_owner is not None and upload_owner != str(user["id"]):
            return jsonify({
                "error": "Your signed-in account changed. Reload before continuing this upload.",
                "code": "account_changed",
            }), 409
        if public:
            return None
        if user is None:
            return jsonify({"error": "Authentication required", "code": "authentication_required"}), 401
        return None

    @app.after_request
    def private_api_responses(response):
        if is_api_request():
            # Old volume/thumbnail handlers advertise public immutable caching.
            # Override at the app boundary (after blueprint hooks), otherwise a
            # shared cache can answer a guest without reaching the session check.
            response.headers["Cache-Control"] = "private, no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            response.headers["X-Accel-Expires"] = "0"
            response.vary.add("Cookie")
        return response
