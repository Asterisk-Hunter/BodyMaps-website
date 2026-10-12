"""End-to-end tests for the auth endpoints via a Flask test client.

Only the auth blueprint is registered (it doesn't pull in the heavy nibabel/
scipy stack), so the full register -> cookie -> me -> logout flow, the
require_auth guard, and /me/jobs are exercised without the whole app.
"""

import hashlib
import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'auth_ep.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.job_store  # noqa: F401
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as bp_mod
    importlib.reload(bp_mod)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(bp_mod.auth_blueprint, url_prefix="/api")
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def test_register_sets_cookie_and_me_works(client):
    r = client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})
    assert r.status_code == 201
    assert r.get_json()["user"]["email"] == "a@b.com"
    assert "bm_session" in r.headers.get("Set-Cookie", "")

    # cookie persists on the test client -> /me is authenticated
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.get_json()["user"]["email"] == "a@b.com"


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/me/jobs").status_code == 401


@pytest.mark.parametrize("remember_me", [None, False, True])
def test_session_persistence_requires_explicit_choice(client, remember_me):
    body = {"email": "remember@example.test", "password": "password1"}
    if remember_me is not None:
        body["remember_me"] = remember_me
    created = client.post("/api/auth/register", json=body)
    assert created.status_code == 201
    for response in (created, client.post("/api/auth/login", json=body)):
        cookie = response.headers["Set-Cookie"]
        assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
        assert ("Max-Age=1209600" in cookie) is (remember_me is True)
        assert ("Expires=" in cookie) is (remember_me is True)
    # Browser-retention preference never disables the server-side TTL.
    from models.engine import session_scope
    from models.auth_session import AuthSession
    from sqlalchemy import select
    with session_scope() as session:
        records = session.execute(select(AuthSession)).scalars().all()
        assert len(records) == 2
        assert all((record.expires_at - record.created_at).days == 14 for record in records)


@pytest.mark.parametrize("remember_me", ["false", "true", 1, None, {}, []])
def test_invalid_remember_me_does_not_create_a_session(client, remember_me):
    body = {"email": "invalid-remember@example.test", "password": "password1", "remember_me": remember_me}
    assert client.post("/api/auth/register", json=body).status_code == 400
    assert client.post("/api/auth/login", json=body).status_code == 400
    assert client.get("/api/auth/me").status_code == 401


def test_password_reset_does_not_implicitly_remember_the_browser(client):
    client.post("/api/auth/register", json={"email": "reset-cookie@example.test", "password": "password1", "remember_me": True})
    from services import auth_store
    _, token = auth_store.create_password_reset("reset-cookie@example.test")
    response = client.post("/api/auth/reset-password", json={"token": token, "password": "replacement-password"})
    assert response.status_code == 200
    cookie = response.headers["Set-Cookie"]
    assert "Max-Age=" not in cookie and "Expires=" not in cookie
    assert "HttpOnly" in cookie


def test_register_validation_and_duplicate(client):
    assert client.post("/api/auth/register", json={"email": "x@y.com", "password": "short"}).status_code == 400
    assert client.post("/api/auth/register", json={"email": "", "password": "password1"}).status_code == 400
    client.post("/api/auth/register", json={"email": "dup@y.com", "password": "password1"})
    dup = client.post("/api/auth/register", json={"email": "dup@y.com", "password": "password2"})
    assert dup.status_code == 409


def test_login_wrong_password(client):
    client.post("/api/auth/register", json={"email": "c@d.com", "password": "password1"})
    client.get("/api/auth/logout")  # drop the auto-login cookie
    bad = client.post("/api/auth/login", json={"email": "c@d.com", "password": "nope"})
    assert bad.status_code == 401
    good = client.post("/api/auth/login", json={"email": "c@d.com", "password": "password1"})
    assert good.status_code == 200


def test_admin_coupon_requires_authentication(client, monkeypatch):
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(b"local-admin-coupon").hexdigest(),
    )
    response = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": "local-admin-coupon"}
    )
    assert response.status_code == 401


def test_admin_coupon_grants_unlimited_plan_without_admin_role(client, monkeypatch):
    """The coupon unlocks model limits server-side but is not an admin role."""
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "coupon@example.com", "password": "password1",
    })

    invalid = client.post("/api/auth/redeem-admin-coupon", json={"coupon": "wrong"})
    assert invalid.status_code == 403

    redeemed = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": coupon}
    )
    assert redeemed.status_code == 200
    assert redeemed.get_json()["access"] == "admin_coupon"
    assert redeemed.get_json()["user"]["plan"] == "enterprise"
    assert redeemed.get_json()["user"]["roles"] == []

    usage = client.get("/api/me/usage").get_json()
    assert usage["plan"] == "enterprise"
    assert usage["limits"]["models"] is None


