"""Endpoint tests for the OAuth routes.

The provider round-trip itself isn't exercised (that needs real credentials and
a browser), so these cover the parts we own: the providers-discovery endpoint,
unknown-provider handling, and that the app degrades safely when no OAuth
credentials are configured.
"""

import importlib

import pytest


def _make_client(tmp_path, monkeypatch, configured: bool):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'oauth_ep.db'}")
    if configured:
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-google-id")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-google-secret")
        monkeypatch.setenv("GITHUB_CLIENT_ID", "test-github-id")
        monkeypatch.setenv("GITHUB_CLIENT_SECRET", "test-github-secret")
    else:
        # Empty, not deleted: the constants reload below re-runs load_dotenv,
        # which would refill a *missing* key from a developer's real .env and
        # make this "unconfigured" client look configured. load_dotenv leaves an
        # existing key alone, and "" is falsy to the provider check either way.
        for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
                  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"):
            monkeypatch.setenv(k, "")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.oauth_identity  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.oauth_blueprint as oauth_mod
    importlib.reload(oauth_mod)

    engine.reset_engine_for_tests()
    engine.create_all()

    from flask import Flask
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "test-secret"
    oauth_mod.init_oauth(app)
    app.register_blueprint(oauth_mod.oauth_blueprint, url_prefix="/api")
    return app.test_client(), engine


@pytest.fixture()
def configured_client(tmp_path, monkeypatch):
    client, engine = _make_client(tmp_path, monkeypatch, configured=True)
    yield client
    engine.reset_engine_for_tests()


@pytest.fixture()
def unconfigured_client(tmp_path, monkeypatch):
    client, engine = _make_client(tmp_path, monkeypatch, configured=False)
    yield client
    engine.reset_engine_for_tests()


def test_providers_reports_configured(configured_client):
    body = configured_client.get("/api/auth/oauth/providers").get_json()
    assert body == {"google": True, "github": True}


def test_providers_reports_unconfigured(unconfigured_client):
    body = unconfigured_client.get("/api/auth/oauth/providers").get_json()
    assert body == {"google": False, "github": False}


def test_start_redirects_to_provider_when_configured(configured_client):
    r = configured_client.get("/api/auth/oauth/google")
    assert r.status_code in (302, 303)
    assert "accounts.google.com" in r.headers["Location"]


def test_start_503_when_not_configured(unconfigured_client):
    assert unconfigured_client.get("/api/auth/oauth/google").status_code == 503


def test_unknown_provider_404(configured_client):
    assert configured_client.get("/api/auth/oauth/facebook").status_code == 404
    assert configured_client.get("/api/auth/oauth/facebook/callback").status_code == 404


def test_callback_without_state_redirects_with_error(configured_client):
    """A callback with no valid `state` (CSRF check) must not 500 — it bounces
    back to the frontend with an error message."""
    r = configured_client.get("/api/auth/oauth/google/callback?code=abc")
    assert r.status_code in (302, 303)
    assert "auth_error" in r.headers["Location"]


def test_start_accepts_next_and_still_redirects_to_provider(configured_client):
    from urllib.parse import urlparse

    r = configured_client.get("/api/auth/oauth/google?next=%2Fcase%2F35")
    assert r.status_code in (302, 303)
    # Parse the host rather than substring-matching it (a bare `in` check reads
    # as an incomplete URL sanitizer to static analysis).
    assert urlparse(r.headers["Location"]).hostname == "accounts.google.com"


def test_safe_next_only_allows_same_site_relative_paths():
    import api.oauth_blueprint as oauth_mod

    # Kept as-is.
    assert oauth_mod._safe_next("/case/35") == "/case/35"
    assert oauth_mod._safe_next("/session/abc?hd=1#note") == "/session/abc?hd=1#note"
    # Rejected -> "" (falls back to the app root).
    for bad in (
        None, "", "case/35", "//evil.com", "/\\evil.com", "https://evil.com",
        "/%2f%2fevil.com", "/foo\r\nSet-Cookie: x=y", "/" + "a" * 600,
    ):
        assert oauth_mod._safe_next(bad) == "", bad


