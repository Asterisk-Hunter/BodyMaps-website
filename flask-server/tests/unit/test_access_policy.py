"""Production API admission contract, without importing app's startup jobs."""

from __future__ import annotations

import ast
import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask, jsonify, request

from api import auth
from api.access_policy import PUBLIC_ENDPOINT_METHODS, WORKER_ENDPOINT_METHODS, install_access_policy


API_ROOT = Path(__file__).resolve().parents[2] / "api"
BLUEPRINT_MODULES = {
    "api_blueprint.py": "api",
    "auth_blueprint.py": "auth",
    "oauth_blueprint.py": "oauth",
    "admin_blueprint.py": "admin",
    "analytics_blueprint.py": "analytics",
    "education.py": "education",
    "live_rooms.py": "live_rooms",
}


def _production_routes():
    """Use real registered names/rules; handlers are inert to avoid data reads."""
    routes = []
    for filename, blueprint in BLUEPRINT_MODULES.items():
        module = ast.parse((API_ROOT / filename).read_text(encoding="utf-8-sig"))
        for node in module.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                kind = decorator.func.attr
                if kind not in {"route", "get", "post", "put", "delete", "patch"} or not decorator.args:
                    continue
                rule = ast.literal_eval(decorator.args[0])
                methods = [kind.upper()] if kind != "route" else ["GET"]
                for keyword in decorator.keywords:
                    if keyword.arg == "methods":
                        methods = ast.literal_eval(keyword.value)
                routes.append((f"{blueprint}.{node.name}", rule, methods))
    return routes


ROUTES = _production_routes()
PRIVATE_ROUTES = [
    (endpoint, rule, method)
    for endpoint, rule, methods in ROUTES
    for method in methods
    if method not in PUBLIC_ENDPOINT_METHODS.get(endpoint, ())
]


@pytest.fixture
def policy_app(monkeypatch):
    monkeypatch.setattr(auth, "current_user", lambda: None)
    monkeypatch.delenv("WORKER_API_TOKEN", raising=False)
    app = Flask(__name__)
    app.config["TESTING"] = True
    calls = []

    def handler(**_kwargs):
        calls.append("executed")
        response = jsonify({"ok": True})
        response.headers["Cache-Control"] = "public, max-age=604800, immutable"
        response.headers["X-Accel-Redirect"] = "/_bodymaps_volume_pants/test.nii.gz"
        return response

    for endpoint, rule, methods in ROUTES:
        app.add_url_rule("/api" + rule, endpoint=endpoint, view_func=handler, methods=methods)
    app.add_url_rule("/api/new-feature", endpoint="future.handler", view_func=handler, methods=["GET", "POST", "OPTIONS"])
    app.add_url_rule("/assets/logo.svg", endpoint="logo", view_func=handler)
    install_access_policy(app)
    return app, calls


@pytest.mark.parametrize("endpoint,rule,method", PRIVATE_ROUTES, ids=[f"{m} {r}" for _, r, m in PRIVATE_ROUTES])
def test_every_nonpublic_production_route_requires_a_session(policy_app, endpoint, rule, method):
    app, calls = policy_app
    path = "/api" + re.sub(r"<[^>]+>", "test", rule)
    response = app.test_client().open(path, method=method)
    assert response.status_code == 401, endpoint
    assert response.get_json()["code"] == "authentication_required"
    assert calls == []


@pytest.mark.parametrize("endpoint,rule,method", [
    (endpoint, rule, method)
    for endpoint, rule, methods in ROUTES
    for method in methods
    if method in PUBLIC_ENDPOINT_METHODS.get(endpoint, ())
])
def test_account_entry_callbacks_and_health_remain_public(policy_app, endpoint, rule, method):
    app, calls = policy_app
    response = app.test_client().open("/api" + re.sub(r"<[^>]+>", "google", rule), method=method)
    assert response.status_code == 200, endpoint
    assert calls == ["executed"]


def test_allowlist_matches_real_routes_without_blanket_auth_exemption():
    endpoints = {endpoint for endpoint, _rule, _methods in ROUTES}
    assert PUBLIC_ENDPOINT_METHODS.keys() <= endpoints
    assert WORKER_ENDPOINT_METHODS.keys() <= endpoints
    assert "auth.redeem_admin_coupon" not in PUBLIC_ENDPOINT_METHODS
    assert "auth.avatar_file" not in PUBLIC_ENDPOINT_METHODS