def test_admin_coupon_keeps_plan_unchanged_for_malformed_input(client, monkeypatch):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "malformed-coupon@example.com", "password": "password1",
    })

    for payload in ({}, {"coupon": 123}, {"coupon": ""}, {"coupon": "x" * 257}):
        response = client.post("/api/auth/redeem-admin-coupon", json=payload)
        assert response.status_code == 400
        assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"


def test_admin_coupon_rate_limits_failed_attempts(client, monkeypatch):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "rate-limited-coupon@example.com", "password": "password1",
    })

    responses = [
        client.post("/api/auth/redeem-admin-coupon", json={"coupon": "wrong"})
        for _ in range(6)
    ]
    assert [response.status_code for response in responses[:5]] == [403] * 5
    assert responses[5].status_code == 429
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"


def test_admin_coupon_persists_and_unblocks_both_media_models_without_admin_role(
    client, monkeypatch
):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    response = client.post("/api/auth/register", json={
        "email": "media-coupon@example.com", "password": "password1",
    })
    user_id = response.get_json()["user"]["id"]
    assert client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": coupon}
    ).status_code == 200

    from services import plan_store, role_store

    me = client.get("/api/auth/me").get_json()["user"]
    assert me["plan"] == "enterprise"
    assert me["roles"] == []
    assert not role_store.has_role(user_id, role_store.ROLE_ADMIN)
    assert plan_store.check_inference(user_id, "cads551") is None
    assert plan_store.check_inference(user_id, "cads552") is None


def test_brand_new_unpaid_account_coupon_unlocks_entitlements_without_admin_or_charge(
    client, monkeypatch
):
    from api.admin_blueprint import admin_blueprint
    from models.engine import session_scope
    from models.usage_event import UsageEvent
    from services import plan_store
    from sqlalchemy import func, select

    client.application.register_blueprint(admin_blueprint, url_prefix="/api")
    coupon = "disposable-new-user-coupon"
    monkeypatch.setenv("BODYMAPS_ADMIN_COUPON_SHA256", hashlib.sha256(coupon.encode()).hexdigest())
    credentials = {"email": "new-unpaid-coupon@example.test", "password": "password1"}
    created = client.post("/api/auth/register", json=credentials)
    assert created.status_code == 201
    user = created.get_json()["user"]
    assert user["plan"] == "free" and user["roles"] == []
    assert user["email_verified"] is False
    assert user["organization"] is None and user["occupation"] is None
    assert client.post("/api/me/plan", json={"plan": "enterprise"}).status_code == 403
    assert plan_store.check_inference(user["id"], "ePAI")["reason"] == "model_locked"
    assert plan_store.check_inference(user["id"], "ShapeKit")["reason"] == "postprocessing"

    redeemed = client.post("/api/auth/redeem-admin-coupon", json={"coupon": coupon})
    assert redeemed.status_code == 200
    assert redeemed.get_json()["user"]["plan"] == "enterprise"
    assert redeemed.get_json()["user"]["roles"] == []
    for model in ("ePAI", "Atlas-Net", "LesionSegmenter", "cads551", "cads552", "OpenVAE", "ShapeKit"):
        assert plan_store.check_inference(user["id"], model) is None
    usage = client.get("/api/me/usage").get_json()
    assert usage["limits"] == plan_store.PLAN_LIMITS["enterprise"]
    assert usage["scans"]["used"] == 0 and usage["ai_messages"]["used"] == 0
    assert client.get("/api/admin/people").status_code == 403
    assert client.post(f"/api/admin/people/{user['id']}/roles", json={"role": "admin"}).status_code == 403
    with session_scope() as session:
        assert session.scalar(select(func.count()).select_from(UsageEvent)) == 0

    # The grant survives a new authenticated session and a repeated valid code
    # is idempotent; it does not manufacture usage or an administrative role.
    assert client.post("/api/auth/logout").status_code == 200
    assert client.post("/api/auth/login", json=credentials).status_code == 200
    replay = client.post("/api/auth/redeem-admin-coupon", json={"coupon": f" {coupon} "})
    assert replay.status_code == 200
    assert replay.get_json()["user"]["plan"] == "enterprise"
    assert replay.get_json()["user"]["roles"] == []
    assert client.get("/api/admin/people").status_code == 403
    assert client.get("/api/me/usage").get_json()["scans"]["used"] == 0


