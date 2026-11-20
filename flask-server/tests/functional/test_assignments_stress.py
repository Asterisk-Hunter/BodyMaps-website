"""Stress tests for annotation assignments: concurrent clicks, a randomized run checked against a plain model,
and hostile input. Nothing here may ever produce a 5xx, lose a mark, or let a count drift from the truth."""

import importlib
import random
import threading
import time

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'stress.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)

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
    yield app, role_store, assignment_store
    engine.reset_engine_for_tests()


def _account(app, role_store, email, role=None):
    with app.test_client() as c:
        uid = c.post("/api/auth/register", json={"email": email, "password": "password1"}).get_json()["user"]["id"]
    if role:
        role_store.grant(uid, role)
    return uid


def _client_as(app, email):
    c = app.test_client()
    assert c.post("/api/auth/login", json={"email": email, "password": "password1"}).status_code == 200
    return c


def test_many_people_clicking_the_same_case_at_once(env):
    """Two tabs, a double click, a manager marking at the same moment: one row, no error, no lost count."""
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    ann = _account(app, roles, "a@b.com", roles.ROLE_ANNOTATOR)
    a = store.create(assignee_id=ann, start=1, end=40, task="Veins", created_by=mgr)

    statuses, errors = [], []

    def worker(i):
        try:
            for case in range(1, 41):
                store.set_case_status(a["id"], case, "done" if (i + case) % 3 else "flagged",
                                      acting_user_id=ann, is_manager=False)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    mine = store.list_for(ann)[0]
    assert len(mine["marks"]) == 40
    assert mine["done"] + mine["flagged"] == 40 and mine["todo"] == 0


def test_concurrent_http_marks_never_error(env):
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    ann = _account(app, roles, "a@b.com", roles.ROLE_ANNOTATOR)
    a = store.create(assignee_id=ann, start=100, end=159, task="Ducts", created_by=mgr)
    codes, lock = [], threading.Lock()

    def worker():
        c = _client_as(app, "a@b.com")
        for case in range(100, 160):
            for status in ("done", "done", "flagged", "todo", "done"):
                r = c.put(f"/api/assignments/{a['id']}/cases/{case}", json={"status": status})
                with lock:
                    codes.append(r.status_code)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert set(codes) == {200}, {c: codes.count(c) for c in set(codes)}
    final = store.list_for(ann)[0]
    assert final["done"] == 60 and final["todo"] == 0  # every worker ends each case on "done"


def test_a_big_team_stays_correct_and_fast(env):
    """50 radiologists, several assignments each, thousands of marks: the manager's table must add up."""
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    people = [_account(app, roles, f"r{i}@b.com", roles.ROLE_ANNOTATOR) for i in range(50)]
    expected_done = 0
    for i, p in enumerate(people):
        for j, task in enumerate(("Veins", "Arteries", "Ducts")):
            start = 1 + i * 200 + j * 60
            a = store.create(assignee_id=p, start=start, end=start + 59, task=task, created_by=mgr)
            for case in range(start, start + 59, 2):
                store.set_case_status(a["id"], case, "done", acting_user_id=p, is_manager=False)
                expected_done += 1
    t0 = time.time()
    everything = store.list_all()
    elapsed = time.time() - t0
    assert len(everything) == 150
    assert sum(x["done"] for x in everything) == expected_done
    assert all(x["done"] + x["flagged"] + x["todo"] == x["total"] == 60 for x in everything)
    assert elapsed < 2.0, elapsed
    assert len(store.assignable_people()) == 51


def test_randomized_run_matches_a_plain_model(env):
    """Hundreds of random creates, marks, edits and deletes; after every step the store must agree with a dict."""
    app, roles, store = env
    rng = random.Random(20261114)
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    people = [_account(app, roles, f"r{i}@b.com", roles.ROLE_ANNOTATOR) for i in range(6)]
    model: dict[str, dict] = {}

    def check():
        listed = {x["id"]: x for x in store.list_all()}
        assert set(listed) == set(model)
        for aid, m in model.items():
            x = listed[aid]
            done = sum(1 for v in m["marks"].values() if v == "done")
            flagged = sum(1 for v in m["marks"].values() if v == "flagged")
            assert (x["done"], x["flagged"], x["todo"]) == (done, flagged, m["total"] - done - flagged), (x, m)
            assert x["assignee"]["id"] == m["assignee"]

    for step in range(400):
        op = rng.choice(["create", "create", "mark", "mark", "mark", "mark", "unmark", "reassign", "delete"])
        if op == "create":
            start = rng.randint(1, 500)
            end = start + rng.randint(0, 30)
            who = rng.choice(people)
            try:
                a = store.create(assignee_id=who, start=start, end=end, task=rng.choice(["V", "A", "D"]),
                                 created_by=mgr, force=True)
            except store.AssignmentError:
                continue
            model[a["id"]] = {"assignee": who, "start": start, "end": end, "total": end - start + 1, "marks": {}}
        elif model:
            aid = rng.choice(list(model))
            m = model[aid]
            if op in ("mark", "unmark"):
                case = rng.randint(m["start"] - 2, m["end"] + 2)
                status = rng.choice(["done", "flagged"]) if op == "mark" else "todo"
                if m["start"] <= case <= m["end"]:
                    store.set_case_status(aid, case, status, acting_user_id=m["assignee"], is_manager=False)
                    if status == "todo":
                        m["marks"].pop(case, None)
                    else:
                        m["marks"][case] = status
                else:
                    with pytest.raises(store.AssignmentError):
                        store.set_case_status(aid, case, status, acting_user_id=m["assignee"], is_manager=False)
            elif op == "reassign":
                who = rng.choice(people)
                store.update(aid, {"assignee_id": who})
                m["assignee"] = who
            elif op == "delete":
                assert store.delete_assignment(aid) is True
                del model[aid]
        if step % 20 == 0:
            check()
    check()


