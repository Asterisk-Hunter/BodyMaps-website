import os
import uuid

import pytest
from flask import Flask, g

from api.assignment_blueprint import assignment_blueprint
from models import engine
from models.user import User
from constants import Constants


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(Constants, "DATABASE_URL", f"sqlite:///{tmp_path / 'projects.db'}")
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "1")
    # Test submissions and drafts must never use the developer's real viewer cache.
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-cache"))
    engine.reset_engine_for_tests()
    engine.create_all()
    user_id = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(User(id=user_id, email="manager@example.org", is_system=False))
    app = Flask(__name__)
    app.register_blueprint(assignment_blueprint, url_prefix="/api")
    app.config["TESTING"] = True

    @app.get("/test-mask/<case_key>")
    def mask(case_key):
        from flask import request
        from api.assignment_blueprint import assignment_mask_response
        return assignment_mask_response(case_key, request.args.get("assignment"), request.args.get("submission"))

    @app.post("/test-mask-data")
    def mask_data():
        from api.api_blueprint import get_mask_data
        return get_mask_data()

    @app.before_request
    def login():
        from flask import request
        g.current_user = {"id": request.headers.get("X-Test-User", user_id), "name": "User"}
        g.current_roles = [] if request.headers.get("X-Test-User") else ["annotation_manager"]

    yield app.test_client()
    engine.reset_engine_for_tests()


def test_manager_creates_and_lists_project(client, monkeypatch, tmp_path):
    body = {"name": "Ducts", "scan_source": "pants", "target_labels": [7],
            "target_names": {"7": "Common bile duct"}, "baseline_mode": "canonical"}
    result = client.post("/api/projects", json=body)
    assert result.status_code == 201
    assert client.get("/api/projects").json["projects"][0]["id"] == result.json["id"]
    project_url = f"/api/projects/{result.json['id']}"
    assert client.patch(project_url, json={"due_at": "2026-12-01T12:00:00Z", "name": "Renamed"}).status_code == 200
    assert client.get(project_url).json["name"] == "Renamed"
    assert client.patch(project_url, json={"due_at": "2026-12-01T12:00:00"}).status_code == 400
    assert client.get(project_url, headers={"X-Test-User": str(uuid.uuid4())}).status_code == 404
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path))
    empty_storage = client.get(project_url + "/storage")
    assert empty_storage.status_code == 200 and empty_storage.json["bytes"] == 0 and empty_storage.json["files"] == 0
    from models.annotation_project import AnnotationProject
    with engine.session_scope() as session:
        session.get(AnnotationProject, result.json["id"]).seed_dir = "expected-seed"
    assert client.get(project_url + "/storage").status_code == 503
    with engine.session_scope() as session:
        session.get(AnnotationProject, result.json["id"]).seed_dir = None
    project_dir = tmp_path / "edits" / "assignments" / result.json["id"]
    project_dir.mkdir(parents=True)
    (project_dir / "sample").write_bytes(b"12345")
    storage = client.get(project_url + "/storage")
    assert storage.status_code == 200 and storage.json["bytes"] == 5 and storage.json["files"] == 1
    from models.annotation_project import AnnotationAssignment, AnnotationCase
    from services.annotation_storage import draft_path
    assignment_id, case_id, revision = str(uuid.uuid4()), str(uuid.uuid4()), "a" * 64
    with engine.session_scope() as session:
        session.add(AnnotationAssignment(id=assignment_id, project_id=result.json["id"], case_selector={}))
        session.flush()
        session.add(AnnotationCase(id=case_id, assignment_id=assignment_id, case_key="PanTS_00000001", draft_revision=revision))
    assert client.get(project_url + "/storage").status_code == 503
    expected = draft_path(result.json["id"], assignment_id, case_id, revision)
    os.makedirs(os.path.dirname(expected), exist_ok=True)
    with open(expected, "wb") as handle:
        handle.write(b"draft")
    assert client.get(project_url + "/storage").json["bytes"] == 10
    old = os.path.join(os.path.dirname(expected), "c" * 64 + ".nii.gz")
    with open(old, "wb") as handle:
        handle.write(b"old")
    storage = client.get(project_url + "/storage").json
    assert storage["noncurrent_drafts"] == {"files": 1, "bytes": 3}
    assert storage["unreferenced_submissions"] == {"files": 0, "bytes": 0}
    real_islink = os.path.islink
    monkeypatch.setattr(os.path, "islink", lambda path: str(path) == expected or real_islink(path))
    assert client.get(project_url + "/storage").status_code == 503
    assert client.get(project_url + "/storage", headers={"X-Test-User": str(uuid.uuid4())}).status_code == 404


