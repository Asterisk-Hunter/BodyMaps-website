"""End-to-end tests for annotation assignments through a Flask test client.

Who may hand out cases (annotation managers only), who may mark a case (its assignee or a manager),
what a range may look like, and what happens when two people are given the same cases for the same task.
"""

import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'assignments.db'}")
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
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def sign_up(client, email):
    r = client.post("/api/auth/register", json={"email": email, "password": "password1"})
    return r.get_json()["user"]["id"]


def sign_in(client, email):
    client.post("/api/auth/login", json={"email": email, "password": "password1"})


def make(client, email, role=None):
    from services import role_store
    uid = sign_up(client, email)
    if role:
        role_store.grant(uid, role)
    return uid


def manager_and_two_annotators(client):
    from services import role_store
    manager = make(client, "manager@b.com", role_store.ROLE_ANNOTATION_MANAGER)
    one = make(client, "one@b.com", role_store.ROLE_ANNOTATOR)
    two = make(client, "two@b.com", role_store.ROLE_ANNOTATOR)
    sign_in(client, "manager@b.com")
    return manager, one, two


def body(assignee, start=55, end=95, task="Veins and arteries", **extra):
    return {"assignee_id": assignee, "start": start, "end": end, "task": task, **extra}


# ---- who gets in ------------------------------------------------------------

def test_signed_out_is_401_everywhere(client):
    assert client.get("/api/assignments").status_code == 401
    assert client.get("/api/assignments/mine").status_code == 401
    assert client.post("/api/assignments", json={}).status_code == 401
    assert client.put("/api/assignments/x/cases/1", json={"status": "done"}).status_code == 401


def test_an_annotator_cannot_manage_assignments(client):
    manager, one, _ = manager_and_two_annotators(client)
    sign_in(client, "one@b.com")
    assert client.get("/api/assignments").status_code == 403
    assert client.get("/api/assignments/people").status_code == 403
    assert client.post("/api/assignments", json=body(one)).status_code == 403


# ---- creating ---------------------------------------------------------------

def test_a_manager_hands_out_a_range(client):
    _, one, _ = manager_and_two_annotators(client)
    r = client.post("/api/assignments", json=body(one, note="Start with the portal phase", due="2026-12-31"))
    assert r.status_code == 201
    a = r.get_json()
    assert (a["start"], a["end"], a["total"], a["todo"], a["done"]) == (55, 95, 41, 41, 0)
    assert a["assignee"]["email"] == "one@b.com"
    assert a["due_at"].startswith("2026-12-31")
    listed = client.get("/api/assignments").get_json()["assignments"]
    assert [x["id"] for x in listed] == [a["id"]]


def test_only_annotators_can_be_given_cases(client):
    manager_and_two_annotators(client)
    from services import role_store  # noqa: F401
    ordinary = sign_up_other = None
    # An account with no annotating role is refused, and the people list does not offer it.
    client.post("/api/auth/logout")
    ordinary = sign_up(client, "plain@b.com")
    sign_in(client, "manager@b.com")
    r = client.post("/api/assignments", json=body(ordinary))
    assert r.status_code == 400 and r.get_json()["reason"] == "not_an_annotator"
    emails = {p["email"] for p in client.get("/api/assignments/people").get_json()["people"]}
    assert emails == {"manager@b.com", "one@b.com", "two@b.com"}
    assert sign_up_other is None


@pytest.mark.parametrize("start,end", [(0, 10), (10, 5), (-3, 4), (1, 999999), ("a", 5), (5.5, 9), (True, 9), (None, 9)])
def test_bad_ranges_are_refused(client, start, end):
    _, one, _ = manager_and_two_annotators(client)
    r = client.post("/api/assignments", json=body(one, start=start, end=end))
    assert r.status_code == 400 and r.get_json()["reason"] == "bad_range"


def test_a_task_is_required(client):
    _, one, _ = manager_and_two_annotators(client)
    r = client.post("/api/assignments", json=body(one, task="   "))
    assert r.status_code == 400 and r.get_json()["reason"] == "bad_task"