HOSTILE = [None, "", " ", "x" * 5000, 0, -1, 1.5, 10 ** 30, True, False, [], {}, [1], {"a": 1},
           "<script>alert(1)</script>", "'; DROP TABLE annotation_assignment; --", "\u0000", "😀", "9" * 400]


def test_hostile_input_never_causes_a_server_error(env):
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    ann = _account(app, roles, "a@b.com", roles.ROLE_ANNOTATOR)
    c = _client_as(app, "m@b.com")
    good = {"assignee_id": ann, "start": 1, "end": 5, "task": "Veins"}
    made = c.post("/api/assignments", json=good).get_json()
    codes = []
    for field in ("assignee_id", "start", "end", "task", "note", "due", "force"):
        for bad in HOSTILE:
            r = c.post("/api/assignments", json={**good, field: bad, "force": True if field != "force" else bad})
            codes.append(r.status_code)
            assert r.status_code in (201, 400, 409), (field, bad, r.status_code, r.data[:200])
            if field in ("assignee_id", "task", "note", "due"):
                r = c.patch(f"/api/assignments/{made['id']}", json={field: bad})
                assert r.status_code in (200, 400), (field, bad, r.status_code, r.data[:200])
    for bad in HOSTILE:
        r = c.put(f"/api/assignments/{made['id']}/cases/3", json={"status": bad})
        assert r.status_code in (200, 400), (bad, r.status_code)
    for raw in (b"", b"not json", b"[1,2,3]", b"null", b'{"a":'):
        for method in (c.post, c.patch):
            url = "/api/assignments" if method == c.post else f"/api/assignments/{made['id']}"
            r = method(url, data=raw, content_type="application/json")
            assert r.status_code < 500, (raw, r.status_code)
    for path in ("/api/assignments/%00", "/api/assignments/" + "a" * 3000, f"/api/assignments/{made['id']}/cases/" + "9" * 40,
                 f"/api/assignments/{made['id']}/cases/-5", f"/api/assignments/{made['id']}/cases/abc"):
        for method in (c.put, c.patch, c.delete):
            assert method(path, json={"status": "done"}).status_code < 500, (method, path)
    # The hostile writes were all refused or stored as plain text: the table is intact and readable.
    assert c.get("/api/assignments").status_code == 200
    assert any(x["id"] == made["id"] for x in c.get("/api/assignments").get_json()["assignments"])


def test_a_deleted_or_pending_deletion_account_is_never_assignable(env):
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    ann = _account(app, roles, "a@b.com", roles.ROLE_ANNOTATOR)
    from models.engine import session_scope
    from models.job import utcnow
    from models.user import User
    with session_scope() as s:
        s.get(User, ann).deletion_requested_at = utcnow()
    with pytest.raises(store.AssignmentError):
        store.create(assignee_id=ann, start=1, end=2, task="V", created_by=mgr)
    assert ann not in [p["id"] for p in store.assignable_people()]


def test_losing_the_annotator_role_stops_new_work_but_keeps_the_record(env):
    app, roles, store = env
    mgr = _account(app, roles, "m@b.com", roles.ROLE_ANNOTATION_MANAGER)
    ann = _account(app, roles, "a@b.com", roles.ROLE_ANNOTATOR)
    a = store.create(assignee_id=ann, start=1, end=9, task="V", created_by=mgr)
    store.set_case_status(a["id"], 1, "done", acting_user_id=ann, is_manager=False)
    roles.revoke(ann, roles.ROLE_ANNOTATOR, acting_user_id=mgr)
    # Their finished work is still on record and still counts; they can simply not be handed anything new.
    assert [x["done"] for x in store.list_all()] == [1]
    with pytest.raises(store.AssignmentError):
        store.create(assignee_id=ann, start=20, end=30, task="V", created_by=mgr)