@pytest.mark.parametrize("configured_digest", ["", "not-a-digest", "g" * 64, "a" * 63])
def test_admin_coupon_malformed_configuration_does_not_grant_access(client, monkeypatch, configured_digest):
    monkeypatch.setenv("BODYMAPS_ADMIN_COUPON_SHA256", configured_digest)
    client.post("/api/auth/register", json={"email": "bad-config@example.test", "password": "password1"})
    assert client.post("/api/auth/redeem-admin-coupon", json={"coupon": "anything"}).status_code == 503
    user = client.get("/api/auth/me").get_json()["user"]
    assert user["plan"] == "free" and user["roles"] == []


def test_admin_coupon_requires_server_configuration(client, monkeypatch):
    monkeypatch.delenv("BODYMAPS_ADMIN_COUPON_SHA256", raising=False)
    client.post("/api/auth/register", json={
        "email": "unconfigured@example.com", "password": "password1",
    })
    response = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": "anything"}
    )
    assert response.status_code == 503


def test_logout_clears_session(client):
    client.post("/api/auth/register", json={"email": "e@f.com", "password": "password1"})
    assert client.get("/api/auth/me").status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_me_jobs_empty_for_new_user(client):
    registered = client.post("/api/auth/register", json={"email": "g@h.com", "password": "password1"})
    r = client.get("/api/me/jobs")
    assert r.status_code == 200
    assert r.get_json() == {"user_id": registered.get_json()["user"]["id"], "jobs": []}


# ---- display name ---------------------------------------------------------

def test_register_accepts_a_name_and_me_returns_it(client):
    r = client.post("/api/auth/register",
                    json={"email": "n@o.com", "password": "password1", "name": "Ada Lovelace"})
    assert r.get_json()["user"]["name"] == "Ada Lovelace"
    assert client.get("/api/auth/me").get_json()["user"]["name"] == "Ada Lovelace"


def test_patch_me_updates_the_name(client):
    client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})
    assert client.get("/api/auth/me").get_json()["user"]["name"] is None

    r = client.patch("/api/auth/me", json={"name": "Grace Hopper"})
    assert r.status_code == 200
    assert r.get_json()["user"]["name"] == "Grace Hopper"
    assert client.get("/api/auth/me").get_json()["user"]["name"] == "Grace Hopper"


def test_patch_me_updates_the_profile_fields(client):
    client.post("/api/auth/register", json={"email": "p2@q.com", "password": "password1"})
    r = client.patch("/api/auth/me", json={
        "organization": "  Example University  ",
        "occupation": "Radiology resident",
        "role_description": "Annotating pancreas CTs for a research project",
    })
    assert r.status_code == 200
    u = r.get_json()["user"]
    assert u["organization"] == "Example University"     # trimmed
    assert u["occupation"] == "Radiology resident"
    assert u["role_description"].startswith("Annotating")

    # Blank clears back to "not provided"; other fields are untouched.
    r = client.patch("/api/auth/me", json={"organization": ""})
    assert r.get_json()["user"]["organization"] is None
    assert r.get_json()["user"]["occupation"] == "Radiology resident"

    # Wrong type is refused.
    assert client.patch("/api/auth/me", json={"occupation": 7}).status_code == 400


def test_patch_me_rejects_an_empty_body_and_a_non_string(client):
    client.post("/api/auth/register", json={"email": "r@s.com", "password": "password1"})
    assert client.patch("/api/auth/me", json={}).status_code == 400
    assert client.patch("/api/auth/me", json={"name": 42}).status_code == 400


def test_the_verified_researcher_journey_promotes_to_pro(client):
    from services import auth_store

    client.post("/api/auth/register", json={"email": "vr@x.com", "password": "password1"})
    body = client.get("/api/me/usage").get_json()
    assert body["plan"] == "free" and body["limits"]["daily_scans"] == 1

    client.patch("/api/auth/me", json={
        "organization": "Example University",
        "occupation": "Radiologist",
        "role_description": "Annotating CTs for a research project",
    })
    # A complete profile alone is not enough.
    assert client.get("/api/me/usage").get_json()["plan"] == "free"

    user_id = client.get("/api/auth/me").get_json()["user"]["id"]
    _, raw = auth_store.create_email_verification(user_id)
    assert client.post("/api/auth/verify-email", json={"token": raw}).status_code == 200

    body = client.get("/api/me/usage").get_json()
    assert body["plan"] == "pro"
    assert body["limits"]["daily_scans"] == 10
    # The stored column is untouched, and self-service plan writes stay closed.
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"
    assert client.post("/api/me/plan", json={"plan": "team"}).status_code == 403


def test_send_verification_requires_auth_and_verify_rejects_garbage(client):
    assert client.post("/api/auth/send-verification").status_code == 401
    r = client.post("/api/auth/verify-email", json={"token": "nope"})
    assert r.status_code == 400

    # Signed in and unverified: the endpoint reports honestly whether mail
    # left the building (unconfigured SMTP logs the link and says sent=False).
    client.post("/api/auth/register", json={"email": "v@w.com", "password": "password1"})
    r = client.post("/api/auth/send-verification")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True and body["already_verified"] is False


