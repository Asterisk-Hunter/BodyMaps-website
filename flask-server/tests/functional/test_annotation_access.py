"""Exercise annotation access through real session cookies and the API policy."""
import uuid

import pytest
from flask import Flask

from api.access_policy import install_access_policy
from api.assignment_blueprint import assignment_blueprint
from constants import Constants
from models import engine
from models.user import User
from models.user_role import UserRole
from services import auth_store


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(Constants, "DATABASE_URL", f"sqlite:///{tmp_path / 'annotation-auth.db'}")
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "1")
    monkeypatch.setenv("BODYMAPS_LOCAL_AUTO_SIGNIN", "false")
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-cache"))
    engine.reset_engine_for_tests()
    engine.create_all()
    manager, reader = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add_all([User(id=manager, email="manager@example.org", is_system=False),
                         User(id=reader, email="reader@example.org", is_system=False)])
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=manager, role="annotation_manager"))
    app = Flask(__name__)
    app.register_blueprint(assignment_blueprint, url_prefix="/api")
    install_access_policy(app)
    app.config["TESTING"] = True
    manager_client, reader_client, guest = app.test_client(), app.test_client(), app.test_client()
    manager_client.set_cookie("bm_session", auth_store.create_session(manager))
    reader_client.set_cookie("bm_session", auth_store.create_session(reader))
    yield manager_client, reader_client, guest
    engine.reset_engine_for_tests()


def test_project_create_requires_a_manager_session(clients):
    manager, reader, guest = clients
    body = {"name": "Ducts", "scan_source": "pants", "target_labels": [7],
            "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}
    assert guest.post("/api/projects", json=body).status_code == 401
    assert reader.post("/api/projects", json=body).status_code == 403
    created = manager.post("/api/projects", json=body)
    assert created.status_code == 201
    assert reader.get(f"/api/projects/{created.json['id']}").status_code == 404
    assert "no-store" in created.headers["Cache-Control"]


def test_disabling_feature_still_protects_existing_assignments(clients, monkeypatch):
    from api.assignment_blueprint import active_assignment_exists
    from models.annotation_project import AnnotationAssignment, AnnotationCase, AnnotationProject

    project_id, assignment_id = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(AnnotationProject(id=project_id, name="Test", scan_source="pants", target_labels=[7],
                                      target_names={"7": "Duct"}, baseline_mode="canonical", status="open"))
        session.flush()
        session.add(AnnotationAssignment(id=assignment_id, project_id=project_id, case_selector={}, status="open"))
        session.flush()
        session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=assignment_id,
                                   case_key="PanTS_00000055", status="in_progress"))
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    assert active_assignment_exists("PanTS_00000055")
    assert not active_assignment_exists("PanTS_00000056")


def test_revoked_reviewer_cannot_access_project_or_queue(clients):
    from sqlalchemy import delete

    manager, reviewer, _ = clients
    reviewer_id = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(User(id=reviewer_id, email="reviewer@example.org", is_system=False))
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=reviewer_id, role="annotator"))
    reviewer.set_cookie("bm_session", auth_store.create_session(reviewer_id))
    body = {"name": "Ducts", "scan_source": "pants", "target_labels": [7],
            "target_names": {"7": "Duct"}, "baseline_mode": "canonical", "reviewer_id": reviewer_id}
    project = manager.post("/api/projects", json=body).json["id"]
    assert reviewer.get(f"/api/projects/{project}").status_code == 200
    assert reviewer.get(f"/api/reviews?project={project}").status_code == 200
    with engine.session_scope() as session:
        session.execute(delete(UserRole).where(UserRole.user_id == reviewer_id, UserRole.role == "annotator"))
    assert reviewer.get(f"/api/projects/{project}").status_code == 404
    assert reviewer.get(f"/api/reviews?project={project}").status_code == 404
    assert reviewer.get("/api/annotation-projects/capabilities").json["can_review"] is False