def test_only_the_dataset_library_reads_are_open_to_guests_besides_account_and_health():
    """Browsing the library (list, filters, shuffle, counts, one thumbnail per case) is public; any
    other data route needs a session. Adding to this set is a deliberate access decision."""
    library = {"api.api_search", "api.api_facets", "api.api_random_topk_rotate_norand",
               "api.api_stats", "api.get_image_preview", "api.api_showcase"}
    assert library <= PUBLIC_ENDPOINT_METHODS.keys()
    for endpoint in library:
        assert PUBLIC_ENDPOINT_METHODS[endpoint] == frozenset({"GET", "HEAD"})
    public_data = {e for e in PUBLIC_ENDPOINT_METHODS if e.startswith("api.")} - library
    assert public_data == {"api.ping", "api.health"}
    for private in ("api.get_preview", "api.proxy_image", "api.get_main_nifti"):
        assert private not in PUBLIC_ENDPOINT_METHODS


def test_signed_out_visitors_can_send_usage_analytics_but_not_read_them():
    """Since the deny-by-default policy, signed-out analytics were refused with 401: zero
    anonymous events from 2026-10-12 on. collect is built for anonymous visitors; the
    dashboard endpoints are not."""
    analytics = {e for e in PUBLIC_ENDPOINT_METHODS if e.startswith("analytics.")}
    assert analytics == {"analytics.collect"}
    assert PUBLIC_ENDPOINT_METHODS["analytics.collect"] == frozenset({"POST"})
    for private in ("analytics.overview", "analytics.meta"):
        assert private not in PUBLIC_ENDPOINT_METHODS


def test_an_anonymous_collect_reaches_the_handler_and_a_dashboard_read_does_not(policy_app):
    app, calls = policy_app
    client = app.test_client()
    assert client.post("/api/analytics/collect", json={"events": []}).status_code == 200
    assert calls == ["executed"]
    calls.clear()
    assert client.get("/api/analytics/collect").status_code in (401, 405)
    for path in ("/api/analytics/overview", "/api/analytics/meta"):
        assert client.get(path).status_code == 401
    assert calls == []


def test_a_future_endpoint_is_private_and_preflight_never_executes_it(policy_app):
    app, calls = policy_app
    client = app.test_client()
    assert client.get("/api/new-feature").status_code == 401
    assert client.post("/api/new-feature").status_code == 401
    response = client.options("/api/new-feature")
    assert response.status_code == 200
    assert response.data == b""
    assert calls == []


def test_a_forged_cookie_or_room_key_does_not_replace_a_session(policy_app):
    app, calls = policy_app
    client = app.test_client()
    client.set_cookie("bm_session", "invented-session")
    response = client.get("/api/live-rooms/test", headers={"X-Room-Key": "valid-looking-capability"})
    assert response.status_code == 401
    assert calls == []


def test_authenticated_data_is_not_publicly_cacheable_and_keeps_accel_delivery(policy_app, monkeypatch):
    app, calls = policy_app
    monkeypatch.setattr(auth, "current_user", lambda: {"id": "signed-in-user"})
    response = app.test_client().get("/api/get-main-nifti/35.nii.gz")
    assert response.status_code == 200
    assert calls == ["executed"]
    assert response.headers["Cache-Control"] == "private, no-store, max-age=0"
    assert "Cookie" in response.vary
    assert response.headers["X-Accel-Expires"] == "0"
    assert response.headers["X-Accel-Redirect"] == "/_bodymaps_volume_pants/test.nii.gz"


def test_static_assets_are_outside_the_session_gate(policy_app):
    app, _calls = policy_app
    response = app.test_client().get("/assets/logo.svg")
    assert response.status_code == 200
    assert "immutable" in response.headers["Cache-Control"]


@pytest.mark.parametrize("upload_owner", ["previous-account", ""])
def test_changed_upload_owner_is_rejected_without_reading_body(policy_app, monkeypatch, upload_owner):
    app, calls = policy_app
    monkeypatch.setattr(auth, "current_user", lambda: {"id": "current-account"})

    class UnreadableBody:
        def read(self, *_args):
            raise AssertionError("The rejected upload body must not be read")

        readinto = read
        readline = read

    response = app.test_client().post(
        "/api/new-feature", headers={"X-Upload-Owner": upload_owner},
        environ_overrides={"wsgi.input": UnreadableBody(), "CONTENT_LENGTH": "100"},
    )
    assert response.status_code == 409
    assert response.get_json()["code"] == "account_changed"
    assert "account changed" in response.get_json()["error"]
    assert calls == []


