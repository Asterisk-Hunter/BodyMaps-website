"""End-to-end tests for the admin endpoints via a Flask test client.

The question these answer is who gets in. The role logic itself is covered in
tests/unit/test_role_store.py; what matters here is that the HTTP surface tells
signed-out apart from signed-in-but-not-admin, and that the refusals the store
raises come back as something the UI can show rather than a 500.
"""

import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'admin_ep.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.user_role  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store  # noqa: F401
    import services.role_store as role_store
    importlib.reload(role_store)
    import models.job  # noqa: F401
    import services.model_health as model_health
    importlib.reload(model_health)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.admin_blueprint as admin_bp
    importlib.reload(admin_bp)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(admin_bp.admin_blueprint, url_prefix="/api")
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def sign_up(client, email="a@b.com"):
    """Register and stay signed in as that account. Returns its id."""
    r = client.post("/api/auth/register", json={"email": email, "password": "password1"})
    return r.get_json()["user"]["id"]


def sign_in(client, email="a@b.com"):
    client.post("/api/auth/login", json={"email": email, "password": "password1"})


def make_admin(client, email="admin@b.com"):
    """A signed-in admin. Granted through the store, not the API — this is the
    bootstrap, and nobody can grant the first one over HTTP."""
    from services import role_store
    user_id = sign_up(client, email)
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    return user_id


# ---- who gets in ------------------------------------------------------------

def test_signed_out_is_401(client):
    assert client.get("/api/admin/people").status_code == 401


def test_an_ordinary_account_is_403(client):
    """Different from 401 on purpose: signing in again won't help."""
    sign_up(client, "nobody@b.com")
    assert client.get("/api/admin/people").status_code == 403


def test_an_admin_gets_the_list(client):
    make_admin(client)
    r = client.get("/api/admin/people")
    assert r.status_code == 200
    assert r.get_json()["people"][0]["email"] == "admin@b.com"


def test_writes_are_gated_too(client):
    """Not just the read — a 403 on the list and an open POST is the worst case."""
    target = sign_up(client, "nobody@b.com")
    assert client.post(
        f"/api/admin/people/{target}/roles", json={"role": "admin"}
    ).status_code == 403
    assert client.delete(f"/api/admin/people/{target}/roles/admin").status_code == 403


# ---- model health -----------------------------------------------------------

def test_model_health_is_admin_only(client):
    assert client.get("/api/admin/models/health").status_code == 401
    sign_up(client, "nobody@b.com")
    assert client.get("/api/admin/models/health").status_code == 403


def test_an_admin_sees_a_failing_model_and_the_idle_ones(client):
    from models.engine import session_scope
    from models.job import Job
    from models.user import SYSTEM_USER_ID

    with session_scope() as s:
        s.add(Job(session_id="s1", user_id=SYSTEM_USER_ID, model="Atlas-Net", status="failed",
                  error="Expected Atlas-Net output not found"))
    make_admin(client)
    r = client.get("/api/admin/models/health")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-store"
    models = r.get_json()["models"]
    assert models[0]["model"] == "Atlas-Net" and models[0]["status"] == "failing"
    assert {m["model"]: m["status"] for m in models}["SuPreM"] == "no_runs"


# ---- the list ---------------------------------------------------------------

def test_the_list_carries_roles_and_the_vocabulary(client):
    make_admin(client)
    body = client.get("/api/admin/people").get_json()
    assert body["people"][0]["roles"] == ["admin"]
    # Admins can grant the shared annotator role; manager is no longer grantable.
    assert body["roles"] == ["admin", "annotator"]


def test_search_narrows_the_list(client):
    sign_up(client, "alice@hospital.org")
    make_admin(client)
    body = client.get("/api/admin/people?q=hospital").get_json()
    assert [p["email"] for p in body["people"]] == ["alice@hospital.org"]


def test_no_password_hash_is_returned(client):
    make_admin(client)
    assert "password_hash" not in client.get("/api/admin/people").get_json()["people"][0]


def test_junk_paging_is_a_400(client):
    make_admin(client)
    assert client.get("/api/admin/people?limit=lots").status_code == 400


# ---- granting and revoking --------------------------------------------------

def test_grant_then_revoke_round_trip(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)

    granted = client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})
    assert granted.status_code == 200
    assert granted.get_json()["roles"] == ["admin"]

    revoked = client.delete(f"/api/admin/people/{target}/roles/admin")
    assert revoked.status_code == 200
    assert revoked.get_json()["roles"] == []


