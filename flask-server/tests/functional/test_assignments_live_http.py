"""The assignments API over real HTTP: a threaded server, real sign-ins and cookies, 50 radiologists and a manager
all working at once. The Flask test client cannot show connection-level problems (cookies per client, threads
sharing the database); this can."""

import importlib
import threading

import pytest
import requests
from werkzeug.serving import make_server

PEOPLE = 50
CASES_EACH = 20


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'live.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)
    monkeypatch.setenv("RATE_LIMIT_DISABLED", "1")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.user_role  # noqa: F401
    import models.annotation_assignment  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.role_store as role_store
    importlib.reload(role_store)
    import models.job  # noqa: F401
    import services.assignment_store as assignment_store
    importlib.reload(assignment_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.assignments_blueprint as asg_bp
    importlib.reload(asg_bp)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(asg_bp.assignments_blueprint, url_prefix="/api")
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_port}/api", role_store
    srv.shutdown()
    engine.reset_engine_for_tests()


def _login(base, email):
    s = requests.Session()
    r = s.post(f"{base}/auth/register", json={"email": email, "password": "password1"})
    assert r.status_code in (200, 201), r.text
    return s, r.json()["user"]["id"]


def test_fifty_radiologists_and_a_manager_at_once(server):
    base, roles = server
    mgr, mgr_id = _login(base, "manager@b.com")
    sessions, ids = [], []
    for i in range(PEOPLE):
        s, uid = _login(base, f"r{i}@b.com")
        roles.grant(uid, roles.ROLE_ANNOTATOR)
        sessions.append(s)
        ids.append(uid)

    # A signed-in creator splits 1..1000 between fifty joined annotators: twenty cases each.
    people = mgr.get(f"{base}/assignments/people").json()["people"]
    assert len(people) == PEOPLE
    made = {}
    for i, uid in enumerate(ids):
        r = mgr.post(f"{base}/assignments", json={"assignee_id": uid, "start": 1 + i * CASES_EACH, "end": (i + 1) * CASES_EACH, "task": "Veins"})
        assert r.status_code == 201, r.text
        made[uid] = r.json()["id"]
    assert len(mgr.get(f"{base}/assignments").json()["assignments"]) == PEOPLE

    errors, statuses, lock = [], [], threading.Lock()

    def radiologist(i):
        s, uid = sessions[i], ids[i]
        try:
            mine = s.get(f"{base}/assignments/mine").json()["assignments"]
            assert [a["id"] for a in mine] == [made[uid]]
            for case in range(1 + i * CASES_EACH, (i + 1) * CASES_EACH + 1):
                for status in ("done", "done", "flagged", "done"):  # a double click and a change of mind
                    r = s.put(f"{base}/assignments/{made[uid]}/cases/{case}", json={"status": status})
                    with lock:
                        statuses.append(r.status_code)
            # Nobody else's assignment is theirs to touch.
            other = made[ids[(i + 1) % PEOPLE]]
            r = s.put(f"{base}/assignments/{other}/cases/{1 + ((i + 1) % PEOPLE) * CASES_EACH}", json={"status": "done"})
            with lock:
                statuses.append(("foreign", r.status_code))
        except Exception as e:  # noqa: BLE001
            with lock:
                errors.append(repr(e))

    def manager_watching():
        try:
            for _ in range(25):
                r = mgr.get(f"{base}/assignments")
                assert r.status_code == 200
                for a in r.json()["assignments"]:
                    assert a["done"] + a["flagged"] + a["todo"] == a["total"] == CASES_EACH
        except Exception as e:  # noqa: BLE001
            with lock:
                errors.append("manager: " + repr(e))

    threads = [threading.Thread(target=radiologist, args=(i,)) for i in range(PEOPLE)] + [threading.Thread(target=manager_watching)]
    [t.start() for t in threads]
    [t.join(timeout=120) for t in threads]
    assert not any(t.is_alive() for t in threads), "a request hung"
    assert errors == []
    plain = [s for s in statuses if not isinstance(s, tuple)]
    assert set(plain) == {200}, {c: plain.count(c) for c in set(plain)}
    assert {s[1] for s in statuses if isinstance(s, tuple)} == {404}

    final = mgr.get(f"{base}/assignments").json()["assignments"]
    assert len(final) == PEOPLE
    assert all(a["done"] == CASES_EACH and a["flagged"] == 0 and a["todo"] == 0 for a in final)
    # Each radiologist reads back exactly their own twenty marks.
    for i in (0, 17, 49):
        mine = sessions[i].get(f"{base}/assignments/mine").json()["assignments"][0]
        assert len(mine["marks"]) == CASES_EACH and set(mine["marks"].values()) == {"done"}