@pytest.fixture()
def local_provider(monkeypatch):
    """Keep provider traffic offline while exercising our signed-cookie flow."""
    from flask import redirect
    import api.oauth_blueprint as oauth_mod

    class Provider:
        def authorize_redirect(self, redirect_uri, *, state):
            return redirect(f"https://accounts.google.com/authorize?state={state}")

        def authorize_access_token(self):
            # State/token verification remains Authlib's responsibility. These
            # tests exercise only how this app preserves the retention choice.
            return {"userinfo": {"sub": "remember-user", "email": "remember@example.test", "email_verified": True}}

    monkeypatch.setattr(oauth_mod.oauth, "create_client", lambda _: Provider())


@pytest.mark.parametrize("remember", ["0", "1"])
def test_oauth_remember_me_is_preserved_and_callback_cannot_override_it(configured_client, local_provider, remember):
    from urllib.parse import parse_qs, urlparse
    started = configured_client.get(f"/api/auth/oauth/google?remember_me={remember}&next=/dashboard")
    state = parse_qs(urlparse(started.headers["Location"]).query)["state"][0]
    with configured_client.session_transaction() as signed_session:
        assert signed_session["oauth_preferences"][state]["remember_me"] is (remember == "1")
    finished = configured_client.get(f"/api/auth/oauth/google/callback?state={state}&remember_me={'0' if remember == '1' else '1'}")
    assert finished.status_code == 302
    assert finished.headers["Location"].endswith("/dashboard")
    cookie = next(value for value in finished.headers.getlist("Set-Cookie") if value.startswith("bm_session="))
    assert ("Max-Age=1209600" in cookie) is (remember == "1")
    with configured_client.session_transaction() as signed_session:
        assert state not in signed_session["oauth_preferences"]


def test_oauth_remember_me_is_bound_to_each_login_tab(configured_client, local_provider):
    from urllib.parse import parse_qs, urlparse
    states = []
    for remember, next_path in (("0", "/case/35"), ("1", "/dashboard")):
        start = configured_client.get(f"/api/auth/oauth/google?remember_me={remember}&next={next_path}")
        states.append(parse_qs(urlparse(start.headers["Location"]).query)["state"][0])
    finished = configured_client.get(f"/api/auth/oauth/google/callback?state={states[0]}")
    assert finished.headers["Location"].endswith("/case/35")
    cookie = next(value for value in finished.headers.getlist("Set-Cookie") if value.startswith("bm_session="))
    assert "Max-Age=" not in cookie
    with configured_client.session_transaction() as signed_session:
        assert signed_session["oauth_preferences"][states[1]]["remember_me"] is True


def test_oauth_remember_me_rejects_invalid_choice(configured_client, local_provider):
    assert configured_client.get("/api/auth/oauth/google?remember_me=yes").status_code == 400


@pytest.mark.parametrize("failed", [False, True], ids=["successful-login", "provider-error"])
def test_oauth_return_keeps_live_room_query_and_fragment(configured_client, local_provider, monkeypatch, failed):
    from urllib.parse import parse_qs, urlencode, urlsplit
    import api.oauth_blueprint as oauth_mod
    if failed:
        provider = oauth_mod.oauth.create_client("google")
        def cancelled():
            raise ValueError("Synthetic provider cancellation")
        monkeypatch.setattr(provider, "authorize_access_token", cancelled)
        monkeypatch.setattr(oauth_mod.oauth, "create_client", lambda _: provider)
    target = "/live/example?mode=review#key"
    started = configured_client.get("/api/auth/oauth/google?" + urlencode({"next": target}))
    state = parse_qs(urlsplit(started.headers["Location"]).query)["state"][0]
    finished = configured_client.get("/api/auth/oauth/google/callback?" + urlencode({"state": state}))
    assert finished.status_code == 302
    location = urlsplit(finished.headers["Location"])
    assert location.path == "/live/example"
    assert location.fragment == "key"
    query = parse_qs(location.query)
    assert query["mode"] == ["review"]
    assert ("auth_error" in query) is failed
    if failed:
        assert query["auth_error"] == ["Sign-in was cancelled or failed. Please try again."]
        assert not any(cookie.startswith("bm_session=") for cookie in finished.headers.getlist("Set-Cookie"))