def test_account_endpoints_require_auth(client):
    assert client.patch("/api/auth/me", json={"name": "x"}).status_code == 401
    assert client.get("/api/me/export").status_code == 401
    assert client.delete("/api/me/jobs").status_code == 401
    assert client.delete("/api/me").status_code == 401


# ---- export ---------------------------------------------------------------

def test_export_returns_only_the_account_basics(client):
    client.post("/api/auth/register",
                json={"email": "t@u.com", "password": "password1", "name": "Ada"})
    r = client.get("/api/me/export")
    assert r.status_code == 200
    assert "attachment" in r.headers["Content-Disposition"]

    body = r.get_json()
    assert set(body) == {"exported_at", "account"}
    assert set(body["account"]) == {
        "email", "name", "account_type", "plan", "created_at",
        "organization", "occupation", "role_description",
    }
    assert body["account"]["email"] == "t@u.com"
    assert body["account"]["name"] == "Ada"
    assert body["account"]["plan"] == "free"
    assert "id" not in body["account"]        # nothing internal
    assert "jobs" not in body                 # no server paths
    assert "password_hash" not in str(body)   # never leak the hash


# ---- deletion -------------------------------------------------------------

def test_delete_jobs_keeps_the_account(client):
    client.post("/api/auth/register", json={"email": "v@w.com", "password": "password1"})
    r = client.delete("/api/me/jobs")
    assert r.status_code == 200
    assert r.get_json()["deleted"] == {"jobs": 0, "files": 0}
    assert client.get("/api/auth/me").status_code == 200  # still signed in


def test_delete_account_signs_out_and_reports_the_deadline(client):
    client.post("/api/auth/register", json={"email": "x@y.com", "password": "password1"})
    r = client.delete("/api/me")
    assert r.status_code == 200
    body = r.get_json()
    assert body["grace_days"] == 30
    assert body["restore_by"] > body["deletion_requested_at"]

    # session is gone
    assert client.get("/api/auth/me").status_code == 401


def test_signing_back_in_restores_a_deleted_account(client):
    client.post("/api/auth/register", json={"email": "z@a.com", "password": "password1"})
    client.delete("/api/me")
    assert client.get("/api/auth/me").status_code == 401

    back = client.post("/api/auth/login", json={"email": "z@a.com", "password": "password1"})
    assert back.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_new_account_reports_the_free_plan(client):
    r = client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})
    assert r.get_json()["user"]["plan"] == "free"


def test_plan_and_usage_require_auth(client):
    assert client.get("/api/me/usage").status_code == 401
    assert client.post("/api/me/plan", json={"plan": "pro"}).status_code == 401


def _register_admin(client, email="p@q.com"):
    """Register, stay signed in, and hold admin. The paid plans are closed to
    everyone else, so this is the only account that can change plan."""
    from services import role_store
    r = client.post("/api/auth/register", json={"email": email, "password": "password1"})
    user_id = r.get_json()["user"]["id"]
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    return user_id


def test_changing_plan_changes_the_reported_limits(client):
    _register_admin(client)

    r = client.post("/api/me/plan", json={"plan": "pro"})
    assert r.status_code == 200
    assert r.get_json()["user"]["plan"] == "pro"
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "pro"


def test_an_ordinary_account_is_held_on_free(client):
    """The paid plans aren't open yet. The picker greys them out; this is the
    half that matters, because a disabled button only stops a click."""
    client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})

    before = client.get("/api/me/usage").get_json()
    assert before["plan"] == "free"
    assert before["limits"]["daily_scans"] == 1
    assert before["limits"]["models"] == ["LesionSegmenter"]

    for plan in ("pro", "team", "enterprise"):
        assert client.post("/api/me/plan", json={"plan": plan}).status_code == 403

    # Still free, and still on free's limits.
    assert client.get("/api/me/usage").get_json()["plan"] == "free"
    assert client.post("/api/me/plan", json={"plan": "free"}).status_code == 200


def test_an_admin_reports_unlimited_whatever_plan_they_are_on(client):
    """Admins bypass the limits without their account changing plan."""
    _register_admin(client)
    usage = client.get("/api/me/usage").get_json()
    assert usage["plan"] == "free"
    assert usage["limits"]["daily_scans"] is None
    assert usage["limits"]["models"] is None


def test_unknown_plan_is_rejected(client):
    _register_admin(client)
    assert client.post("/api/me/plan", json={"plan": "platinum"}).status_code == 400
    assert client.post("/api/me/plan", json={}).status_code == 400