@pytest.mark.parametrize("upload_owner", [None, "current-account"])
def test_matching_or_legacy_upload_owner_allows_authenticated_body(policy_app, monkeypatch, upload_owner):
    app, calls = policy_app
    monkeypatch.setattr(auth, "current_user", lambda: {"id": "current-account"})

    def upload_handler():
        calls.append(request.get_data())
        return jsonify({"ok": True})

    app.view_functions["future.handler"] = upload_handler
    headers = {} if upload_owner is None else {"X-Upload-Owner": upload_owner}
    response = app.test_client().post("/api/new-feature", headers=headers, data=b"scan")
    assert response.status_code == 200
    assert calls == [b"scan"]


def test_upload_owner_header_cannot_authenticate_a_guest(policy_app):
    app, calls = policy_app
    response = app.test_client().post("/api/new-feature", headers={"X-Upload-Owner": "current-account"})
    assert response.status_code == 401
    assert response.get_json()["code"] == "authentication_required"
    assert calls == []


@pytest.mark.parametrize("endpoint,rule,method", [
    (endpoint, rule, method)
    for endpoint, rule, methods in ROUTES
    for method in methods
    if method in WORKER_ENDPOINT_METHODS.get(endpoint, ())
])
def test_worker_routes_require_the_configured_token(policy_app, monkeypatch, endpoint, rule, method):
    app, calls = policy_app
    path = "/api" + re.sub(r"<[^>]+>", "test", rule)
    client = app.test_client()
    assert client.open(path, method=method, headers={"X-Worker-Token": "worker-secret"}).status_code == 401
    monkeypatch.setenv("WORKER_API_TOKEN", "worker-secret")
    assert client.open(path, method=method, headers={"X-Worker-Token": "wrong"}).status_code == 401
    assert calls == []
    assert client.open(path, method=method, headers={"X-Worker-Token": "worker-secret", "X-Upload-Owner": "unrelated-account"}).status_code == 200
    assert calls == ["executed"]


def test_worker_token_does_not_unlock_dataset_or_job_creation(policy_app, monkeypatch):
    app, calls = policy_app
    monkeypatch.setenv("WORKER_API_TOKEN", "worker-secret")
    headers = {"X-Worker-Token": "worker-secret"}
    assert app.test_client().get("/api/get-main-nifti/35.nii.gz", headers=headers).status_code == 401
    assert app.test_client().post("/api/jobs", headers=headers).status_code == 401
    assert calls == []


def test_nonroot_api_base_path_and_head_are_protected(monkeypatch):
    monkeypatch.setattr(auth, "current_user", lambda: None)
    app = Flask(__name__)
    app.add_url_rule("/bodymaps/api/data", endpoint="future.data", view_func=lambda: "secret")
    install_access_policy(app, api_prefix="/bodymaps/api")
    assert app.test_client().get("/bodymaps/api/data").status_code == 401
    assert app.test_client().head("/bodymaps/api/data").status_code == 401


def test_websocket_handshake_requires_a_valid_session_and_keeps_health_public(monkeypatch):
    import live_rooms_ws
    from websockets.datastructures import Headers

    resolved = []

    def resolve(token):
        resolved.append(token)
        return {"id": "user"} if token == "valid" else None

    monkeypatch.setattr(live_rooms_ws.auth_store, "resolve_session", resolve)
    monkeypatch.setattr(live_rooms_ws, "_active_service", SimpleNamespace(ready=True))

    async def check():
        path = "/ws/live-rooms/12345678-1234-1234-1234-123456789abc"
        guest = await live_rooms_ws.process_request(None, SimpleNamespace(path=path, headers=Headers()))
        assert guest.status_code == 401
        invalid = await live_rooms_ws.process_request(None, SimpleNamespace(path=path, headers=Headers({"Cookie": "bm_session=expired"})))
        assert invalid.status_code == 401
        valid = await live_rooms_ws.process_request(None, SimpleNamespace(path=path, headers=Headers({"Cookie": "bm_session=valid"})))
        assert valid is None
        health = await live_rooms_ws.process_request(None, SimpleNamespace(path="/health", headers=Headers()))
        assert health.status_code == 200

    asyncio.run(check())
    assert resolved == ["expired", "valid"]