def test_separate_accounts_submit_and_review_without_cross_access(clients, monkeypatch, tmp_path):
    import gzip
    import json
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer

    manager, reader, outsider = clients
    reviewer_id, reader_id, outsider_id = (str(uuid.uuid4()) for _ in range(3))
    with engine.session_scope() as session:
        for user_id in (reviewer_id, reader_id, outsider_id):
            session.add(User(id=user_id, email=f"{user_id}@example.org", is_system=False))
            session.flush()
            session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role="annotator"))
    reviewer = manager.application.test_client()
    reviewer.set_cookie("bm_session", auth_store.create_session(reviewer_id))
    reader.set_cookie("bm_session", auth_store.create_session(reader_id))
    outsider.set_cookie("bm_session", auth_store.create_session(outsider_id))
    monkeypatch.setattr(module, "_case_available", lambda *_args: (True, None))
    reference = tmp_path / "reference.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4)), reference)
    monkeypatch.setattr(viewer, "_save_reference_path", lambda *_args, **_kwargs: str(reference))
    project = manager.post("/api/projects", json={"name": "Ducts", "scan_source": "pants", "target_labels": [7],
        "target_names": {"7": "Duct"}, "baseline_mode": "canonical", "reviewer_id": reviewer_id}).json["id"]
    assignment = manager.post(f"/api/projects/{project}/assignments", json={"assignee_id": reader_id,
        "case_selector": {"ids": [55]}}).json["id"]
    case_url = f"/api/assignments/{assignment}/cases/PanTS_00000055"
    assert outsider.get(case_url).status_code == 404
    geometry = json.dumps({"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]})
    mask = np.zeros((2, 2, 2), dtype=np.uint8); mask[1, 1, 1] = 7
    headers = {"If-Match": "none", "X-Labelmap-Geometry": geometry}
    draft = reader.post(case_url + "/draft", data=gzip.compress(mask.tobytes(order="F")), headers=headers)
    assert draft.status_code == 200
    assert outsider.post(case_url + "/draft", data=b"", headers=headers).status_code == 404
    submitted = reader.post(case_url + "/submit", json={}, headers={"If-Match": draft.json["revision"]})
    assert submitted.status_code == 201
    submission_id = submitted.json["submission_id"]
    assert outsider.get(f"/api/submissions/{submission_id}").status_code == 404
    assert reader.post(f"/api/submissions/{submission_id}/approve", json={}).status_code == 404
    assert reviewer.get(f"/api/reviews?project={project}").json["submissions"][0]["id"] == submission_id
    assert reviewer.post(f"/api/submissions/{submission_id}/approve", json={}).status_code == 200
    assert outsider.post(f"/api/submissions/{submission_id}/publish", json={}).status_code == 404
    assert reviewer.post(f"/api/submissions/{submission_id}/publish", json={}).status_code == 200


def test_concurrent_publications_preserve_disjoint_structures(clients, monkeypatch, tmp_path):
    import gzip
    import json
    import threading
    from concurrent.futures import ThreadPoolExecutor
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer

    manager, _, _ = clients
    users = [str(uuid.uuid4()), str(uuid.uuid4())]
    with engine.session_scope() as session:
        for user_id in users:
            session.add(User(id=user_id, email=f"{user_id}@example.org", is_system=False))
            session.flush()
            session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda *_args: (True, None))
    base = np.zeros((2, 2, 2), dtype=np.uint8); base[0, 0, 0] = 2
    source = tmp_path / "reference.nii.gz"
    nib.save(nib.Nifti1Image(base, np.eye(4)), source)
    def current_mask(key, low=False):
        shared = viewer._pants_shared_edit_path(key)
        return shared if __import__("os").path.isfile(shared) else str(source)
    monkeypatch.setattr(viewer, "_save_reference_path", current_mask)
    geometry = json.dumps({"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]})
    submissions = []
    for user_id, label, point in zip(users, (7, 1), ((1, 1, 1), (1, 0, 1))):
        reader = manager.application.test_client()
        reader.set_cookie("bm_session", auth_store.create_session(user_id))
        project = manager.post("/api/projects", json={"name": f"Target {label}", "scan_source": "pants", "target_labels": [label], "target_names": {str(label): f"Target {label}"}, "baseline_mode": "canonical"}).json["id"]
        assignment_response = manager.post(f"/api/projects/{project}/assignments", json={"assignee_id": user_id, "case_selector": {"ids": [55]}})
        assert assignment_response.status_code == 201
        case_url = f"/api/assignments/{assignment_response.json['id']}/cases/PanTS_00000055"
        edited = base.copy(); edited[point] = label
        saved = reader.post(case_url + "/draft", data=gzip.compress(edited.tobytes(order="F")), headers={"If-Match": "none", "X-Labelmap-Geometry": geometry})
        assert saved.status_code == 200
        submitted = reader.post(case_url + "/submit", json={}, headers={"If-Match": saved.json["revision"]})
        assert submitted.status_code == 201
        submission = submitted.json["submission_id"]
        assert manager.post(f"/api/submissions/{submission}/approve", json={}).status_code == 200
        submissions.append(submission)
    from sqlalchemy import select
    with engine.session_scope() as session:
        manager_id = session.execute(select(User.id).join(UserRole, UserRole.user_id == User.id).where(UserRole.role == "annotation_manager")).scalar_one()
    manager_cookie = auth_store.create_session(manager_id)
    barrier = threading.Barrier(2)
    def publish(submission):
        local = manager.application.test_client()
        local.set_cookie("bm_session", manager_cookie)
        barrier.wait(timeout=10)
        return local.post(f"/api/submissions/{submission}/publish", json={}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(publish, submissions)) == [200, 200]
    result = np.asarray(nib.load(viewer._pants_shared_edit_path("PanTS_00000055")).dataobj)
    assert result[0, 0, 0] == 2 and result[1, 1, 1] == 7 and result[1, 0, 1] == 1