def test_a_bad_due_date_is_refused(client):
    _, one, _ = manager_and_two_annotators(client)
    r = client.post("/api/assignments", json=body(one, due="next week"))
    assert r.status_code == 400 and r.get_json()["reason"] == "bad_due"


def test_unknown_assignee_is_refused(client):
    manager_and_two_annotators(client)
    r = client.post("/api/assignments", json=body("no-such-id"))
    assert r.status_code == 400 and r.get_json()["reason"] == "no_such_person"
    r = client.post("/api/assignments", json=body(None))
    assert r.status_code == 400 and r.get_json()["reason"] == "no_such_person"


# ---- overlaps ---------------------------------------------------------------

def test_overlapping_cases_for_the_same_task_need_confirmation(client):
    _, one, two = manager_and_two_annotators(client)
    assert client.post("/api/assignments", json=body(one, 55, 95)).status_code == 201
    r = client.post("/api/assignments", json=body(two, 90, 120, task="veins and arteries"))
    assert r.status_code == 409
    j = r.get_json()
    assert j["reason"] == "overlap"
    assert (j["overlaps"][0]["shared_start"], j["overlaps"][0]["shared_end"]) == (90, 95)
    assert len(client.get("/api/assignments").get_json()["assignments"]) == 1
    confirmed = client.post("/api/assignments", json=body(two, 90, 120, task="veins and arteries", force=True))
    assert confirmed.status_code == 201
    assert len(client.get("/api/assignments").get_json()["assignments"]) == 2


def test_the_same_cases_for_a_different_task_are_not_an_overlap(client):
    _, one, two = manager_and_two_annotators(client)
    assert client.post("/api/assignments", json=body(one, 55, 95, task="Veins")).status_code == 201
    assert client.post("/api/assignments", json=body(two, 55, 95, task="Lesions")).status_code == 201


def test_touching_ranges_do_not_overlap(client):
    _, one, two = manager_and_two_annotators(client)
    assert client.post("/api/assignments", json=body(one, 55, 95)).status_code == 201
    assert client.post("/api/assignments", json=body(two, 96, 144)).status_code == 201
    assert client.post("/api/assignments", json=body(two, 145, 200)).status_code == 201


# ---- working through an assignment --------------------------------------------

def test_an_annotator_sees_only_their_own_and_marks_cases(client):
    _, one, two = manager_and_two_annotators(client)
    mine = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    client.post("/api/assignments", json=body(two, 145, 150))

    sign_in(client, "one@b.com")
    listed = client.get("/api/assignments/mine").get_json()["assignments"]
    assert [a["id"] for a in listed] == [mine["id"]]
    assert listed[0]["marks"] == {}

    url = f"/api/assignments/{mine['id']}/cases"
    assert client.put(f"{url}/55", json={"status": "done"}).status_code == 200
    assert client.put(f"{url}/56", json={"status": "flagged"}).status_code == 200
    r = client.put(f"{url}/57", json={"status": "done"}).get_json()
    assert (r["done"], r["flagged"], r["todo"]) == (2, 1, 3)
    listed = client.get("/api/assignments/mine").get_json()["assignments"]
    assert listed[0]["marks"] == {"55": "done", "56": "flagged", "57": "done"}

    # Marking again changes the mark; "todo" clears it.
    assert client.put(f"{url}/56", json={"status": "done"}).get_json()["flagged"] == 0
    r = client.put(f"{url}/55", json={"status": "todo"}).get_json()
    assert (r["done"], r["flagged"], r["todo"]) == (2, 0, 4)


def test_marks_outside_the_range_or_with_a_bad_status_are_refused(client):
    _, one, _ = manager_and_two_annotators(client)
    a = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    sign_in(client, "one@b.com")
    url = f"/api/assignments/{a['id']}/cases"
    r = client.put(f"{url}/61", json={"status": "done"})
    assert r.status_code == 400 and r.get_json()["reason"] == "outside_range"
    r = client.put(f"{url}/55", json={"status": "finished"})
    assert r.status_code == 400 and r.get_json()["reason"] == "bad_status"
    r = client.put(f"{url}/55", json={})
    assert r.status_code == 400