def test_reviewer_edit_permissions_and_preserves_original(client, monkeypatch, tmp_path):
    import gzip
    import json
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer
    from models.annotation_project import AnnotationSubmission
    from models.user_role import UserRole

    assignee, other = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add_all([User(id=assignee, email="reader@example.org", is_system=False), User(id=other, email="other@example.org", is_system=False)])
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=assignee, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    reference = np.zeros((2, 2, 2), dtype=np.uint8)
    reference[0, 0, 0] = 2
    path = tmp_path / "reference.nii.gz"
    nib.save(nib.Nifti1Image(reference, np.eye(4)), path)
    monkeypatch.setattr(viewer, "_save_reference_path", lambda key, low=False: str(path))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants", "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": assignee, "case_selector": {"ids": [55]}}).json["id"]
    url = f"/api/assignments/{assignment}/cases/PanTS_00000055"
    geometry = json.dumps({"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]})
    first = reference.copy(); first[1, 1, 1] = 7
    saved = client.post(url + "/draft", data=gzip.compress(first.tobytes(order="F")), headers={"X-Test-User": assignee, "If-Match": "none", "X-Labelmap-Geometry": geometry})
    original = client.post(url + "/submit", json={}, headers={"X-Test-User": assignee, "If-Match": saved.json["revision"]}).json["submission_id"]
    edit_url = f"/api/submissions/{original}/edit"
    revised = first.copy(); revised[1, 0, 1] = 7
    payload = gzip.compress(revised.tobytes(order="F"))
    headers = {"If-Match": saved.json["revision"], "X-Labelmap-Geometry": geometry}
    assert client.post(edit_url, data=payload, headers={**headers, "X-Test-User": assignee}).status_code == 404
    assert client.post(edit_url, data=payload, headers={**headers, "X-Test-User": other}).status_code == 404
    forbidden = revised.copy(); forbidden[0, 0, 0] = 0
    assert client.post(edit_url, data=gzip.compress(forbidden.tobytes(order="F")), headers=headers).status_code == 409
    result = client.post(edit_url, data=payload, headers=headers)
    assert result.status_code == 201 and result.json["version"] == 2
    assert client.post(edit_url, data=payload, headers=headers).status_code == 409
    queue_item = client.get(f"/api/reviews?project={project['id']}&status=in_review").json["submissions"][0]
    assert queue_item["assignee_id"] == assignee
    assert queue_item["submitted_by"] != assignee
    with engine.session_scope() as session:
        assert np.array_equal(np.asarray(nib.load(session.get(AnnotationSubmission, original).mask_full_path).dataobj), first)
        updated = session.get(AnnotationSubmission, result.json["submission_id"])
        assert np.array_equal(np.asarray(nib.load(updated.mask_full_path).dataobj), revised)
        assert updated.submitted_by != assignee


def test_invalid_label_and_disabled_flag_are_rejected(client, monkeypatch):
    body = {"name": "Bad", "scan_source": "pants", "target_labels": [True],
            "target_names": {"1": "Invalid"}, "baseline_mode": "canonical"}
    assert client.post("/api/projects", json=body).status_code == 400
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    assert client.post("/api/projects", json=body).status_code == 404
    assert client.get("/api/annotation-projects/capabilities").json["enabled"] is False


def test_transfer_unfinished_preserves_draft_and_finished_cases(client, monkeypatch, tmp_path):
    import api.assignment_blueprint as module
    from models.annotation_project import AnnotationCase
    from models.user_role import UserRole
    from services.annotation_storage import draft_path

    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        for user_id in (first, second):
            session.add(User(id=user_id, email=f"{user_id}@example.org", is_system=False))
            session.flush()
            session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role="annotator"))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants", "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": first, "case_selector": {"ids": [1, 2]}}).json["id"]
    with engine.session_scope() as session:
        rows = session.query(AnnotationCase).filter_by(assignment_id=assignment).order_by(AnnotationCase.case_key).all()
        rows[0].status, rows[0].draft_revision = "in_progress", "b" * 64
        rows[1].status = "published"
        row_id = rows[0].id
    path = draft_path(project["id"], assignment, row_id, "b" * 64)
    failed = client.post(f"/api/assignments/{assignment}/transfer-unfinished", json={"assignee_id": second})
    assert failed.status_code == 409
    assert len(client.get(f"/api/assignments/{assignment}/cases", headers={"X-Test-User": first}).json["cases"]) == 2
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"draft")
    response = client.post(f"/api/assignments/{assignment}/transfer-unfinished", json={"assignee_id": second})
    assert response.status_code == 201 and response.json["transferred_cases"] == 1
    new_id = response.json["id"]
    assert open(draft_path(project["id"], new_id, row_id, "b" * 64), "rb").read() == b"draft"
    assert client.get(f"/api/assignments/{new_id}/cases", headers={"X-Test-User": first}).status_code == 404
    assert client.get(f"/api/assignments/{new_id}/cases", headers={"X-Test-User": second}).json["cases"][0]["status"] == "in_progress"
    assert client.get("/api/me/assignments", headers={"X-Test-User": second}).json["assignments"][0]["next_case"] == "PanTS_00000001"
    assert client.get(f"/api/assignments/{assignment}/cases", headers={"X-Test-User": first}).json["cases"][0]["status"] == "published"