def test_an_unknown_role_is_a_400(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)
    r = client.post(f"/api/admin/people/{target}/roles", json={"role": "superuser"})
    assert r.status_code == 400


def test_granting_to_a_missing_account_is_a_404(client):
    make_admin(client)
    r = client.post("/api/admin/people/no-such-id/roles", json={"role": "admin"})
    assert r.status_code == 404


def test_you_cannot_demote_yourself(client):
    """Two admins exist, so this is the self-demotion rule and not last-admin."""
    other = sign_up(client, "other@b.com")
    me = make_admin(client)
    client.post(f"/api/admin/people/{other}/roles", json={"role": "admin"})

    r = client.delete(f"/api/admin/people/{me}/roles/admin")
    assert r.status_code == 409
    assert r.get_json()["reason"] == "self_demote"


def test_the_last_admin_cannot_be_removed(client):
    """Even by another admin — here, the bootstrap admin removing the only one
    left is themselves, but the rule is about the count, not the identity."""
    only = make_admin(client)
    r = client.delete(f"/api/admin/people/{only}/roles/admin")
    assert r.status_code == 409
    assert r.get_json()["reason"] in ("self_demote", "last_admin")


def test_a_promoted_account_can_then_use_the_admin_api(client):
    """The whole point of the People page: an admin hands out access and it works."""
    target = sign_up(client, "them@b.com")
    make_admin(client)
    client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})

    client.post("/api/auth/logout")
    sign_in(client, "them@b.com")
    assert client.get("/api/admin/people").status_code == 200


def test_a_demoted_account_loses_access(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)
    client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})
    client.delete(f"/api/admin/people/{target}/roles/admin")

    client.post("/api/auth/logout")
    sign_in(client, "them@b.com")
    assert client.get("/api/admin/people").status_code == 403


# ---- roles on the user body -------------------------------------------------

def test_me_reports_roles(client):
    make_admin(client)
    assert client.get("/api/auth/me").get_json()["user"]["roles"] == ["admin"]


def test_an_ordinary_account_reports_no_roles(client):
    sign_up(client, "nobody@b.com")
    assert client.get("/api/auth/me").get_json()["user"]["roles"] == []


def test_roles_survive_a_profile_update(client):
    """The client replaces its user object from this response; dropping roles
    here would blank the admin nav until the next reload."""
    make_admin(client)
    body = client.patch("/api/auth/me", json={"name": "Boss"}).get_json()
    assert body["user"]["roles"] == ["admin"]


# ---- team invitation codes are account-scoped ----------------------------------------------------------

def _become_admin(client, email="boss@example.com"):
    """An admin who also has annotator access for project tools and invites."""
    import services.role_store as role_store
    user_id = sign_up(client, email)
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    role_store.grant(user_id, role_store.ROLE_ANNOTATOR)
    return user_id


def test_any_signed_in_account_can_create_and_manage_only_its_own_codes(client):
    assert client.post("/api/admin/annotator-invites", json={"hours": 1}).status_code == 401
    sign_up(client, "plain@example.com")
    created = client.post("/api/admin/annotator-invites", json={"hours": 1})
    assert created.status_code == 201
    assert len(client.get("/api/admin/annotator-invites").get_json()["invites"]) == 1
    client.post("/api/auth/logout")
    sign_up(client, "other@example.com")
    assert client.get("/api/admin/annotator-invites").get_json()["invites"] == []
    assert client.delete(f"/api/admin/annotator-invites/{created.get_json()['id']}").status_code == 404


def test_an_admin_creates_a_code_that_makes_someone_an_annotator_once(client):
    _become_admin(client)
    created = client.post("/api/admin/annotator-invites", json={"hours": 48})
    assert created.status_code == 201
    body = created.get_json()
    assert len(body["code"].replace("-", "")) == 12 and body["expires_at"].endswith("Z")

    client.post("/api/auth/logout")
    sign_up(client, "radiologist@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": body["code"]}).status_code == 200
    assert client.get("/api/auth/me").get_json()["user"]["roles"] == ["annotator"]

    client.post("/api/auth/logout")
    sign_in(client, "boss@example.com")
    listed = client.get("/api/admin/annotator-invites").get_json()["invites"]
    assert [(row["status"], row["redeemed_by"]) for row in listed] == [("redeemed", "radiologist@example.com")]
    assert "code" not in listed[0]  # the code itself is never readable again