def test_nobody_marks_someone_elses_assignment(client):
    _, one, two = manager_and_two_annotators(client)
    a = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    sign_in(client, "two@b.com")
    r = client.put(f"/api/assignments/{a['id']}/cases/55", json={"status": "done"})
    assert r.status_code == 404  # the same answer as for an id that does not exist
    assert client.put("/api/assignments/nope/cases/55", json={"status": "done"}).status_code == 404


def test_a_manager_can_mark_on_someones_behalf(client):
    _, one, _ = manager_and_two_annotators(client)
    a = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    r = client.put(f"/api/assignments/{a['id']}/cases/55", json={"status": "done"})
    assert r.status_code == 200 and r.get_json()["done"] == 1


# ---- changing and removing ----------------------------------------------------

def test_reassigning_keeps_progress_and_validates_the_new_person(client):
    _, one, two = manager_and_two_annotators(client)
    a = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    client.put(f"/api/assignments/{a['id']}/cases/55", json={"status": "done"})
    r = client.patch(f"/api/assignments/{a['id']}", json={"assignee_id": two, "due": "2027-01-15", "note": ""})
    assert r.status_code == 200
    j = r.get_json()
    assert j["assignee"]["email"] == "two@b.com" and j["done"] == 1 and j["due_at"].startswith("2027-01-15")
    plain = None
    client.post("/api/auth/logout")
    plain = sign_up(client, "plain@b.com")
    sign_in(client, "manager@b.com")
    r = client.patch(f"/api/assignments/{a['id']}", json={"assignee_id": plain})
    assert r.status_code == 400 and r.get_json()["reason"] == "not_an_annotator"
    assert client.patch("/api/assignments/nope", json={"task": "x"}).status_code == 404


def test_deleting_removes_the_assignment_and_its_marks(client):
    _, one, _ = manager_and_two_annotators(client)
    a = client.post("/api/assignments", json=body(one, 55, 60)).get_json()
    client.put(f"/api/assignments/{a['id']}/cases/55", json={"status": "done"})
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 200
    assert client.get("/api/assignments").get_json()["assignments"] == []
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 404
    from models.annotation_assignment import AnnotationAssignmentCase
    from models.engine import session_scope
    with session_scope() as s:
        assert s.query(AnnotationAssignmentCase).count() == 0


# ---- what an error response may say ------------------------------------------

def test_refusals_use_fixed_messages_and_echo_nothing_from_the_request(client):
    """The text a caller sees depends only on the reason, never on what they sent or on an exception."""
    from api.assignments_blueprint import _REFUSAL_MESSAGES
    _, one, two = manager_and_two_annotators(client)
    marker = "ZZ-secret-marker-ZZ"
    seen = {}
    r = client.post("/api/assignments", json=body(one, start=10, end=5, task=marker))
    seen[r.get_json()["reason"]] = r.get_json()["error"]
    r = client.post("/api/assignments", json=body(one, task=["x"]))
    seen[r.get_json()["reason"]] = r.get_json()["error"]
    r = client.post("/api/assignments", json=body(one, due=marker))
    seen[r.get_json()["reason"]] = r.get_json()["error"]
    r = client.post("/api/assignments", json=body(marker))
    seen[r.get_json()["reason"]] = r.get_json()["error"]
    assert client.post("/api/assignments", json=body(one, 55, 95)).status_code == 201
    r = client.post("/api/assignments", json=body(two, 90, 120))
    j = r.get_json()
    seen[j["reason"]] = j["error"]
    assert set(j["overlaps"][0]) == {"id", "assignee", "start", "end", "shared_start", "shared_end"}
    assert {"bad_range", "bad_task", "bad_due", "no_such_person", "overlap"} <= set(seen)
    for reason, message in seen.items():
        assert message == _REFUSAL_MESSAGES[reason]
        assert marker not in message