def test_manager_can_release_unfinished_case_without_deleting_draft(client, monkeypatch):
    import api.assignment_blueprint as module
    from models.annotation_project import AnnotationCase
    from models.user_role import UserRole
    from services.annotation_storage import draft_path

    reader = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(User(id=reader, email="reader@example.org", is_system=False))
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=reader, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda *_args: (True, None))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants", "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": reader, "case_selector": {"ids": [55]}}).json["id"]
    with engine.session_scope() as session:
        row = session.query(AnnotationCase).filter_by(assignment_id=assignment).one()
        row.status, row.draft_revision = "in_progress", "a" * 64
        row_id = row.id
    path = draft_path(project["id"], assignment, row_id, "a" * 64)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"private draft")
    release_url = f"/api/assignments/{assignment}/cases/PanTS_00000055/release"
    assert module.active_assignment_exists("PanTS_00000055")
    assert client.post(release_url, headers={"X-Test-User": reader}).status_code == 403
    assert client.post(f"/api/projects/{project['id']}/close").status_code == 200
    assert client.post(release_url).status_code == 200
    assert not module.active_assignment_exists("PanTS_00000055")
    assert open(path, "rb").read() == b"private draft"
    assert client.post(release_url).status_code == 409
    assert client.get(f"/api/assignments/{assignment}/cases/PanTS_00000055", headers={"X-Test-User": reader}).json["can_edit"] is False
    assert client.post(f"/api/projects/{project['id']}/reopen").status_code == 200
    replacement = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": reader, "case_selector": {"ids": [55]}})
    assert replacement.status_code == 201
    assert module.active_assignment_exists("PanTS_00000055")


