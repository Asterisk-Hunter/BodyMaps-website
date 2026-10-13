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
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "false")
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
        # A documentation address rather than the client's default 127.0.0.1:
        # the sign-in and sign-up ceilings skip loopback callers, who cannot
        # be told apart behind a proxy.
        c.environ_base["REMOTE_ADDR"] = "192.0.2.10"
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


def test_login_is_throttled_per_account(client):
    client.post("/api/auth/register", json={"email": "guess@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(10):
        bad = client.post("/api/auth/login", json={"email": "guess@d.com", "password": "nope"})
        assert bad.status_code == 401
    # Past the ceiling even the right password waits, whatever the spelling.
    blocked = client.post("/api/auth/login", json={"email": " Guess@D.com ", "password": "password1"})
    assert blocked.status_code == 429
    assert "Too many sign-in attempts" in blocked.get_json()["error"]

    # Another account from the same address is still under its own ceiling.
    client.post("/api/auth/register", json={"email": "other@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    ok = client.post("/api/auth/login", json={"email": "other@d.com", "password": "password1"})
    assert ok.status_code == 200


def test_successful_sign_ins_never_count_toward_the_ceilings(client, monkeypatch):
    """A shared lab account, or a class behind one NAT, signs in many times
    with the right password; none of that may lock anyone out."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)
    client.post("/api/auth/register", json={"email": "lab@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(12):
        ok = client.post("/api/auth/login", json={"email": "lab@d.com", "password": "password1"})
        assert ok.status_code == 200
        client.post("/api/auth/logout")


def test_the_right_password_clears_the_account_count(client):
    client.post("/api/auth/register", json={"email": "typo@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(9):
        assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "password1"}).status_code == 200
    client.post("/api/auth/logout")
    # A fresh allowance: nine more typos still get a 401, not a lockout.
    for _ in range(9):
        assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "nope"}).status_code == 401


def test_failures_from_one_other_address_do_not_lock_the_owner_out(client):
    """Knowing someone's address must not be enough to keep them out: a stranger's
    failed guesses from one network count against that network, not the account."""
    client.post("/api/auth/register", json={"email": "owner@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    stranger = {"REMOTE_ADDR": "203.0.113.9"}
    for _ in range(10):
        bad = client.post("/api/auth/login", json={"email": "owner@d.com", "password": "nope"},
                          environ_base=stranger)
        assert bad.status_code == 401
    # The guesser is stopped, even with the right password...
    blocked = client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                          environ_base=stranger)
    assert blocked.status_code == 429
    # ...while the owner, from their own network, signs in as usual.
    ok = client.post("/api/auth/login", json={"email": "Owner@D.com", "password": "password1"},
                     environ_base={"REMOTE_ADDR": "198.51.100.7"})
    assert ok.status_code == 200


def test_an_account_wide_ceiling_still_slows_a_guesser_on_many_addresses(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_ACCOUNT", 15)
    client.post("/api/auth/register", json={"email": "spread@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for address, tries in (("203.0.113.1", 10), ("203.0.113.2", 5)):
        for _ in range(tries):
            assert client.post("/api/auth/login", json={"email": "spread@d.com", "password": "nope"},
                               environ_base={"REMOTE_ADDR": address}).status_code == 401
    third = client.post("/api/auth/login", json={"email": "spread@d.com", "password": "password1"},
                        environ_base={"REMOTE_ADDR": "203.0.113.3"})
    assert third.status_code == 429


def _fail_from_many_addresses(client, email, failures):
    """`failures` wrong passwords for `email`, ten from each of several addresses."""
    for index in range(failures):
        bad = client.post("/api/auth/login", json={"email": email, "password": "nope"},
                          environ_base={"REMOTE_ADDR": f"203.0.113.{index // 10 + 1}"})
        assert bad.status_code == 401


def test_failures_spread_over_many_addresses_do_not_lock_the_owner_out_where_they_signed_in(client, monkeypatch):
    """A guesser on many addresses fills the account-wide ceiling, but an address that
    has signed in to the account before is not held to it: the owner on a network they
    use still signs in, while a new address waits."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_ACCOUNT", 15)
    home = {"REMOTE_ADDR": "198.51.100.7"}
    client.post("/api/auth/register", json={"email": "owner@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                       environ_base=home).status_code == 200
    client.post("/api/auth/logout")

    _fail_from_many_addresses(client, "owner@d.com", 15)

    ok = client.post("/api/auth/login", json={"email": " Owner@D.com", "password": "password1"},
                     environ_base=home)
    assert ok.status_code == 200
    client.post("/api/auth/logout")
    new_address = client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                              environ_base={"REMOTE_ADDR": "192.0.2.50"})
    assert new_address.status_code == 429


def test_an_address_that_signed_in_before_keeps_its_own_ceilings(client, monkeypatch):
    """Only the account-wide ceiling is skipped: a known address still gets ten guesses
    at the account, and the per-address ceiling over all accounts still applies."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_ACCOUNT", 15)
    home = {"REMOTE_ADDR": "198.51.100.7"}
    client.post("/api/auth/register", json={"email": "known@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": "known@d.com", "password": "password1"},
                       environ_base=home).status_code == 200
    client.post("/api/auth/logout")
    _fail_from_many_addresses(client, "known@d.com", 15)

    for _ in range(10):
        assert client.post("/api/auth/login", json={"email": "known@d.com", "password": "nope"},
                           environ_base=home).status_code == 401
    assert client.post("/api/auth/login", json={"email": "known@d.com", "password": "password1"},
                       environ_base=home).status_code == 429

    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)
    client.post("/api/auth/register", json={"email": "lab@d.com", "password": "password1"},
                environ_base={"REMOTE_ADDR": "198.51.100.8"})
    client.post("/api/auth/logout")
    lab = {"REMOTE_ADDR": "198.51.100.8"}
    assert client.post("/api/auth/login", json={"email": "lab@d.com", "password": "password1"},
                       environ_base=lab).status_code == 200
    client.post("/api/auth/logout")
    for index in range(3):
        assert client.post("/api/auth/login", json={"email": f"spray{index}@d.com", "password": "nope"},
                           environ_base=lab).status_code == 401
    assert client.post("/api/auth/login", json={"email": "lab@d.com", "password": "password1"},
                       environ_base=lab).status_code == 429


def test_the_addresses_remembered_for_sign_ins_stay_bounded(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "_KNOWN_ADDRESSES_PER_ACCOUNT", 3)
    monkeypatch.setattr(bp_mod, "_KNOWN_ACCOUNTS", 2)
    for name in ("first", "second", "third"):
        client.post("/api/auth/register", json={"email": f"{name}@d.com", "password": "password1"})
        client.post("/api/auth/logout")
    for index in range(5):
        assert client.post("/api/auth/login", json={"email": "first@d.com", "password": "password1"},
                           environ_base={"REMOTE_ADDR": f"198.51.100.{index + 1}"}).status_code == 200
        client.post("/api/auth/logout")
    # Only the most recent addresses of an account are kept...
    assert list(bp_mod._known_addresses["first@d.com"]) == ["198.51.100.3", "198.51.100.4", "198.51.100.5"]
    for name in ("second", "third"):
        assert client.post("/api/auth/login", json={"email": f"{name}@d.com", "password": "password1"}).status_code == 200
        client.post("/api/auth/logout")
    # ...and of the accounts, the ones that signed in most recently.
    assert list(bp_mod._known_addresses) == ["second@d.com", "third@d.com"]


def test_the_sign_in_throttle_keeps_only_a_bounded_key_per_address(client):
    import api.auth_blueprint as bp_mod
    huge = "x" * 100_000 + "@d.com"
    assert client.post("/api/auth/login", json={"email": huge, "password": "nope"}).status_code == 401
    assert max(len(key) for key in bp_mod._login_limiter._buckets) < 400


def test_login_is_throttled_per_ip(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)

    codes = [
        client.post("/api/auth/login", json={"email": f"spray{i}@d.com", "password": "nope"}).status_code
        for i in range(4)
    ]
    assert codes == [401, 401, 401, 429]


def test_register_is_throttled_per_ip(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    from services import auth_store
    sent = []
    monkeypatch.setattr(bp_mod, "REGISTER_MAX_PER_IP", 2)
    monkeypatch.setattr(bp_mod.mailer, "send", lambda to, *_args: sent.append(to) or True)

    codes = [
        client.post("/api/auth/register", json={"email": f"new{i}@d.com", "password": "password1"}).status_code
        for i in range(3)
    ]
    assert codes == [201, 201, 429]
    assert sent == ["new0@d.com", "new1@d.com"]
    assert auth_store.authenticate("new2@d.com", "password1") is None


@pytest.mark.parametrize("address", ["127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "", "not-an-address"])
def test_a_caller_on_a_loopback_or_unreadable_address_has_no_address_for_the_throttle(client, address):
    import api.auth_blueprint as bp_mod
    from flask import Flask
    with Flask(__name__).test_request_context(environ_base={"REMOTE_ADDR": address}):
        assert bp_mod._client_address() is None


@pytest.mark.parametrize("address", ["203.0.113.5", "10.1.2.3", "2001:db8::7"])
def test_a_caller_on_a_real_address_keeps_it_for_the_throttle(client, address):
    import api.auth_blueprint as bp_mod
    from flask import Flask
    with Flask(__name__).test_request_context(environ_base={"REMOTE_ADDR": address}):
        assert bp_mod._client_address() == address


def test_failed_sign_ins_through_a_proxy_that_hides_addresses_never_lock_the_site_out(client, monkeypatch):
    """Behind a proxy that does not pass the visitor's address on, every request
    comes from loopback. The per-address ceilings would then be one ceiling for
    the whole site, so they do not apply to such a request."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)
    proxy = {"REMOTE_ADDR": "127.0.0.1"}
    client.post("/api/auth/register", json={"email": "owner@d.com", "password": "password1"},
                environ_base=proxy)
    client.post("/api/auth/logout")
    for index in range(5):
        assert client.post("/api/auth/login", json={"email": f"spray{index}@d.com", "password": "nope"},
                           environ_base=proxy).status_code == 401
    for _ in range(12):
        assert client.post("/api/auth/login", json={"email": "owner@d.com", "password": "nope"},
                           environ_base=proxy).status_code == 401
    ok = client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                     environ_base=proxy)
    assert ok.status_code == 200
    assert not any(key.startswith(("ip:", "account-ip:")) for key in bp_mod._login_limiter._buckets)
    assert "owner@d.com" not in bp_mod._known_addresses


def test_the_account_wide_ceiling_still_applies_when_callers_cannot_be_told_apart(client, monkeypatch):
    """Without an address there is no network the owner is known on, so the
    account-wide ceiling holds for every loopback caller, even after a sign-in."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_ACCOUNT", 15)
    proxy = {"REMOTE_ADDR": "127.0.0.1"}
    client.post("/api/auth/register", json={"email": "owner@d.com", "password": "password1"},
                environ_base=proxy)
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                       environ_base=proxy).status_code == 200
    client.post("/api/auth/logout")
    for _ in range(15):
        assert client.post("/api/auth/login", json={"email": "owner@d.com", "password": "nope"},
                           environ_base=proxy).status_code == 401
    blocked = client.post("/api/auth/login", json={"email": "owner@d.com", "password": "password1"},
                          environ_base=proxy)
    assert blocked.status_code == 429


def test_sign_ups_through_a_proxy_that_hides_addresses_are_not_capped_site_wide(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "REGISTER_MAX_PER_IP", 2)
    monkeypatch.setattr(bp_mod.mailer, "send", lambda *_args: True)
    codes = [
        client.post("/api/auth/register", json={"email": f"class{i}@d.com", "password": "password1"},
                    environ_base={"REMOTE_ADDR": "127.0.0.1"}).status_code
        for i in range(4)
    ]
    assert codes == [201, 201, 201, 201]


def test_a_lecture_behind_one_campus_address_can_all_sign_up_within_the_hour(client, monkeypatch):
    """Live rooms and Solo VQA Practice need an account, so a class signs up
    together, usually from one campus network address."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod.mailer, "send", lambda *_args: True)
    campus = {"REMOTE_ADDR": "198.51.100.40"}
    for i in range(80):
        assert client.post("/api/auth/register", json={"email": f"student{i}@d.com", "password": "password1"},
                           environ_base=campus).status_code == 201
        client.post("/api/auth/logout")


def test_the_signup_name_is_escaped_in_the_html_email(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    mails = []
    monkeypatch.setattr(
        bp_mod.mailer, "send",
        lambda to, subject, text, html: mails.append((text, html)) or True,
    )
    name = '<a href="https://evil.example">Click here</a>'

    r = client.post("/api/auth/register", json={
        "email": "phish@d.com", "password": "password1", "name": name,
    })
    assert r.status_code == 201
    client.post("/api/auth/logout")
    client.post("/api/auth/forgot-password", json={"email": "phish@d.com"})

    assert len(mails) == 2  # verification, then reset
    for text, html in mails:
        assert "&lt;a href=&quot;https://evil.example&quot;&gt;Click here&lt;/a&gt;" in html
        assert html.count("<a href=") == 1  # only the real link
        # The plain-text part is not HTML, so it carries the name as typed.
        assert text.startswith(f"Hi {name},")


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

def test_delete_jobs_keeps_the_account(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    # Upload page runs are looked for in their own folder; keep it in the test's.
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(tmp_path / "runs"))
    client.post("/api/auth/register", json={"email": "v@w.com", "password": "password1"})
    r = client.delete("/api/me/jobs")
    assert r.status_code == 200
    assert r.get_json()["deleted"] == {"jobs": 0, "files": 0, "runs": 0}
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


def test_local_auto_signin(client, monkeypatch):
    assert client.get("/api/auth/me").status_code == 401
    client.environ_base["REMOTE_ADDR"] = "127.0.0.1"
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "true")
    first = client.get("/api/auth/me")
    assert first.status_code == 200
    user = first.get_json()["user"]
    assert user["email"] == "developer@bodymaps.local"
    assert client.get("/api/auth/me").get_json()["user"]["id"] == user["id"]
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "false")
    client.delete_cookie("bm_session")
    assert client.get("/api/auth/me").status_code == 401


@pytest.mark.parametrize("kwargs", [
    {"base_url": "http://example.com"},
    {"environ_overrides": {"REMOTE_ADDR": "10.0.0.2"}},
    {"headers": {"Origin": "https://example.com"}},
])
def test_local_auto_signin_rejects_nonlocal_requests(client, monkeypatch, kwargs):
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "true")
    assert client.get("/api/auth/me", **kwargs).status_code == 401


def test_local_auto_signin_rejects_proxy_and_remote_database(client, monkeypatch):
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "true")
    monkeypatch.setenv("TRUST_PROXY", "true")
    assert client.get("/api/auth/me").status_code == 401
    monkeypatch.setenv("TRUST_PROXY", "false")
    from constants import Constants
    monkeypatch.setattr(Constants, "DATABASE_URL", "postgresql://example/db")
    assert client.get("/api/auth/me").status_code == 401


def test_normal_session_takes_precedence_over_local_account(client, monkeypatch):
    client.post("/api/auth/register", json={"email": "normal@example.test", "password": "password1"})
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "true")
    assert client.get("/api/auth/me").get_json()["user"]["email"] == "normal@example.test"