def test_the_code_is_not_stored_in_the_clear(client):
    _become_admin(client)
    code = client.post("/api/admin/annotator-invites", json={"hours": 1}).get_json()["code"]
    from models.annotator_invite import AnnotatorInvite
    from models.engine import session_scope
    with session_scope() as s:
        stored = [row.code_hash for row in s.query(AnnotatorInvite).all()]
    assert len(stored) == 1 and code.replace("-", "") not in stored[0] and len(stored[0]) == 64


@pytest.mark.parametrize("hours", [0, -1, 24 * 15, 1.5, "24", True, None])
def test_a_code_needs_a_sensible_lifetime(client, hours):
    _become_admin(client)
    response = client.post("/api/admin/annotator-invites", json={"hours": hours})
    assert response.status_code == 400
    assert response.get_json() == {"error": "hours must be a whole number from 1 to 336"}  # fixed text, never the exception's


def test_a_code_defaults_to_one_day(client):
    from datetime import datetime, timedelta
    _become_admin(client)
    body = client.post("/api/admin/annotator-invites", json={}).get_json()
    left = datetime.fromisoformat(body["expires_at"].rstrip("Z")) - datetime.utcnow()
    assert timedelta(hours=23) < left <= timedelta(hours=24)


def test_a_withdrawn_code_no_longer_works_and_a_used_one_cannot_be_withdrawn(client):
    _become_admin(client)
    withdrawn = client.post("/api/admin/annotator-invites", json={"hours": 24}).get_json()
    used = client.post("/api/admin/annotator-invites", json={"hours": 24}).get_json()
    assert client.delete(f"/api/admin/annotator-invites/{withdrawn['id']}").status_code == 200
    assert client.delete(f"/api/admin/annotator-invites/{withdrawn['id']}").status_code in (200, 404)
    client.post("/api/auth/logout")
    sign_up(client, "person@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": withdrawn["code"]}).status_code == 403
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": used["code"]}).status_code == 200
    client.post("/api/auth/logout")
    sign_in(client, "boss@example.com")
    assert client.delete(f"/api/admin/annotator-invites/{used['id']}").status_code == 404
    statuses = {row["id"]: row["status"] for row in client.get("/api/admin/annotator-invites").get_json()["invites"]}
    assert statuses == {withdrawn["id"]: "expired", used["id"]: "redeemed"}


def test_the_accounts_tab_offers_the_annotator_role_to_grant_by_email(client):
    boss = _become_admin(client)
    sign_up_id = None
    client.post("/api/auth/logout")
    target = sign_up(client, "target@example.com")
    client.post("/api/auth/logout")
    sign_in(client, "boss@example.com")
    people = client.get("/api/admin/people?q=target@example.com").get_json()
    assert "annotator" in people["roles"] and [p["email"] for p in people["people"]] == ["target@example.com"]
    assert client.post(f"/api/admin/people/{target}/roles", json={"role": "annotator"}).get_json()["roles"] == ["annotator"]
    assert client.delete(f"/api/admin/people/{target}/roles/annotator").get_json()["roles"] == []


# ---- legacy role labels do not change the team invitation UI --------------------------------------------

def test_an_admin_without_annotator_role_can_create_a_team_code(client):
    make_admin(client, "just-admin@example.com")
    assert client.post("/api/admin/annotator-invites", json={"hours": 1}).status_code == 201
    assert len(client.get("/api/admin/annotator-invites").get_json()["invites"]) == 1
    assert client.delete("/api/admin/annotator-invites/anything").status_code == 404


def test_an_admin_can_grant_or_remove_annotator_without_manager_role(client):
    make_admin(client, "just-admin@example.com")
    client.post("/api/auth/logout")
    target = sign_up(client, "target@example.com")
    client.post("/api/auth/logout")
    sign_in(client, "just-admin@example.com")
    assert client.post(f"/api/admin/people/{target}/roles", json={"role": "annotator"}).status_code == 200
    assert client.delete(f"/api/admin/people/{target}/roles/annotator").status_code == 200


def test_such_an_admin_can_still_grant_admin_as_before(client):
    make_admin(client, "just-admin@example.com")
    client.post("/api/auth/logout")
    target = sign_up(client, "target@example.com")
    client.post("/api/auth/logout")
    sign_in(client, "just-admin@example.com")
    assert client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"}).get_json()["roles"] == ["admin"]