def test_transfer_rework_preserves_feedback_and_allows_resubmission(client, monkeypatch, tmp_path):
    import gzip
    import json
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer
    from models.user_role import UserRole

    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    reference = tmp_path / "reference.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4)), reference)
    monkeypatch.setattr(viewer, "_save_reference_path", lambda key, low=False: str(reference))
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        for user_id in (first, second):
            session.add(User(id=user_id, email=f"{user_id}@example.org", is_system=False))
            session.flush()
            session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role="annotator"))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants", "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    old = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": first, "case_selector": {"ids": [55]}}).json["id"]
    old_url = f"/api/assignments/{old}/cases/PanTS_00000055"
    geometry = json.dumps({"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]})
    mask = np.zeros((2, 2, 2), dtype=np.uint8); mask[1, 1, 1] = 7
    payload = gzip.compress(mask.tobytes(order="F"))
    headers = {"X-Test-User": first, "If-Match": "none", "X-Labelmap-Geometry": geometry}
    saved = client.post(old_url + "/draft", data=payload, headers=headers)
    assert saved.status_code == 200
    headers["If-Match"] = saved.json["revision"]
    submitted = client.post(old_url + "/submit", json={}, headers=headers)
    assert submitted.status_code == 201
    from services import mailer
    sent = []
    monkeypatch.setattr(mailer, "is_configured", lambda: True)
    monkeypatch.setattr(mailer, "send", lambda *args: sent.append(args) or True)
    review = client.post(f"/api/submissions/{submitted.json['submission_id']}/rework", json={"comment": "Adjust the edge", "notify": True})
    assert review.status_code == 200 and review.json["notification"] == "accepted"
    assert len(sent) == 1 and "PanTS" not in sent[0][2] and "Adjust the edge" not in sent[0][2]
    moved = client.post(f"/api/assignments/{old}/transfer-unfinished", json={"assignee_id": second})
    assert moved.status_code == 201
    new = moved.json["id"]
    history = client.get("/api/cases/PanTS_00000055/annotation-history").json["events"]
    original_event = next(event for event in history if event["action"] == "submit")
    assert original_event["assignment_id"] == old and original_event["submission_assignment_id"] == new
    assert client.get(f"/api/submissions/{submitted.json['submission_id']}").json["assignment_id"] == new
    new_url = f"/api/assignments/{new}/cases/PanTS_00000055"
    headers["X-Test-User"] = second
    context = client.get(new_url, headers=headers)
    assert context.json["review_note"] == "Adjust the edge" and context.json["can_edit"]
    assert client.get(f"/test-mask/PanTS_00000055?assignment={new}", headers={"X-Test-User": second}).status_code == 200
    assert client.get(new_url, headers={"X-Test-User": first}).status_code == 404
    assert client.post(new_url + "/draft", data=payload, headers=headers).status_code == 200
    resubmitted = client.post(new_url + "/submit", json={}, headers=headers)
    assert resubmitted.status_code == 201 and resubmitted.json["version"] == 2


@pytest.mark.parametrize("source,case_key,catalog_name,resolver_name", [
    ("cancerverse", "CV_00000055", "cv_catalog", "_cancerverse_mask"),
    ("abdomenatlas", "BDMAP_00000055", "at_catalog", "_abdomenatlas_mask"),
])
def test_other_dataset_publish_preserves_non_target_and_viewer_loads_shared(client, monkeypatch, tmp_path, source, case_key, catalog_name, resolver_name):
    import gzip
    import json
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer
    from models.user_role import UserRole

    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    baseline = np.zeros((2, 2, 2), dtype=np.uint8)
    baseline[0, 0, 0] = 2
    original = tmp_path / "original.nii.gz"
    nib.save(nib.Nifti1Image(baseline, np.eye(4)), original)
    monkeypatch.setattr(getattr(viewer, catalog_name), "resolve_mask_path", lambda *_args: str(original))
    user_id = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(User(id=user_id, email="reader@example.org", is_system=False))
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role="annotator"))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": source,
        "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": user_id,
        "case_selector": {"ids": [55]}}).json["id"]
    url = f"/api/assignments/{assignment}/cases/{case_key}"
    geometry = json.dumps({"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]})
    changed = baseline.copy(); changed[1, 1, 1] = 7
    headers = {"X-Test-User": user_id, "If-Match": "none", "X-Labelmap-Geometry": geometry}
    saved = client.post(url + "/draft", data=gzip.compress(changed.tobytes(order="F")), headers=headers)
    assert saved.status_code == 200
    headers["If-Match"] = saved.json["revision"]
    submitted = client.post(url + "/submit", json={}, headers=headers)
    assert submitted.status_code == 201
    submission = submitted.json["submission_id"]
    assert client.post(f"/api/submissions/{submission}/approve", json={}).status_code == 200
    assert client.post(f"/api/submissions/{submission}/publish", json={}).status_code == 200
    _, resolved = getattr(viewer, resolver_name)(case_key)
    assert resolved == viewer._pants_shared_edit_path(case_key)
    np.testing.assert_array_equal(np.asarray(nib.load(resolved).dataobj), changed)


def test_assignment_dry_run_and_overlapping_target_conflict(client, monkeypatch):
    import api.assignment_blueprint as module
    from models.user_role import UserRole

    assignee = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(User(id=assignee, email="reader@example.org", is_system=False))
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=assignee, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (key.endswith("55"), "CT unavailable"))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants",
        "target_labels": [7], "target_names": {"7": "Common bile duct"}, "baseline_mode": "canonical"}).json
    body = {"assignee_id": assignee, "case_selector": {"ids": [55, 56]}, "dry_run": True}
    result = client.post(f"/api/projects/{project['id']}/assignments", json=body)
    assert result.json["matched"] == ["PanTS_00000055"]
    assert result.json["missing"][0]["case_key"] == "PanTS_00000056"
    body["dry_run"] = False
    created = client.post(f"/api/projects/{project['id']}/assignments", json=body)
    assert created.status_code == 201
    assert module.active_assignment_exists("PanTS_00000055")
    assert not module.active_assignment_exists("PanTS_00000057")
    cases = client.get(f"/api/assignments/{created.json['id']}/cases")
    assert [case["status"] for case in cases.json["cases"]] == ["not_started", "unavailable"]
    progress_url = f"/api/projects/{project['id']}/progress"
    progress = client.get(progress_url).json["assignments"][0]
    assert progress["counts"] == {"not_started": 1, "unavailable": 1}
    assert client.get(progress_url, headers={"X-Test-User": assignee}).status_code == 404
    assert client.post(f"/api/projects/{project['id']}/assignments", json=body).status_code == 409
    retry_url = f"/api/assignments/{created.json['id']}/cases/PanTS_00000056/retry-availability"
    assert client.post(retry_url).status_code == 409
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    assert client.post(retry_url, headers={"X-Test-User": assignee}).status_code == 403
    # An unavailable row does not reserve the target; a new assignment can
    # claim it, but then the old row must not be reopened over that work.
    competing = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": assignee,
        "case_selector": {"ids": [56]}}).json["id"]
    assert client.post(retry_url).status_code == 409
    from models.annotation_project import AnnotationAssignment
    with engine.session_scope() as session:
        session.delete(session.get(AnnotationAssignment, competing))
    assert client.post(retry_url).json["status"] == "not_started"
    assert client.post(retry_url).status_code == 409
    assert client.get(f"/api/assignments/{created.json['id']}/cases", headers={"X-Test-User": assignee}).status_code == 200
    with engine.session_scope() as session:
        from sqlalchemy import delete
        session.execute(delete(UserRole).where(UserRole.user_id == assignee, UserRole.role == "annotator"))
    assert client.get(f"/api/assignments/{created.json['id']}/cases", headers={"X-Test-User": assignee}).status_code == 404


def test_reassignment_transfers_access_and_project_close_prevents_new_work(client, monkeypatch):
    import api.assignment_blueprint as module
    from models.user_role import UserRole

    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.session_scope() as session:
        for uid, email in [(first, "first@example.org"), (second, "second@example.org")]:
            session.add(User(id=uid, email=email, is_system=False))
            session.flush()
            session.add(UserRole(id=str(uuid.uuid4()), user_id=uid, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants",
        "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": first,
        "case_selector": {"ids": [55]}}).json["id"]
    path = f"/api/assignments/{assignment}/cases"
    assert client.get(path, headers={"X-Test-User": first}).status_code == 200
    assert client.patch(f"/api/assignments/{assignment}", json={"assignee_id": second}).status_code == 200
    assert client.get(path, headers={"X-Test-User": first}).status_code == 404
    assert client.get(path, headers={"X-Test-User": second}).status_code == 200
    assert client.post(f"/api/projects/{project['id']}/close").status_code == 200
    assert client.patch(f"/api/assignments/{assignment}", json={"assignee_id": first}).status_code == 409
    assert client.get(f"/api/projects/{project['id']}/export.csv").status_code == 200


def test_seed_upload_rejects_unsafe_paths_and_preserves_valid_seed(client, tmp_path, monkeypatch):
    import io
    import zipfile
    import nibabel as nib
    import numpy as np
    from services.annotation_storage import seed_path

    ct_dir = tmp_path / "dataset" / "image_only" / "PanTS_00000055"
    ct_dir.mkdir(parents=True)
    monkeypatch.setattr(Constants, "PANTS_PATH", str(tmp_path / "dataset"))
    mask = tmp_path / "mask.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4)), mask)
    nib.save(nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4)), ct_dir / "ct.nii.gz")
    project = client.post("/api/projects", json={"name": "Seeds", "scan_source": "pants",
        "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "seed"}).json
    def archive(name):
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as z:
            z.writestr(name, mask.read_bytes())
        content.seek(0)
        return content
    url = f"/api/projects/{project['id']}/seed"
    assert client.post(url, data={"file": (archive("../PanTS_00000055.nii.gz"), "seeds.zip")}).status_code == 400
    assert client.post(url, data={"file": (archive("PanTS_00000055.nii.gz"), "seeds.zip")}).status_code == 201
    assert os.path.isfile(seed_path(project["id"], "PanTS_00000055"))
    from models.annotation_project import AnnotationAssignment, AnnotationCase
    assignment_id = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(AnnotationAssignment(id=assignment_id, project_id=project["id"], case_selector={}))
        session.flush()
        session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=assignment_id, case_key="PanTS_00000055"))
    storage_url = f"/api/projects/{project['id']}/storage"
    assert client.get(storage_url).status_code == 200
    os.unlink(seed_path(project["id"], "PanTS_00000055"))
    assert client.get(storage_url).status_code == 503
    with open(seed_path(project["id"], "PanTS_00000055"), "wb") as handle:
        handle.write(mask.read_bytes())
    assert client.post(url, data={"file": (archive("PanTS_00000055.nii.gz"), "seeds.zip")}).status_code == 409
    import api.assignment_blueprint as module
    from models.annotation_project import AnnotationProject
    with engine.session_scope() as session:
        record = session.get(AnnotationProject, project["id"])
        assert module._case_available(record, "PanTS_00000055") == (True, None)
        nib.save(nib.Nifti1Image(np.zeros((3, 2, 2), dtype=np.uint8), np.eye(4)), ct_dir / "ct.nii.gz")
        assert module._case_available(record, "PanTS_00000055") == (False, "Mask grid does not match CT")