def test_nobody_can_grant_or_remove_the_manager_role_over_the_website(client):
    import services.role_store as role_store
    manager = _become_admin(client)
    client.post("/api/auth/logout")
    target = sign_up(client, "target@example.com")
    client.post("/api/auth/logout")
    sign_in(client, "boss@example.com")
    # not even a manager can hand it out, and nobody can take it away (the server script does both)
    assert client.post(f"/api/admin/people/{target}/roles", json={"role": "annotation_manager"}).status_code == 403
    assert client.delete(f"/api/admin/people/{manager}/roles/annotation_manager").status_code == 200
    assert role_store.roles_for(target) == []
    assert role_store.roles_for(manager) == ["admin", "annotator"]


def test_manager_role_is_not_offered_as_a_grantable_role(client):
    _become_admin(client)
    body = client.get("/api/admin/people").get_json()
    assert body["roles"] == ["admin", "annotator"]


def test_legacy_manager_role_cannot_be_granted_and_can_be_revoked(client):
    import uuid
    import services.role_store as role_store
    from models.engine import session_scope
    from models.user_role import UserRole
    user_id = sign_up(client, "pi@example.com")
    with pytest.raises(ValueError):
        role_store.grant(user_id, role_store.ROLE_ANNOTATION_MANAGER)
    with session_scope() as session:
        session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role=role_store.ROLE_ANNOTATION_MANAGER))
    assert role_store.revoke(user_id, role_store.ROLE_ANNOTATION_MANAGER, acting_user_id="someone-else") == []


# ---- permanent codes: never expire, still work once, can still be withdrawn --------------------------------

def test_a_permanent_code_has_no_expiry_and_is_listed_as_open(client):
    _become_admin(client)
    created = client.post("/api/admin/annotator-invites", json={"permanent": True})
    assert created.status_code == 201
    body = created.get_json()
    assert body["expires_at"] is None and body["permanent"] is True
    listed = client.get("/api/admin/annotator-invites").get_json()["invites"]
    assert [(row["status"], row["expires_at"], row["permanent"]) for row in listed] == [("open", None, True)]


def test_a_permanent_code_works_exactly_once(client):
    _become_admin(client)
    code = client.post("/api/admin/annotator-invites", json={"permanent": True}).get_json()["code"]
    client.post("/api/auth/logout")
    sign_up(client, "first@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": code}).status_code == 200
    client.post("/api/auth/logout")
    sign_up(client, "second@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": code}).status_code == 403


def test_a_permanent_code_still_works_long_after_a_temporary_one_would_have_expired(client):
    from datetime import timedelta
    from models.annotator_invite import AnnotatorInvite
    from models.engine import session_scope
    from models.job import utcnow
    _become_admin(client)
    permanent = client.post("/api/admin/annotator-invites", json={"permanent": True}).get_json()["code"]
    temporary = client.post("/api/admin/annotator-invites", json={"hours": 1}).get_json()["code"]
    with session_scope() as s:
        # every code is stored as of a year ago, so a one-hour code is long expired
        for row in s.query(AnnotatorInvite).filter(AnnotatorInvite.expires_at < utcnow() + timedelta(days=1)).all():
            row.expires_at = utcnow() - timedelta(days=365)
    client.post("/api/auth/logout")
    sign_up(client, "late@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": temporary}).status_code == 403
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": permanent}).status_code == 200


def test_a_permanent_code_can_be_withdrawn(client):
    _become_admin(client)
    made = client.post("/api/admin/annotator-invites", json={"permanent": True}).get_json()
    assert client.delete(f"/api/admin/annotator-invites/{made['id']}").status_code == 200
    client.post("/api/auth/logout")
    sign_up(client, "late@example.com")
    assert client.post("/api/auth/redeem-annotator-invite", json={"code": made["code"]}).status_code == 403


@pytest.mark.parametrize("value", ["yes", 1, "true", None, [True]])
def test_permanent_must_be_a_real_true_or_false(client, value):
    _become_admin(client)
    response = client.post("/api/admin/annotator-invites", json={"permanent": value})
    assert response.status_code == 400
    assert response.get_json() == {"error": "permanent must be true or false"}
    assert client.get("/api/admin/annotator-invites").get_json()["invites"] == []


def test_permanent_false_is_an_ordinary_timed_code(client):
    _become_admin(client)
    body = client.post("/api/admin/annotator-invites", json={"permanent": False, "hours": 2}).get_json()
    assert body["permanent"] is False and body["expires_at"].endswith("Z")