def test_draft_is_private_and_rejects_stale_revision(client, monkeypatch, tmp_path):
    import gzip
    import json
    import nibabel as nib
    import numpy as np
    import api.assignment_blueprint as module
    import api.api_blueprint as viewer
    from models.user_role import UserRole

    assignee = str(uuid.uuid4())
    other = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add_all([User(id=assignee, email="reader@example.org", is_system=False),
                         User(id=other, email="other@example.org", is_system=False)])
        session.flush()
        session.add(UserRole(id=str(uuid.uuid4()), user_id=assignee, role="annotator"))
    monkeypatch.setattr(module, "_case_available", lambda project, key: (True, None))
    reference = np.zeros((2, 2, 2), dtype=np.uint8)
    reference[0, 0, 0] = 2
    path = tmp_path / "reference.nii.gz"
    nib.save(nib.Nifti1Image(reference, np.eye(4)), path)
    monkeypatch.setattr(viewer, "_save_reference_path", lambda key, low=False:
                        viewer._pants_shared_edit_path(key) if os.path.isfile(viewer._pants_shared_edit_path(key)) else str(path))
    project = client.post("/api/projects", json={"name": "Ducts", "scan_source": "pants",
        "target_labels": [7], "target_names": {"7": "Duct"}, "baseline_mode": "canonical"}).json
    assignment = client.post(f"/api/projects/{project['id']}/assignments", json={"assignee_id": assignee,
        "case_selector": {"ids": [55]}}).json["id"]
    url = f"/api/assignments/{assignment}/cases/PanTS_00000055/draft"
    geometry = {"dimensions": [2, 2, 2], "spacing": [1, 1, 1], "origin": [0, 0, 0],
                "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]}
    edited = reference.copy()
    edited[1, 1, 1] = 7
    payload = gzip.compress(edited.tobytes(order="F"))
    headers = {"X-Test-User": assignee, "If-Match": "none", "X-Labelmap-Geometry": json.dumps(geometry)}
    saved = client.post(url, data=payload, headers=headers)
    assert saved.status_code == 200
    mask_url = f"/test-mask/PanTS_00000055?assignment={assignment}"
    assert client.get(mask_url, headers={"X-Test-User": assignee}).status_code == 200
    assert client.get(mask_url, headers={"X-Test-User": other}).status_code == 404
    monkeypatch.setattr(viewer, "_ai_compute_organ_metrics_from_labels", lambda case_id, mask_path_override=None:
                        {"organ_metrics": [{"voxel_count": int(np.count_nonzero(np.asarray(nib.load(mask_path_override).dataobj) == 7))}]})
    stats = {"sessionKey": "PanTS_00000055", "assignment": assignment}
    assert client.post("/test-mask-data", data=stats, headers={"X-Test-User": assignee}).json["organ_metrics"][0]["voxel_count"] == 1
    assert client.post("/test-mask-data", data=stats, headers={"X-Test-User": other}).status_code == 404
    # Managers and reviewers must not see a draft before it is submitted.
    assert client.get(mask_url).status_code == 404
    assert client.post(url, data=payload, headers=headers).status_code == 409
    headers["X-Test-User"] = other
    assert client.post(url, data=payload, headers=headers).status_code == 404
    headers.update({"X-Test-User": assignee, "If-Match": saved.json["revision"]})
    edited[0, 0, 0] = 0
    assert client.post(url, data=gzip.compress(edited.tobytes(order="F")), headers=headers).status_code == 409
    submit_url = url.removesuffix("/draft") + "/submit"
    submitted = client.post(submit_url, json={"note": "Ready"}, headers=headers)
    assert submitted.status_code == 201
    history_url = "/api/cases/PanTS_00000055/annotation-history"
    assert client.get(history_url, headers={"X-Test-User": other}).status_code == 404
    assert [event["action"] for event in client.get(history_url).json["events"]] == ["assign", "draft", "submit"]
    detail_url = f"/api/submissions/{submitted.json['submission_id']}"
    assert client.get(detail_url, headers={"X-Test-User": other}).status_code == 404
    assert client.get(detail_url, headers={"X-Test-User": assignee}).json["note"] == "Ready"
    assert client.get(mask_url).status_code == 200
    assert client.head(mask_url, headers={"X-Test-User": assignee}).status_code == 200
    assert client.post(submit_url, json={}, headers=headers).status_code == 409
    assert client.post(url, data=payload, headers=headers).status_code == 409
    first_submission = submitted.json["submission_id"]
    from services import mailer
    def invalid_mail_config():
        raise ValueError("invalid SMTP configuration")
    monkeypatch.setattr(mailer, "is_configured", invalid_mail_config)
    review = client.post(f"/api/submissions/{first_submission}/rework", json={"comment": "Adjust the edge", "notify": True})
    assert review.status_code == 200 and review.json["notification"] == "unavailable"
    context = client.get(url.removesuffix("/draft"), headers={"X-Test-User": assignee}).json
    assert context["review_note"] == "Adjust the edge" and context["can_edit"] is True
    revised = reference.copy()
    revised[1, 0, 1] = 7
    saved_again = client.post(url, data=gzip.compress(revised.tobytes(order="F")), headers=headers)
    assert saved_again.status_code == 200
    headers["If-Match"] = saved_again.json["revision"]
    submitted = client.post(submit_url, json={}, headers=headers)
    assert submitted.status_code == 201 and submitted.json["version"] == 2
    from models.annotation_project import AnnotationSubmission
    with engine.session_scope() as session:
        first = session.get(AnnotationSubmission, first_submission)
        assert np.asarray(nib.load(first.mask_full_path).dataobj)[1, 1, 1] == 7
        assert np.asarray(nib.load(first.mask_full_path).dataobj)[1, 0, 1] == 0
    review_url = f"/api/submissions/{submitted.json['submission_id']}/approve"
    assert client.post(review_url, json={}, headers={"X-Test-User": other}).status_code == 404
    assert client.post(review_url, json={}).status_code == 200
    assert client.post(review_url, json={}).status_code == 409
    publish_url = f"/api/submissions/{submitted.json['submission_id']}/publish"
    assert client.post(publish_url, json={}, headers={"X-Test-User": other}).status_code == 404
    # Historical data that violates the assignment guard must fail closed.
    from models.annotation_project import AnnotationAssignment, AnnotationCase
    conflict_id = str(uuid.uuid4())
    with engine.session_scope() as session:
        session.add(AnnotationAssignment(id=conflict_id, project_id=project["id"], assignee_id=assignee,
                                         case_selector={"ids": [55]}, status="open"))
        session.flush()
        session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=conflict_id,
                                   case_key="PanTS_00000055", status="in_progress"))
    assert client.post(publish_url, json={}).status_code == 409
    with engine.session_scope() as session:
        session.delete(session.get(AnnotationAssignment, conflict_id))
    # A crash or disk error after the canonical rename leaves a marker. A
    # retry must finish the database record without applying the mask twice.
    import errno
    real_write_meta = viewer._write_shared_meta
    def fail_meta(*_args):
        raise OSError(errno.ENOSPC, "disk full")
    monkeypatch.setattr(viewer, "_write_shared_meta", fail_meta)
    assert client.post(publish_url, json={}).status_code == 507
    monkeypatch.setattr(viewer, "_write_shared_meta", real_write_meta)
    published = client.post(publish_url, json={})
    assert published.status_code == 200
    assert client.post(publish_url, json={}).json["already_published"] is True
    result = np.asarray(nib.load(viewer._pants_shared_edit_path("PanTS_00000055")).dataobj)
    assert result[0, 0, 0] == 2 and result[1, 0, 1] == 7
    shared_path = viewer._pants_shared_edit_path("PanTS_00000055")
    changed = result.copy()
    changed[1, 0, 1] = 0
    nib.save(nib.Nifti1Image(changed, np.eye(4)), shared_path)
    rollback_headers = {"X-Operation-ID": str(uuid.uuid4()), "If-Match": viewer._pants_shared_revision("PanTS_00000055")}
    rollback_url = f"/api/submissions/{submitted.json['submission_id']}/republish"
    assert client.post(rollback_url, json={}, headers={**rollback_headers, "X-Test-User": other}).status_code == 403
    monkeypatch.setattr(viewer, "_write_shared_meta", fail_meta)
    assert client.post(rollback_url, json={}, headers=rollback_headers).status_code == 507
    assert module.pending_publication_exists("PanTS_00000055")
    monkeypatch.setattr(viewer, "_write_shared_meta", real_write_meta)
    assert client.post(rollback_url, json={}, headers=rollback_headers).status_code == 200
    assert not module.pending_publication_exists("PanTS_00000055")
    assert client.post(rollback_url, json={}, headers=rollback_headers).json["already_published"] is True
    assert np.asarray(nib.load(shared_path).dataobj)[1, 0, 1] == 7
    from models.annotation_project import AnnotationSubmission
    with engine.session_scope() as session:
        snapshot = session.get(AnnotationSubmission, submitted.json["submission_id"])
        assert snapshot.mask_revision == saved_again.json["revision"]
        np.testing.assert_array_equal(np.asarray(nib.load(snapshot.mask_full_path).dataobj)[0, 0, 0], 2)
