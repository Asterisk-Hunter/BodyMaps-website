"""Annotation project endpoints, disabled by default."""
import hashlib
import os
import re
import uuid

from flask import Blueprint, abort, jsonify, request, send_file
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.exc import IntegrityError

from api.auth import current_roles, current_user
from models.annotation_project import AnnotationAssignment, AnnotationCase, AnnotationProject, AnnotationReviewEvent, AnnotationSubmission
from models.annotator_invite import AnnotatorInvite
from models.engine import session_scope
from models.user import User
from models.user_role import UserRole
from services import role_store
from services.annotation_workflow import SOURCES, expand_selector, normalize_case, transition
from services.segmentation_save_lock import segmentation_save_lock

assignment_blueprint = Blueprint("assignment", __name__)


def _normalize_project_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()) if isinstance(name, str) else ""


def projects_enabled():
    return os.environ.get("BODYMAPS_ANNOTATION_PROJECTS", "0") == "1"


def _can_review(project, user, roles):
    # Review actions are part of project administration: only its creator can
    # approve, request rework, publish, or restore submissions.
    return _can_manage_project(project, user)


def _is_project_owner(project, user):
    user_id = user["id"] if isinstance(user, dict) else getattr(user, "id", None)
    return bool(project and user and project.created_by == user_id)


def _can_manage_project(project, user):
    """Project controls belong to their creator or manager/admin."""
    if _is_project_owner(project, user):
        return True
    user_id = user["id"] if isinstance(user, dict) else getattr(user, "id", None)
    if user_id and (role_store.has_role(user_id, role_store.ROLE_ANNOTATION_MANAGER) or role_store.has_role(user_id, role_store.ROLE_ADMIN)):
        return True
    return False


def _is_project_member(session, project_id, user_id):
    """Global users are eligible without invite bottleneck."""
    # Invite requirement commented out:
    # joined = session.execute(select(AnnotatorInvite.id).where(
    #     AnnotatorInvite.project_id == project_id,
    #     AnnotatorInvite.redeemed_by == user_id,
    #     AnnotatorInvite.redeemed_at.is_not(None),
    # ).limit(1)).first()
    # return bool(joined and role_store.has_role(user_id, role_store.ROLE_ANNOTATOR))
    person = session.get(User, user_id)
    return bool(person and not person.is_system and person.deletion_requested_at is None)


def active_assignment_exists(case_key):
    """Call while holding the assignment-creation lock to prevent races."""
    if not projects_enabled():
        # The feature can be disabled after assignments have been created.
        # Keep their masks protected, while remaining compatible with installs
        # that have not yet applied the optional migration.
        from sqlalchemy import inspect
        from models.engine import get_engine
        if not inspect(get_engine()).has_table("annotation_case"):
            return False
    with session_scope() as session:
        return session.execute(select(AnnotationCase.id).where(
            AnnotationCase.case_key == case_key, AnnotationCase.status.notin_(["published", "unavailable", "released"])).limit(1)).first() is not None


def pending_publication_exists(case_key):
    """Prevent a direct shared save from overwriting a recovery marker."""
    if not projects_enabled():
        from sqlalchemy import inspect
        from models.engine import get_engine
        if not inspect(get_engine()).has_table("annotation_submission"):
            return False
    import nibabel as nib
    from api.api_blueprint import _pants_shared_edit_path
    from services.annotation_merge import publish_marker
    path = _pants_shared_edit_path(case_key)
    if not os.path.isfile(path):
        return False
    marker = publish_marker(nib.load(path))
    if not marker:
        return False
    with session_scope() as session:
        if marker.get("operation_id"):
            return session.get(AnnotationReviewEvent, marker["operation_id"]) is None
        submission = session.get(AnnotationSubmission, marker.get("submission_id"))
        return submission is not None and submission.status != "published"


@assignment_blueprint.before_request
def _feature_gate():
    if not projects_enabled() and request.endpoint != "assignment.capabilities":
        abort(404)


@assignment_blueprint.get("/annotation-projects/capabilities")
def capabilities():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    enabled = projects_enabled()
    can_manage = enabled
    can_review = False
    if enabled:
        with session_scope() as session:
            can_review = session.execute(
                select(AnnotationProject.id).where(AnnotationProject.created_by == user["id"]).limit(1)
            ).first() is not None
    return jsonify({"enabled": enabled, "can_manage": can_manage, "can_review": can_review})


@assignment_blueprint.get("/annotation-projects/people")
def assignment_people():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    query = (request.args.get("q") or "").strip().lower()
    project_id = (request.args.get("project_id") or "").strip()
    if not project_id:
        return jsonify({"error": "A project is required."}), 400
    if query and len(query) > 120:
        return jsonify({"error": "Query too long"}), 400
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None or not _can_manage_project(project, user):
            return jsonify({"error": "Project not found."}), 404
        # Global search: search all non-system registered users without invite restriction
        stmt = select(User).where(
            User.is_system.is_(False), User.deletion_requested_at.is_(None)
        )
        if query:
            pattern = "%" + query.replace("/", "//").replace("%", "/%").replace("_", "/_") + "%"
            stmt = stmt.where(
                or_(func.lower(User.email).like(pattern, escape="/"), func.lower(func.coalesce(User.name, "")).like(pattern, escape="/"))
            )
        rows = session.execute(
            stmt.distinct().order_by(func.coalesce(User.name, User.email)).limit(200)
        ).scalars().all()
        people = [{"id": person.id, "name": person.name, "email": person.email} for person in rows]
    return jsonify({"people": people})


def _project_json(project, user=None):
    reviewer_roles = role_store.roles_for(project.reviewer_id) if project.reviewer_id else []
    return {
        "id": project.id, "name": project.name, "description": project.description,
        "created_by": project.created_by, "can_manage": _can_manage_project(project, user),
        "scan_source": project.scan_source, "target_labels": project.target_labels,
        "target_names": project.target_names, "baseline_mode": project.baseline_mode,
        "reviewer_id": project.reviewer_id, "status": project.status,
        "reviewer_has_access": bool(not project.reviewer_id or role_store.ROLE_ANNOTATOR in reviewer_roles),
        "created_at": project.created_at.isoformat() + "Z",
        "due_at": project.due_at.isoformat() + "Z" if project.due_at else None,
    }


@assignment_blueprint.route("/projects", methods=["GET", "POST"])
def projects():
    from datetime import datetime, timezone
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    if request.method == "GET":
        with session_scope() as session:
            query = select(AnnotationProject).order_by(AnnotationProject.created_at.desc())
            if not (role_store.has_role(user["id"], role_store.ROLE_ADMIN) or role_store.has_role(user["id"], role_store.ROLE_ANNOTATION_MANAGER)):
                query = query.where(AnnotationProject.created_by == user["id"])
            return jsonify({"projects": [_project_json(p, user) for p in session.execute(query).scalars()]})
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    name = body.get("name")
    clean_name = _normalize_project_name(name)
    labels = body.get("target_labels")
    names = body.get("target_names")
    source = body.get("scan_source")
    baseline = body.get("baseline_mode")
    reviewer = body.get("reviewer_id")
    if (not clean_name or len(clean_name) > 200 or
            not isinstance(source, str) or source not in SOURCES or not isinstance(baseline, str) or baseline not in {"canonical", "seed", "empty"} or
            not isinstance(labels, list) or not labels or
            any(type(label) is not int or label < 1 or label > 255 for label in labels) or
            len(set(labels)) != len(labels) or not isinstance(names, dict) or
            set(names) != {str(label) for label in labels} or
            any(not isinstance(value, str) or not value.strip() or len(value) > 200 for value in names.values()) or
            (reviewer is not None and (not isinstance(reviewer, str) or len(reviewer) > 36))):
        return jsonify({"error": "Invalid project fields"}), 400
    description = body.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > 10000):
        return jsonify({"error": "Invalid description"}), 400
    due = None
    if body.get("due_at") is not None:
        try:
            due = datetime.fromisoformat(body["due_at"].replace("Z", "+00:00"))
            if due.tzinfo is None:
                raise ValueError()
            due = due.astimezone(timezone.utc).replace(tzinfo=None)
        except (ValueError, AttributeError, TypeError):
            return jsonify({"error": "Due date must include a timezone"}), 400
    if reviewer and not role_store.has_role(reviewer, role_store.ROLE_ANNOTATOR):
        return jsonify({"error": "Reviewer must be an annotator"}), 400
    with session_scope() as session:
        existing = session.execute(
            select(AnnotationProject).where(
                func.lower(AnnotationProject.name) == clean_name.lower(),
                AnnotationProject.status == "open",
            )
        ).scalars().first()
        if existing:
            return jsonify({"error": f"An active project named '{existing.name}' already exists"}), 409
        if reviewer and (session.get(User, reviewer) is None or session.get(User, reviewer).is_system):
            return jsonify({"error": "Reviewer not found"}), 400
        project = AnnotationProject(id=str(uuid.uuid4()), name=clean_name, description=description,
                                    scan_source=source, target_labels=labels, target_names=names,
                                    baseline_mode=baseline, reviewer_id=reviewer, due_at=due, created_by=user["id"], status="open")
        session.add(project)
        session.flush()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id,
                                         actor_id=user["id"], actor_name=user.get("name") or "Account",
                                         action="create_project"))
        result = _project_json(project, user)
    return jsonify(result), 201


@assignment_blueprint.route("/projects/<project_id>", methods=["GET", "PATCH"])
def project_details(project_id):
    from datetime import datetime, timezone
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(silent=True) if request.method == "PATCH" else None
    if request.method == "PATCH" and not isinstance(body, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    if body is not None and (not body or set(body) - {"name", "description", "reviewer_id", "due_at"}):
        return jsonify({"error": "Invalid project fields"}), 400
    if body is not None:
        if "name" in body:
            clean_name = _normalize_project_name(body["name"])
            if not clean_name or len(clean_name) > 200:
                return jsonify({"error": "Invalid name"}), 400
        if "description" in body and body["description"] is not None and (not isinstance(body["description"], str) or len(body["description"]) > 10000):
            return jsonify({"error": "Invalid description"}), 400
        reviewer = body.get("reviewer_id")
        if "reviewer_id" in body and reviewer is not None and (not isinstance(reviewer, str) or
            not role_store.has_role(reviewer, role_store.ROLE_ANNOTATOR)):
            return jsonify({"error": "Reviewer must be an annotator"}), 400
        due = None
        if body.get("due_at") is not None:
            try:
                due = datetime.fromisoformat(body["due_at"].replace("Z", "+00:00"))
                if due.tzinfo is None:
                    raise ValueError()
                due = due.astimezone(timezone.utc).replace(tzinfo=None)
            except (ValueError, AttributeError, TypeError):
                return jsonify({"error": "Due date must include a timezone"}), 400
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if (body is not None and not _can_manage_project(project, user)) or (body is None and not _can_review(project, user, current_roles())):
            return jsonify({"error": "Project not found"}), 404
        if body is not None:
            if project.status != "open":
                return jsonify({"error": "Project is closed"}), 409
            if "name" in body:
                clean_name = _normalize_project_name(body["name"])
                conflict = session.execute(
                    select(AnnotationProject).where(
                        func.lower(AnnotationProject.name) == clean_name.lower(),
                        AnnotationProject.status == "open",
                        AnnotationProject.id != project.id,
                    )
                ).scalars().first()
                if conflict:
                    return jsonify({"error": f"An active project named '{conflict.name}' already exists"}), 409
                project.name = clean_name
            if body.get("reviewer_id"):
                reviewer_account = session.get(User, body["reviewer_id"])
                if reviewer_account is None or reviewer_account.is_system:
                    return jsonify({"error": "Reviewer not found"}), 400
            for field in ("description", "reviewer_id"):
                if field in body:
                    setattr(project, field, body[field])
            if "due_at" in body:
                project.due_at = due
            session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id,
                actor_id=user["id"], actor_name=user.get("name") or "Account", action="update_project",
                details={"fields": sorted(body)}))
        result = _project_json(project, user)
    return jsonify(result)


def _visible_assignment(session, assignment_id, user, roles):
    assignment = session.get(AnnotationAssignment, assignment_id)
    if assignment is None:
        return None, None
    project = session.get(AnnotationProject, assignment.project_id)
    if project is None:
        return None, None
    # Project owners can inspect assignment progress. Actual mask editing and
    # submission routes still require the assignee identity below.
    has_annotator_role = bool(session.execute(select(UserRole.id).where(
        UserRole.user_id == user["id"], UserRole.role == role_store.ROLE_ANNOTATOR)).first())
    is_member = has_annotator_role and assignment.assignee_id == user["id"]
    if not (_is_project_owner(project, user) or is_member):
        return None, None
    return assignment, project


@assignment_blueprint.get("/me/assignments")
def my_assignments():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        rows = session.execute(select(AnnotationAssignment, AnnotationProject)
            .join(AnnotationProject, AnnotationAssignment.project_id == AnnotationProject.id)
            .where(AnnotationAssignment.assignee_id == user["id"])).all()
        result = []
        for assignment, project in rows:
            cases = session.execute(select(AnnotationCase.case_key, AnnotationCase.status)
                .where(AnnotationCase.assignment_id == assignment.id).order_by(AnnotationCase.case_key)).all()
            statuses = [case.status for case in cases]
            counts = {status: statuses.count(status) for status in set(statuses)}
            next_case = next((case.case_key for status in ("rework", "in_progress", "not_started")
                              for case in cases if case.status == status), None)
            if assignment.status != "open" or project.status != "open":
                next_case = None
            result.append({"id": assignment.id, "project": _project_json(project, user), "status": assignment.status,
                           "target_labels": assignment.target_labels if assignment.target_labels is not None else project.target_labels,
                           "case_count": len(cases), "counts": counts, "next_case": next_case, "note": assignment.note,
                           "due_at": assignment.due_at.isoformat() + "Z" if assignment.due_at else None})
    return jsonify({"assignments": result})


@assignment_blueprint.get("/assignments/<assignment_id>/cases")
def assignment_cases(assignment_id):
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        assignment, project = _visible_assignment(session, assignment_id, user, current_roles())
        if assignment is None:
            return jsonify({"error": "Assignment not found"}), 404
        rows = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id)
                               .order_by(AnnotationCase.case_key)).scalars().all()
        review_ids = [row.current_submission_id for row in rows if row.status == "rework" and row.current_submission_id]
        notes = {item.id: item.review_note for item in session.execute(
            select(AnnotationSubmission).where(AnnotationSubmission.id.in_(review_ids))).scalars()} if review_ids else {}
        created = session.execute(select(AnnotationReviewEvent).where(
            AnnotationReviewEvent.assignment_id == assignment.id, AnnotationReviewEvent.action == "assign")
            .order_by(AnnotationReviewEvent.created_at)).scalars().first()
        unavailable_reasons = {item.get("case_key"): item.get("reason") for item in ((created.details or {}).get("missing", []) if created else [])
                               if isinstance(item, dict)}
        return jsonify({"assignment_id": assignment.id, "project": _project_json(project, user),
                        "cases": [{"case_key": row.case_key, "status": row.status,
                                   "draft_revision": row.draft_revision,
                                   "unavailable_reason": unavailable_reasons.get(row.case_key) if row.status == "unavailable" else None,
                                   "review_note": notes.get(row.current_submission_id)} for row in rows]})


@assignment_blueprint.get("/assignments/<assignment_id>/cases/<case_key>")
def assignment_case(assignment_id, case_key):
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        assignment, project = _visible_assignment(session, assignment_id, user, current_roles())
        if assignment is None:
            return jsonify({"error": "Case not found"}), 404
        try:
            key = normalize_case(project.scan_source, case_key)
        except ValueError:
            return jsonify({"error": "Case not found"}), 404
        row = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id,
                                                          AnnotationCase.case_key == key)).scalar_one_or_none()
        if row is None:
            return jsonify({"error": "Case not found"}), 404
        submission = session.get(AnnotationSubmission, row.current_submission_id) if row.current_submission_id else None
        return jsonify({"case_key": key, "status": row.status, "draft_revision": row.draft_revision or "none",
                        "review_note": submission.review_note if submission else None,
                        "project": _project_json(project, user), "target_labels": assignment.target_labels or project.target_labels,
                        "can_edit": assignment.assignee_id == user["id"] and project.status == "open"
                                    and assignment.status == "open" and row.status in {"not_started", "in_progress", "rework"}})


@assignment_blueprint.post("/assignments/<assignment_id>/cases/<case_key>/draft")
def save_assignment_draft(assignment_id, case_key):
    import nibabel as nib
    import numpy as np
    from api.api_blueprint import _empty_reference_mask, _save_reference_path
    from services.annotation_storage import decode_full_mask, draft_path, seed_path, write_draft
    from services.annotation_merge import ensure_target_metadata
    from models.job import utcnow

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    expected = request.headers.get("If-Match")
    if not expected:
        return jsonify({"error": "The opened draft revision is required"}), 428
    lock_key = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        assignment, project = _visible_assignment(session, assignment_id, user, current_roles())
        if assignment is None or assignment.assignee_id != user["id"]:
            return jsonify({"error": "Case not found"}), 404
        try:
            key = normalize_case(project.scan_source, case_key)
        except ValueError:
            return jsonify({"error": "Case not found"}), 404
        # Require the canonical spelling so alternate spellings cannot take different locks.
        if key != case_key:
            return jsonify({"error": "Use the canonical case key"}), 400
        row = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id,
                                                          AnnotationCase.case_key == key)).scalar_one_or_none()
        if row is None:
            return jsonify({"error": "Case not found"}), 404
        if assignment.status != "open":
            return jsonify({"error": "Assignment is closed"}), 409
        try:
            new_status = transition(row.status, "save_draft", project_open=project.status == "open")
        except ValueError as error:
            return jsonify({"error": str(error)}), 409
        if expected != (row.draft_revision or "none"):
            return jsonify({"error": "Draft changed in another tab; reopen the case"}), 409
        path = seed_path(project.id, key) if project.baseline_mode == "seed" else _save_reference_path(key, low=False)
        if not path and project.baseline_mode == "empty":
            path = _empty_reference_mask(key, low=False)
        if not path or not os.path.isfile(path):
            return jsonify({"error": "Full-resolution reference unavailable"}), 404
        try:
            reference = nib.load(path)
            max_body = int(np.prod(reference.shape)) + max(1024, int(np.prod(reference.shape)) // 100)
            if request.content_length is not None and request.content_length > max_body:
                return jsonify({"error": "Draft exceeds case grid size"}), 413
            body = request.stream.read(max_body + 1)
            if len(body) > max_body:
                return jsonify({"error": "Draft exceeds case grid size"}), 413
            scalars = decode_full_mask(body, request.headers.get("X-Labelmap-Geometry"), reference)
            if row.draft_revision:
                baseline = np.asarray(nib.load(draft_path(project.id, assignment.id, row.id, row.draft_revision)).dataobj)
            elif project.baseline_mode == "empty":
                baseline = np.zeros(reference.shape, dtype=np.uint8)
            elif project.baseline_mode == "canonical":
                baseline = np.asarray(reference.dataobj)
            elif project.baseline_mode == "seed":
                baseline = np.asarray(reference.dataobj)
            else:
                return jsonify({"error": "Seed baseline is unavailable"}), 409
            targets = assignment.target_labels or project.target_labels
            ensure_target_metadata(reference, project.target_names, targets)
            protected_before = (baseline != 0) & ~np.isin(baseline, targets)
            protected_after = (scalars != 0) & ~np.isin(scalars, targets)
            if np.any((protected_before | protected_after) & (scalars != baseline)):
                return jsonify({"error": "Draft changes a non-target structure"}), 409
            revision = write_draft(project.id, assignment.id, row.id, scalars, reference)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        except OSError as error:
            if error.errno == 28:
                return jsonify({"error": "Not enough storage to save the draft"}), 507
            raise
        row.draft_revision = revision
        row.status = new_status
        row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                                         case_row_id=row.id, actor_id=user["id"], actor_name=user.get("name") or "Account",
                                         action="draft", details={"revision": revision}))
    return jsonify({"saved": True, "revision": revision})


@assignment_blueprint.post("/assignments/<assignment_id>/cases/<case_key>/submit")
def submit_assignment_case(assignment_id, case_key):
    import shutil
    from models.job import utcnow
    from services.annotation_storage import case_directory, draft_path

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    expected = request.headers.get("If-Match")
    if not expected:
        return jsonify({"error": "The opened draft revision is required"}), 428
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or (payload.get("note") is not None and
        (not isinstance(payload["note"], str) or len(payload["note"]) > 10000)):
        return jsonify({"error": "Invalid submission note"}), 400
    lock_key = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        assignment, project = _visible_assignment(session, assignment_id, user, current_roles())
        if assignment is None or assignment.assignee_id != user["id"]:
            return jsonify({"error": "Case not found"}), 404
        try:
            if normalize_case(project.scan_source, case_key) != case_key:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "Case not found"}), 404
        row = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id,
                                                          AnnotationCase.case_key == case_key)).scalar_one_or_none()
        if row is None:
            return jsonify({"error": "Case not found"}), 404
        try:
            new_status = transition(row.status, "submit", project_open=project.status == "open" and assignment.status == "open")
        except ValueError as error:
            return jsonify({"error": str(error)}), 409
        if not row.draft_revision or expected != row.draft_revision:
            return jsonify({"error": "Draft is missing or changed; reopen the case"}), 409
        source = draft_path(project.id, assignment.id, row.id, row.draft_revision)
        if not os.path.isfile(source):
            return jsonify({"error": "Draft file is unavailable"}), 409
        submission_id = str(uuid.uuid4())
        parent = os.path.join(case_directory(project.id, assignment.id, row.id), "submissions")
        destination = os.path.join(parent, submission_id)
        temporary = os.path.join(parent, "." + submission_id)
        try:
            os.makedirs(parent, exist_ok=True)
            os.mkdir(temporary)
            shutil.copyfile(source, os.path.join(temporary, "combined_labels.nii.gz"))
            os.replace(temporary, destination)
        except OSError as error:
            shutil.rmtree(temporary, ignore_errors=True)
            if error.errno == 28:
                return jsonify({"error": "Not enough storage to submit"}), 507
            raise
        version = (session.execute(select(func.max(AnnotationSubmission.version)).where(
            AnnotationSubmission.case_row_id == row.id)).scalar_one() or 0) + 1
        mask_path = os.path.join(destination, "combined_labels.nii.gz")
        submission = AnnotationSubmission(id=submission_id, case_row_id=row.id, assignment_id=assignment.id,
                                          version=version, submitted_by=user["id"], submitted_by_name=user.get("name") or "Account",
                                          note=payload.get("note"), mask_low_path=mask_path, mask_full_path=mask_path,
                                          mask_revision=row.draft_revision, status="in_review")
        session.add(submission)
        row.status = new_status
        row.current_submission_id = submission_id
        row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                                         case_row_id=row.id, submission_id=submission_id, actor_id=user["id"],
                                         actor_name=user.get("name") or "Account", action="submit",
                                         details={"revision": row.draft_revision, "version": version}))
    return jsonify({"submission_id": submission_id, "version": version, "status": "submitted"}), 201


@assignment_blueprint.post("/submissions/<submission_id>/edit")
def edit_submission(submission_id):
    """Create a reviewer-authored immutable version from the current snapshot."""
    import shutil
    import nibabel as nib
    import numpy as np
    from models.job import utcnow
    from services.annotation_storage import case_directory, decode_full_mask, draft_path, write_draft
    from services.annotation_merge import ensure_target_metadata

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    expected = request.headers.get("If-Match")
    if not expected:
        return jsonify({"error": "Submission revision required"}), 428
    with session_scope() as session:
        previous = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, previous.case_row_id) if previous else None
        if row is None:
            return jsonify({"error": "Submission not found"}), 404
        assignment_id, case_key = row.assignment_id, row.case_key
    lock_key = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        previous = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, previous.case_row_id) if previous else None
        if row is None or row.assignment_id != assignment_id:
            return jsonify({"error": "Assignment changed; refresh and try again"}), 409
        assignment = session.get(AnnotationAssignment, row.assignment_id) if row else None
        project = session.get(AnnotationProject, assignment.project_id) if assignment else None
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Submission not found"}), 404
        if row.current_submission_id != previous.id or row.status not in {"submitted", "approved"} or expected != previous.mask_revision:
            return jsonify({"error": "Submission changed or this edit may already have been saved. Return to the review queue and check the latest version before retrying."}), 409
        if not os.path.isfile(previous.mask_full_path):
            return jsonify({"error": "Submission mask is unavailable"}), 409
        try:
            reference = nib.load(previous.mask_full_path)
            maximum = int(np.prod(reference.shape)) + max(1024, int(np.prod(reference.shape)) // 100)
            if request.content_length is not None and request.content_length > maximum:
                return jsonify({"error": "Mask exceeds case grid size"}), 413
            body = request.stream.read(maximum + 1)
            if len(body) > maximum:
                return jsonify({"error": "Mask exceeds case grid size"}), 413
            scalars = decode_full_mask(body, request.headers.get("X-Labelmap-Geometry"), reference)
            baseline = np.asarray(reference.dataobj)
            targets = assignment.target_labels or project.target_labels
            protected = ((baseline != 0) & ~np.isin(baseline, targets)) | ((scalars != 0) & ~np.isin(scalars, targets))
            if np.any(protected & (scalars != baseline)):
                return jsonify({"error": "Edit changes a non-target structure"}), 409
            ensure_target_metadata(reference, project.target_names, targets)
            revision = write_draft(project.id, assignment.id, row.id, scalars, reference)
            new_id = str(uuid.uuid4())
            parent = os.path.join(case_directory(project.id, assignment.id, row.id), "submissions")
            os.makedirs(parent, exist_ok=True)
            temporary, destination = os.path.join(parent, "." + new_id), os.path.join(parent, new_id)
            os.mkdir(temporary)
            try:
                shutil.copyfile(draft_path(project.id, assignment.id, row.id, revision), os.path.join(temporary, "combined_labels.nii.gz"))
                os.replace(temporary, destination)
            except OSError:
                shutil.rmtree(temporary, ignore_errors=True)
                raise
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        except OSError as error:
            if error.errno == 28:
                return jsonify({"error": "Not enough storage to save the edit"}), 507
            raise
        version = session.execute(select(func.max(AnnotationSubmission.version)).where(AnnotationSubmission.case_row_id == row.id)).scalar_one() or 0
        mask_path = os.path.join(destination, "combined_labels.nii.gz")
        # Keep a previously approved snapshot approved for the documented
        # targeted-rollback path; current-submission checks keep it out of the
        # live queue and prevent it from being published as the new version.
        if previous.status != "approved":
            previous.status = "superseded"
        session.add(AnnotationSubmission(id=new_id, case_row_id=row.id, assignment_id=assignment.id, version=version + 1,
                    submitted_by=user["id"], submitted_by_name=user.get("name") or "Account", mask_low_path=mask_path,
                    mask_full_path=mask_path, mask_revision=revision, status="in_review"))
        # If the reviewer later requests changes, the annotator must resume
        # from this reviewed version, not the draft that preceded it.
        row.current_submission_id, row.status, row.draft_revision = new_id, "submitted", revision
        row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                    case_row_id=row.id, submission_id=new_id, actor_id=user["id"], actor_name=user.get("name") or "Account",
                    action="edit", details={"previous_submission_id": submission_id, "revision": revision}))
    return jsonify({"submission_id": new_id, "version": version + 1, "revision": revision}), 201


@assignment_blueprint.get("/reviews")
def review_queue():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    project_id = request.args.get("project")
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id) if project_id else None
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Project not found"}), 404
        status = request.args.get("status", "in_review")
        if status not in {"in_review", "approved"}:
            return jsonify({"error": "Invalid review status"}), 400
        query = (select(AnnotationSubmission, AnnotationCase, AnnotationAssignment)
                 .join(AnnotationCase, AnnotationSubmission.case_row_id == AnnotationCase.id)
                 .join(AnnotationAssignment, AnnotationSubmission.assignment_id == AnnotationAssignment.id)
                 .where(AnnotationAssignment.project_id == project.id,
                        AnnotationSubmission.status == status,
                        AnnotationCase.current_submission_id == AnnotationSubmission.id)
                 .order_by(AnnotationSubmission.submitted_at))
        return jsonify({"submissions": [{"id": sub.id, "case_key": case.case_key,
                                         "assignment_id": assignment.id, "version": sub.version,
                                         "assignee_id": assignment.assignee_id,
                                         "submitted_by": sub.submitted_by,
                                         "submitted_by_name": sub.submitted_by_name,
                                         "submitted_at": sub.submitted_at.isoformat() + "Z", "note": sub.note}
                                        for sub, case, assignment in session.execute(query).all()]})


@assignment_blueprint.get("/submissions/<submission_id>")
def submission_details(submission_id):
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        sub = session.get(AnnotationSubmission, submission_id)
        if sub is None:
            return jsonify({"error": "Submission not found"}), 404
        assignment, project = _visible_assignment(session, sub.assignment_id, user, current_roles())
        row = session.get(AnnotationCase, sub.case_row_id) if assignment else None
        if row is None or row.assignment_id != assignment.id:
            return jsonify({"error": "Submission not found"}), 404
        events = session.execute(select(AnnotationReviewEvent).where(AnnotationReviewEvent.submission_id == sub.id)
                                 .order_by(AnnotationReviewEvent.created_at)).scalars().all()
        return jsonify({"id": sub.id, "version": sub.version, "status": sub.status,
                        "case_key": row.case_key, "assignment_id": assignment.id,
                        "can_review_edit": _can_review(project, user, current_roles())
                                           and row.current_submission_id == sub.id and row.status in {"submitted", "approved"},
                        "project": _project_json(project, user), "submitted_by_name": sub.submitted_by_name,
                        "submitted_at": sub.submitted_at.isoformat() + "Z", "note": sub.note,
                        "review_note": sub.review_note, "mask_revision": sub.mask_revision,
                        "events": [{"action": event.action, "actor_name": event.actor_name,
                                    "comment": event.comment, "created_at": event.created_at.isoformat() + "Z"}
                                   for event in events]})


@assignment_blueprint.get("/cases/<case_key>/annotation-history")
def annotation_history(case_key):
    from api.api_blueprint import _shared_case_key

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    key = _shared_case_key(case_key)
    if not key:
        return jsonify({"error": "Case not found"}), 404
    with session_scope() as session:
        query = (select(AnnotationReviewEvent, AnnotationProject, AnnotationSubmission)
                 .join(AnnotationCase, or_(AnnotationReviewEvent.case_row_id == AnnotationCase.id,
                     and_(AnnotationReviewEvent.case_row_id.is_(None), AnnotationReviewEvent.assignment_id == AnnotationCase.assignment_id)))
                 .join(AnnotationProject, AnnotationReviewEvent.project_id == AnnotationProject.id)
                 .outerjoin(AnnotationSubmission, AnnotationReviewEvent.submission_id == AnnotationSubmission.id)
                 .where(AnnotationCase.case_key == key))
        query = query.where(AnnotationProject.created_by == user["id"])
        rows = session.execute(query.order_by(AnnotationReviewEvent.created_at)).all()
        if not rows:
            return jsonify({"error": "Case not found"}), 404
        return jsonify({"case_key": key, "events": [{"id": event.id, "project_id": project.id,
                         "project_name": project.name, "assignment_id": event.assignment_id,
                         "submission_id": event.submission_id, "action": event.action,
                         "submission_assignment_id": submission.assignment_id if submission else None,
                         "submission_status": submission.status if submission else None,
                         "actor_name": event.actor_name, "comment": event.comment,
                         "created_at": event.created_at.isoformat() + "Z", "details": event.details}
                        for event, project, submission in rows]})


@assignment_blueprint.post("/submissions/<submission_id>/<action>")
def review_submission(submission_id, action):
    from models.job import utcnow

    if action not in {"approve", "rework"}:
        abort(404)
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    payload = request.get_json(silent=True)
    if payload is None:
        payload = {}
    if not isinstance(payload, dict) or (payload.get("comment") is not None and
       (not isinstance(payload["comment"], str) or len(payload["comment"]) > 10000)) or (
       "notify" in payload and not isinstance(payload["notify"], bool)):
        return jsonify({"error": "Invalid review comment"}), 400
    # Read only enough to determine the common case lock, then re-read under it.
    with session_scope() as session:
        sub = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, sub.case_row_id) if sub else None
        if row is None:
            return jsonify({"error": "Submission not found"}), 404
        assignment_id, case_key = row.assignment_id, row.case_key
    lock_key = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        sub = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, sub.case_row_id) if sub else None
        if row is None or row.assignment_id != assignment_id:
            return jsonify({"error": "Assignment changed; refresh and try again"}), 409
        assignment = session.get(AnnotationAssignment, row.assignment_id) if row else None
        project = session.get(AnnotationProject, assignment.project_id) if assignment else None
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Submission not found"}), 404
        if row.current_submission_id != sub.id or not os.path.isfile(sub.mask_full_path):
            return jsonify({"error": "Submission is no longer current or its mask is unavailable. Refresh the review queue."}), 409
        try:
            next_status = transition(row.status, action, project_open=project.status == "open")
        except ValueError as error:
            return jsonify({"error": f"{error}. Refresh the review queue."}), 409
        row.status = next_status
        row.updated_at = row.last_activity_at = utcnow()
        sub.status = "approved" if action == "approve" else "rework"
        sub.reviewer_id = user["id"]
        sub.reviewed_at = utcnow()
        sub.review_note = payload.get("comment")
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                                         case_row_id=row.id, submission_id=sub.id, actor_id=user["id"],
                                         actor_name=user.get("name") or "Account", action=action,
                                         comment=payload.get("comment")))
        recipient = session.get(User, assignment.assignee_id) if action == "rework" and payload.get("notify") and assignment.assignee_id else None
        recipient_email = recipient.email if recipient and not recipient.is_system else None
    notification = "not_requested"
    if action == "rework" and payload.get("notify"):
        from services import mailer
        notification = "unavailable"
        try:
            if recipient_email and mailer.is_configured() and mailer.send(
                    recipient_email, "BodyMaps annotation needs your attention",
                    "Changes were requested on an annotation assignment. Sign in to BodyMaps and open your worklist to see the feedback."):
                notification = "accepted"
        except Exception:
            # The review is already committed; report notification failure
            # without suggesting that it is safe to retry the review action.
            import logging
            logging.getLogger(__name__).warning("Annotation rework notification failed")
    return jsonify({"id": submission_id, "status": next_status, "notification": notification})


@assignment_blueprint.post("/submissions/<submission_id>/publish")
@assignment_blueprint.post("/submissions/<submission_id>/republish")
def publish_submission(submission_id):
    import json
    import nibabel as nib
    import numpy as np
    from nibabel.processing import resample_from_to
    from api import api_blueprint as viewer
    from models.job import utcnow
    from services.annotation_merge import ensure_target_metadata, merge_target_labels, publish_marker, set_publish_marker
    from services.atomic_write import atomic_destination
    from services.segmentation_save_payload import matches_labelmap_grid

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    rollback = request.path.endswith("/republish")
    operation_id = request.headers.get("X-Operation-ID") if rollback else None
    expected_revision = request.headers.get("If-Match") if rollback else None
    if rollback:
        try:
            if not operation_id or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "A UUID operation ID is required"}), 400
        if not expected_revision:
            return jsonify({"error": "The current shared revision is required"}), 428
    with session_scope() as session:
        sub = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, sub.case_row_id) if sub else None
        if row is None:
            return jsonify({"error": "Submission not found"}), 404
        assignment_id, case_key = row.assignment_id, row.case_key
    assignment_lock = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    shared_lock = hashlib.sha256(f"shared:{case_key}".encode()).hexdigest()
    case_lock = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(assignment_lock), segmentation_save_lock(shared_lock), segmentation_save_lock(case_lock), session_scope() as session:
        sub = session.get(AnnotationSubmission, submission_id)
        row = session.get(AnnotationCase, sub.case_row_id) if sub else None
        if row is None or row.assignment_id != assignment_id:
            return jsonify({"error": "Assignment changed; refresh and try again"}), 409
        assignment = session.get(AnnotationAssignment, row.assignment_id) if row else None
        project = session.get(AnnotationProject, assignment.project_id) if assignment else None
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Submission not found"}), 404
        if rollback and not _can_manage_project(project, user):
            return jsonify({"error": "Submission not found"}), 404
        prior_event = session.get(AnnotationReviewEvent, operation_id) if rollback else None
        if prior_event is not None:
            if prior_event.action != "republish" or prior_event.submission_id != sub.id:
                return jsonify({"error": "Operation ID is already in use"}), 409
            return jsonify({"id": sub.id, "status": "published", "already_published": True,
                            "revision": (prior_event.details or {}).get("revision")})
        if sub.status == "published" and not rollback:
            return jsonify({"id": sub.id, "status": "published", "already_published": True})
        if rollback and sub.status not in {"approved", "published"}:
            return jsonify({"error": "Only approved or published submissions can be restored"}), 409
        if rollback and row.status != "published":
            return jsonify({"error": "Finish or reconcile the current assignment before restoring an older version"}), 409
        if not rollback and (sub.status != "approved" or row.status != "approved" or row.current_submission_id != sub.id):
            return jsonify({"error": "Only the current approved submission can be published"}), 409
        if not os.path.isfile(sub.mask_full_path):
            return jsonify({"error": "Submission mask is unavailable"}), 409
        own_targets = set(assignment.target_labels or project.target_labels)
        conflicts = session.execute(select(AnnotationAssignment.target_labels, AnnotationProject.target_labels)
            .join(AnnotationCase, AnnotationCase.assignment_id == AnnotationAssignment.id)
            .join(AnnotationProject, AnnotationProject.id == AnnotationAssignment.project_id)
            .where(AnnotationCase.case_key == case_key, AnnotationCase.id != row.id,
                   AnnotationCase.status.notin_(["published", "unavailable", "released"]))).all()
        if any(own_targets.intersection(other or project_targets) for other, project_targets in conflicts):
            return jsonify({"error": "Another active assignment targets the same structure; reconcile before publishing"}), 409
        destination = viewer._pants_shared_edit_path(case_key)
        base_path = viewer._save_reference_path(case_key, low=False) or viewer._empty_reference_mask(case_key, low=False)
        if not base_path or not os.path.isfile(base_path):
            return jsonify({"error": "Canonical mask is unavailable"}), 409
        try:
            base = nib.load(base_path)
            previous_marker = publish_marker(base)
            if previous_marker and previous_marker.get("submission_id") != sub.id:
                previous = session.get(AnnotationSubmission, previous_marker.get("submission_id"))
                if previous and previous.status != "published":
                    return jsonify({"error": "An earlier publish requires recovery"}), 409
            pending_operation = previous_marker.get("operation_id") if previous_marker else None
            if pending_operation and session.get(AnnotationReviewEvent, pending_operation) is None and pending_operation != operation_id:
                return jsonify({"error": "An earlier rollback requires recovery"}), 409
            recovered = bool(previous_marker and previous_marker.get("submission_id") == sub.id and
                             (not rollback or pending_operation == operation_id))
            if rollback and not recovered and expected_revision != viewer._pants_shared_revision(case_key):
                return jsonify({"error": "Shared annotation changed; reload before restoring"}), 409
            if not recovered:
                submitted = nib.load(sub.mask_full_path)
                if not matches_labelmap_grid(submitted.shape, submitted.affine, base.shape, base.affine):
                    return jsonify({"error": "Submission grid differs from the canonical grid"}), 409
                if submitted.shape != base.shape or not np.allclose(submitted.affine, base.affine):
                    submitted = resample_from_to(submitted, base, order=0)
                merged = merge_target_labels(np.asarray(base.dataobj), np.asarray(submitted.dataobj),
                                             assignment.target_labels or project.target_labels)
                image = nib.Nifti1Image(merged, base.affine, base.header.copy())
                image.set_data_dtype(np.uint8)
                ensure_target_metadata(image, project.target_names, assignment.target_labels or project.target_labels)
                set_publish_marker(image, {"project_id": project.id, "assignment_id": assignment.id,
                                           "submission_id": sub.id, "actor_id": user["id"],
                                           "operation_id": operation_id})
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with atomic_destination(destination, suffix=".nii.gz") as temporary:
                    nib.save(image, temporary)
                    viewer._archive_shared_version(case_key)
            revision = str(viewer.labelmap_revision(destination))
            meta = viewer._read_shared_meta(case_key)
            if meta.get("submission_id") != sub.id or meta.get("revision") != revision:
                viewer._write_shared_meta(case_key, revision)
                meta = viewer._read_shared_meta(case_key)
                meta.update({"project_id": project.id, "assignment_id": assignment.id, "submission_id": sub.id})
                with atomic_destination(viewer._pants_shared_meta_path(case_key)) as temporary:
                    with open(temporary, "w", encoding="utf-8") as handle:
                        json.dump(meta, handle)
            viewer._AI_METRICS_CACHE.pop(str(case_key).strip(), None)
        except ValueError as error:
            return jsonify({"error": str(error)}), 409
        except OSError as error:
            if error.errno == 28:
                return jsonify({"error": "Not enough storage to publish"}), 507
            raise
        if not rollback:
            sub.status = "published"
            sub.published_at = utcnow()
            sub.published_by = user["id"]
            row.status = "published"
            row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=operation_id or str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                                         case_row_id=row.id, submission_id=sub.id, actor_id=user["id"],
                                         actor_name=user.get("name") or "Account", action="republish" if rollback else "publish",
                                         details={"revision": revision, "recovered": recovered}))
    return jsonify({"id": submission_id, "status": "published", "revision": revision, "already_published": False})


def resolve_assignment_mask(case_key, assignment_id=None, submission_id=None):
    """Return (path, None) or (None, error response) after membership checks."""
    from api.api_blueprint import _empty_reference_mask, _save_reference_path
    from services.annotation_storage import draft_path

    if not projects_enabled():
        return None, (jsonify({"error": "Not found"}), 404)
    user = current_user()
    if user is None:
        return None, (jsonify({"error": "Authentication required"}), 401)
    if bool(assignment_id) == bool(submission_id):
        return None, (jsonify({"error": "Specify one annotation context"}), 400)
    with session_scope() as session:
        submission = session.get(AnnotationSubmission, submission_id) if submission_id else None
        if submission_id and submission is None:
            return None, (jsonify({"error": "Not found"}), 404)
        assignment, project = _visible_assignment(session, submission.assignment_id if submission else assignment_id,
                                                  user, current_roles())
        if assignment is None:
            return None, (jsonify({"error": "Not found"}), 404)
        try:
            key = normalize_case(project.scan_source, case_key)
        except ValueError:
            return None, (jsonify({"error": "Not found"}), 404)
        row = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id,
                                                          AnnotationCase.case_key == key)).scalar_one_or_none()
        if row is None or (submission and submission.case_row_id != row.id):
            return None, (jsonify({"error": "Not found"}), 404)
        if submission:
            path = submission.mask_full_path
        elif row.status in {"submitted", "approved", "published"} and row.current_submission_id:
            snapshot = session.get(AnnotationSubmission, row.current_submission_id)
            path = snapshot.mask_full_path if snapshot and snapshot.case_row_id == row.id else None
        elif assignment.assignee_id != user["id"]:
            return None, (jsonify({"error": "No submission is available for review"}), 404)
        elif row.draft_revision:
            path = draft_path(project.id, assignment.id, row.id, row.draft_revision)
        elif project.baseline_mode == "canonical":
            path = _save_reference_path(key, low=False)
        elif project.baseline_mode == "empty":
            path = _empty_reference_mask(key, low=False)
        elif project.baseline_mode == "seed":
            from services.annotation_storage import seed_path
            path = seed_path(project.id, key)
        else:
            path = None
        if not path or not os.path.isfile(path):
            return None, (jsonify({"error": "Annotation mask unavailable"}), 404)
    return path, None


def assignment_mask_response(case_key, assignment_id=None, submission_id=None):
    """Serve the authorized private mask, including for HEAD requests."""
    path, error = resolve_assignment_mask(case_key, assignment_id, submission_id)
    if error:
        return error
    response = send_file(path, mimetype="application/gzip", conditional=True)
    response.headers["Cache-Control"] = "private, no-store"
    return response


def _case_available(project, case_key):
    """Resolve the same dataset CT and canonical mask used by the viewer."""
    import nibabel as nib
    from services.segmentation_save_payload import matches_labelmap_grid
    from constants import Constants
    from api.api_blueprint import (_abdomenatlas_mask, _cancerverse_mask,
                                   _pants_viewer_mask_path, get_case_nifti_paths)
    if project.scan_source == "pants":
        image = os.path.join(Constants.PANTS_PATH or "", "image_only", case_key, Constants.MAIN_NIFTI_FILENAME)
    else:
        paths = get_case_nifti_paths(case_key)
        image = paths.get("image") if paths else None

    # Check CT availability on disk first to fail fast without I/O or network overhead
    if not image or not os.path.isfile(image):
        return False, "CT unavailable"

    if project.baseline_mode == "canonical":
        if project.scan_source == "pants":
            try:
                case_num = str(int(case_key.removeprefix("PanTS_")))
            except ValueError:
                return False, "Invalid case format"
            mask = _pants_viewer_mask_path(case_num, low=False, prefer_hf=False, allow_mount=True, allow_download=False)
        elif project.scan_source == "cancerverse":
            mask = _cancerverse_mask(case_key)[1]
        else:
            mask = _abdomenatlas_mask(case_key)[1]

        if not mask or not os.path.isfile(mask):
            return False, "Canonical mask unavailable"
    elif project.baseline_mode == "seed":
        from services.annotation_storage import seed_path
        mask = seed_path(project.id, case_key)
        if not os.path.isfile(mask):
            return False, "Seed mask not available"
    else:
        mask = None

    if mask:
        try:
            ct_image, mask_image = nib.load(image), nib.load(mask)
            if len(ct_image.shape) != 3 or len(mask_image.shape) != 3 or not matches_labelmap_grid(
                    mask_image.shape, mask_image.affine, ct_image.shape, ct_image.affine):
                return False, "Mask grid does not match CT"
        except Exception:
            return False, "CT or mask could not be read"
    return True, None


@assignment_blueprint.post("/projects/<project_id>/seed")
def upload_seed_masks(project_id):
    import shutil
    import tempfile
    import zipfile
    import nibabel as nib
    import numpy as np
    from api.utils import get_case_nifti_paths
    from services.annotation_storage import seed_path
    from services.shared_annotations import viewer_cache_root

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    upload = request.files.get("file")
    if upload is None:
        return jsonify({"error": "Upload a ZIP file"}), 400
    try:
        cap = max(1, min(int(os.environ.get("BODYMAPS_ANNOTATION_SEED_MAX_MB", "512")), 2048)) * 1024 * 1024
    except ValueError:
        return jsonify({"error": "Invalid seed size configuration"}), 500
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key), session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None:
            return jsonify({"error": "Project not found"}), 404
        if not _can_manage_project(project, user):
            return jsonify({"error": "Project not found"}), 404
        if project.status != "open" or project.baseline_mode != "seed":
            return jsonify({"error": "An open seed-baseline project is required"}), 409
        if session.execute(select(AnnotationAssignment.id).where(AnnotationAssignment.project_id == project.id).limit(1)).first():
            return jsonify({"error": "Upload seeds before creating assignments"}), 409
        root = os.path.join(viewer_cache_root(), "edits", "assignments", project.id)
        destination = os.path.dirname(seed_path(project.id, normalize_case(project.scan_source, 1)))
        if os.path.exists(destination):
            return jsonify({"error": "Seeds have already been uploaded for this project"}), 409
        os.makedirs(root, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix=".seed-", dir=root) as stage:
                archive_path = os.path.join(stage, "upload.zip")
                with open(archive_path, "wb") as handle:
                    remaining = cap + 1
                    while remaining:
                        chunk = upload.stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        handle.write(chunk)
                        remaining -= len(chunk)
                    if remaining == 0:
                        return jsonify({"error": "Seed archive is too large"}), 413
                output = os.path.join(stage, "seed")
                os.mkdir(output)
                keys = []
                with zipfile.ZipFile(archive_path) as archive:
                    entries = archive.infolist()
                    if not entries or len(entries) > 10000 or sum(entry.file_size for entry in entries) > cap:
                        raise ValueError("Seed archive is empty or too large")
                    for entry in entries:
                        filename = entry.filename
                        if (entry.is_dir() or "/" in filename or "\\" in filename or ".." in filename or
                                not filename.endswith(".nii.gz") or entry.flag_bits & 1):
                            raise ValueError("Each seed must be a plain CASE_ID.nii.gz file")
                        key = normalize_case(project.scan_source, filename[:-7])
                        if key in keys:
                            raise ValueError("Duplicate seed case")
                        ct_path = get_case_nifti_paths(key).get("image")
                        if not ct_path or not os.path.isfile(ct_path):
                            raise ValueError(f"CT unavailable for {key}")
                        target = os.path.join(output, key + ".nii.gz")
                        with archive.open(entry) as source, open(target, "wb") as target_file:
                            shutil.copyfileobj(source, target_file, length=1024 * 1024)
                        image, ct = nib.load(target), nib.load(ct_path)
                        if image.shape != ct.shape or not np.allclose(image.affine, ct.affine, atol=1e-4):
                            raise ValueError(f"Seed geometry does not match {key}")
                        values = np.asarray(image.dataobj)
                        if not np.isfinite(values).all() or np.any(values < 0) or np.any(values > 255) or not np.all(values == np.floor(values)):
                            raise ValueError(f"Invalid label values for {key}")
                        keys.append(key)
                os.replace(output, destination)
        except (ValueError, zipfile.BadZipFile, OSError) as error:
            if isinstance(error, OSError) and error.errno == 28:
                return jsonify({"error": "Not enough storage for seed masks"}), 507
            return jsonify({"error": str(error) if isinstance(error, ValueError) else "Seed archive could not be read"}), 400
        project.seed_dir = destination
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, actor_id=user["id"],
                                         actor_name=user.get("name") or "Account", action="seed_upload",
                                         details={"cases": keys}))
    return jsonify({"cases": keys}), 201


@assignment_blueprint.post("/projects/<project_id>/assignments")
def create_assignment(project_id):
    from datetime import datetime, timezone
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("assignee_id"), str):
        return jsonify({"error": "Assignee and selector are required"}), 400
    if type(body.get("dry_run", False)) is not bool:
        return jsonify({"error": "dry_run must be boolean"}), 400
    note = body.get("note")
    if note is not None and (not isinstance(note, str) or len(note) > 10000):
        return jsonify({"error": "Invalid assignment instructions"}), 400
    due = None
    if body.get("due_at") is not None:
        try:
            due = datetime.fromisoformat(body["due_at"].replace("Z", "+00:00"))
            if due.tzinfo is None:
                raise ValueError()
            due = due.astimezone(timezone.utc).replace(tzinfo=None)
        except (ValueError, AttributeError, TypeError):
            return jsonify({"error": "Due date must include a timezone"}), 400
    assignee = body["assignee_id"]
    # Serialize conflict check and insert across workers and projects, including
    # when two managers concurrently assign the same case for the first time.
    lock_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None:
            return jsonify({"error": "Project not found"}), 404
        if not _can_manage_project(project, user):
            return jsonify({"error": "Project not found"}), 404
        if not _is_project_member(session, project_id, assignee):
            return jsonify({"error": "Assignee has not joined this project."}), 403
        if project.status != "open":
            return jsonify({"error": "Project is closed"}), 409
        try:
            cases = expand_selector(project.scan_source, body.get("case_selector"))
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        labels = body.get("target_labels")
        if labels is None:
            labels = project.target_labels
        elif (not isinstance(labels, list) or not labels or
              any(type(x) is not int for x in labels) or len(set(labels)) != len(labels) or
              not set(labels).issubset(set(project.target_labels))):
            return jsonify({"error": "Assignment targets must be a nonempty subset of project targets"}), 400
        if not cases:
            return jsonify({"error": "Select at least one case"}), 400
        conflicts = []
        rows = session.execute(
            select(AnnotationCase.case_key)
            .join(AnnotationAssignment, AnnotationCase.assignment_id == AnnotationAssignment.id)
            .join(AnnotationProject, AnnotationAssignment.project_id == AnnotationProject.id)
            .where(AnnotationCase.case_key.in_(cases), AnnotationCase.status.notin_(["published", "unavailable", "released"]))
        ).all()
        conflicts.extend(key for (key,) in rows)
        from services.assignment_exclusivity import range_case_conflicts
        conflicts.extend(range_case_conflicts(session, cases))
        matched, missing = [], []
        for key in cases:
            try:
                available, reason = _case_available(project, key)
            except (ValueError, OSError, TypeError):
                available, reason = False, "Case could not be resolved"
            (matched if available else missing).append(key if available else {"case_key": key, "reason": reason})
        if body.get("dry_run", False):
            return jsonify({"matched": matched, "missing": missing, "conflicts": sorted(set(conflicts))})
        if conflicts:
            return jsonify({"error": "Cases already assigned in active project work", "conflicts": sorted(set(conflicts))}), 409
        if "expected_matched" in body and body["expected_matched"] != matched:
            return jsonify({"error": "Case availability changed. Preview the cases again."}), 409
        assignment = AnnotationAssignment(id=str(uuid.uuid4()), project_id=project.id, assignee_id=assignee,
                                          case_selector=body["case_selector"], target_labels=body.get("target_labels"),
                                          note=note, due_at=due, created_by=user["id"], status="open")
        session.add(assignment)
        session.flush()
        for key in matched:
            session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=assignment.id, case_key=key, status="not_started"))
        for item in missing:
            session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=assignment.id, case_key=item["case_key"], status="unavailable"))
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                                         actor_id=user["id"], actor_name=user.get("name") or "Account",
                                         action="assign", details={"case_count": len(cases), "missing": missing}))
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            return jsonify({"error": "One or more cases were assigned by another request. Refresh and choose different cases."}), 409
        result = {"id": assignment.id, "matched": matched, "missing": missing}
    return jsonify(result), 201


@assignment_blueprint.get("/projects/<project_id>/assignments")
def project_assignments(project_id):
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Project not found"}), 404
        assignments = session.execute(select(AnnotationAssignment).where(AnnotationAssignment.project_id == project_id)).scalars().all()
        role_map = role_store.roles_for_many([assignment.assignee_id for assignment in assignments if assignment.assignee_id])
        result = []
        for assignment in assignments:
            statuses = session.execute(select(AnnotationCase.status).where(AnnotationCase.assignment_id == assignment.id)).scalars().all()
            assignee = session.get(User, assignment.assignee_id) if assignment.assignee_id else None
            result.append({"id": assignment.id, "assignee_id": assignment.assignee_id,
                           "assignee_name": (assignee.name or assignee.email) if assignee else None,
                           "assignee_has_access": bool(assignee and role_store.ROLE_ANNOTATOR in role_map.get(assignee.id, [])),
                           "case_selector": assignment.case_selector,
                           "target_labels": assignment.target_labels or project.target_labels,
                           "note": assignment.note, "due_at": assignment.due_at.isoformat() + "Z" if assignment.due_at else None,
                           "status": assignment.status, "case_count": len(statuses),
                           "counts": {status: statuses.count(status) for status in set(statuses)}})
        return jsonify({"assignments": result})


@assignment_blueprint.post("/assignments/<assignment_id>/cases/<case_key>/retry-availability")
def retry_case_availability(assignment_id, case_key):
    """Recheck a previously unavailable case without creating a duplicate assignment."""
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    lock_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(lock_key), session_scope() as session:
        assignment = session.get(AnnotationAssignment, assignment_id)
        project = session.get(AnnotationProject, assignment.project_id) if assignment else None
        if not project:
            return jsonify({"error": "Assignment not found"}), 404
        if not _can_manage_project(project, user):
            return jsonify({"error": "Assignment not found"}), 404
        if project.status != "open" or assignment.status != "open":
            return jsonify({"error": "Project or assignment is closed"}), 409
        try:
            key = normalize_case(project.scan_source, case_key)
        except ValueError:
            return jsonify({"error": "Case not found"}), 404
        row = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment_id,
                                                           AnnotationCase.case_key == key)).scalar_one_or_none()
        if not row:
            return jsonify({"error": "Case not found"}), 404
        if row.status != "unavailable":
            return jsonify({"error": "Case is not marked unavailable"}), 409
        try:
            available, reason = _case_available(project, key)
        except (ValueError, OSError, TypeError):
            available, reason = False, "Case could not be resolved"
        if not available:
            return jsonify({"error": reason or "Case remains unavailable"}), 409
        conflicts = session.execute(select(AnnotationCase.id)
            .where(AnnotationCase.case_key == key, AnnotationCase.id != row.id,
                   AnnotationCase.status.notin_(["published", "unavailable", "released"]))).all()
        if conflicts:
            return jsonify({"error": "Another active assignment already owns this case"}), 409
        from models.job import utcnow
        row.status = "not_started"
        row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                    case_row_id=row.id, actor_id=user["id"], actor_name=user.get("name") or "Account",
                    action="availability_restored"))
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            return jsonify({"error": "Another active assignment already owns this case"}), 409
    return jsonify({"case_key": key, "status": "not_started"})


@assignment_blueprint.post("/assignments/<assignment_id>/cases/<case_key>/release")
def release_unfinished_case(assignment_id, case_key):
    """Release an editable case without deleting its draft or audit history."""
    from models.job import utcnow

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    case_lock = hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest()
    with segmentation_save_lock(global_key), segmentation_save_lock(case_lock), session_scope() as session:
        assignment = session.get(AnnotationAssignment, assignment_id)
        project = session.get(AnnotationProject, assignment.project_id) if assignment else None
        if not project:
            return jsonify({"error": "Case not found"}), 404
        if not _can_manage_project(project, user):
            return jsonify({"error": "Case not found"}), 404
        try:
            if normalize_case(project.scan_source, case_key) != case_key:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "Case not found"}), 404
        row = session.execute(select(AnnotationCase).where(
            AnnotationCase.assignment_id == assignment_id, AnnotationCase.case_key == case_key)).scalar_one_or_none()
        if row is None:
            return jsonify({"error": "Case not found"}), 404
        if row.status not in {"not_started", "in_progress", "rework"}:
            return jsonify({"error": "Only unfinished editable cases can be released"}), 409
        previous_status = row.status
        row.status = "released"
        row.updated_at = row.last_activity_at = utcnow()
        session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
            case_row_id=row.id, actor_id=user["id"], actor_name=user.get("name") or "Account",
            action="release_case", details={"previous_status": previous_status, "draft_revision": row.draft_revision}))
    return jsonify({"case_key": case_key, "status": "released"})


@assignment_blueprint.patch("/assignments/<assignment_id>")
def reassign_assignment(assignment_id):
    from contextlib import ExitStack
    from datetime import datetime, timezone
    from models.job import utcnow

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not body or set(body) - {"assignee_id", "note", "due_at"}:
        return jsonify({"error": "Invalid assignment fields"}), 400
    new_assignee = body.get("assignee_id")
    if "assignee_id" in body and (not isinstance(new_assignee, str) or not role_store.has_role(new_assignee, role_store.ROLE_ANNOTATOR)):
        return jsonify({"error": "Assignee must be an annotator"}), 400
    if "note" in body and body["note"] is not None and (not isinstance(body["note"], str) or len(body["note"]) > 10000):
        return jsonify({"error": "Invalid assignment instructions"}), 400
    due = None
    if body.get("due_at") is not None:
        try:
            due = datetime.fromisoformat(body["due_at"].replace("Z", "+00:00"))
            if due.tzinfo is None:
                raise ValueError()
            due = due.astimezone(timezone.utc).replace(tzinfo=None)
        except (ValueError, AttributeError, TypeError):
            return jsonify({"error": "Due date must include a timezone"}), 400
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key):
        with session_scope() as session:
            assignment = session.get(AnnotationAssignment, assignment_id)
            if assignment is None:
                return jsonify({"error": "Assignment not found"}), 404
            project = session.get(AnnotationProject, assignment.project_id)
            if not _can_manage_project(project, user):
                return jsonify({"error": "Assignment not found"}), 404
            if "assignee_id" in body and not _is_project_member(session, project.id, new_assignee):
                return jsonify({"error": "Assignee has not joined this project."}), 403
            case_keys = session.execute(select(AnnotationCase.case_key).where(AnnotationCase.assignment_id == assignment_id)).scalars().all()
        keys = sorted({hashlib.sha256(f"draft:{assignment_id}:{key}".encode()).hexdigest() for key in case_keys})
        with ExitStack() as stack:
            for key in keys:
                stack.enter_context(segmentation_save_lock(key))
            with session_scope() as session:
                assignment = session.get(AnnotationAssignment, assignment_id)
                project = session.get(AnnotationProject, assignment.project_id)
                if not _can_manage_project(project, user):
                    return jsonify({"error": "Assignment not found"}), 404
                if "assignee_id" in body and not _is_project_member(session, project.id, new_assignee):
                    return jsonify({"error": "Assignee has not joined this project."}), 403
                if project.status != "open" or assignment.status != "open":
                    return jsonify({"error": "Project or assignment is closed"}), 409
                previous = assignment.assignee_id
                if "assignee_id" in body:
                    assignment.assignee_id = new_assignee
                if "note" in body:
                    assignment.note = body["note"]
                if "due_at" in body:
                    assignment.due_at = due
                session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id, assignment_id=assignment.id,
                    actor_id=user["id"], actor_name=user.get("name") or "Account", action="reassign" if "assignee_id" in body else "update_assignment", created_at=utcnow(),
                    details={"previous_assignee_id": previous, "new_assignee_id": assignment.assignee_id, "fields": sorted(body)}))
                result_assignee = assignment.assignee_id
    return jsonify({"id": assignment_id, "assignee_id": result_assignee})


@assignment_blueprint.post("/assignments/<assignment_id>/transfer-unfinished")
def transfer_unfinished(assignment_id):
    """Move editable cases to a new assignment while retaining their history."""
    import shutil
    from contextlib import ExitStack
    from services.annotation_storage import draft_path

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or set(body) != {"assignee_id"} or not isinstance(body["assignee_id"], str):
        return jsonify({"error": "Select an annotator"}), 400
    assignee_id = body["assignee_id"]
    if not role_store.has_role(assignee_id, role_store.ROLE_ANNOTATOR):
        return jsonify({"error": "Assignee must be an annotator"}), 400
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key):
        with session_scope() as session:
            source = session.get(AnnotationAssignment, assignment_id)
            if source is None:
                return jsonify({"error": "Assignment not found"}), 404
            project = session.get(AnnotationProject, source.project_id)
            if not _can_manage_project(project, user):
                return jsonify({"error": "Assignment not found"}), 404
            if not _is_project_member(session, project.id, assignee_id):
                return jsonify({"error": "Assignee has not joined this project."}), 403
            keys = session.execute(select(AnnotationCase.case_key).where(
                AnnotationCase.assignment_id == assignment_id)).scalars().all()
        locks = sorted({hashlib.sha256(f"draft:{assignment_id}:{key}".encode()).hexdigest() for key in keys})
        with ExitStack() as stack:
            for lock in locks:
                stack.enter_context(segmentation_save_lock(lock))
            with session_scope() as session:
                source = session.get(AnnotationAssignment, assignment_id)
                project = session.get(AnnotationProject, source.project_id) if source else None
                if not _can_manage_project(project, user):
                    return jsonify({"error": "Assignment not found"}), 404
                if not _is_project_member(session, project.id, assignee_id):
                    return jsonify({"error": "Assignee has not joined this project."}), 403
                if not project or project.status != "open" or source.status != "open":
                    return jsonify({"error": "Project or assignment is closed"}), 409
                if source.assignee_id == assignee_id:
                    return jsonify({"error": "Choose a different annotator"}), 400
                cases = session.execute(select(AnnotationCase).where(
                    AnnotationCase.assignment_id == assignment_id,
                    AnnotationCase.status.in_(["not_started", "in_progress", "rework"]))).scalars().all()
                if not cases:
                    return jsonify({"error": "No unfinished editable cases to transfer"}), 409
                new_id = str(uuid.uuid4())
                try:
                    copies = []
                    for row in cases:
                        if row.draft_revision:
                            old = draft_path(project.id, source.id, row.id, row.draft_revision)
                            new = draft_path(project.id, new_id, row.id, row.draft_revision)
                            if not os.path.isfile(old):
                                return jsonify({"error": "A draft is unavailable; no cases were transferred"}), 409
                            copies.append((old, new))
                    for old, new in copies:
                        os.makedirs(os.path.dirname(new), exist_ok=True)
                        temporary = new + "." + uuid.uuid4().hex + ".tmp"
                        try:
                            shutil.copyfile(old, temporary)
                            os.replace(temporary, new)
                        finally:
                            if os.path.exists(temporary):
                                os.unlink(temporary)
                except OSError:
                    return jsonify({"error": "Could not copy drafts; no cases were transferred"}), 507
                session.add(AnnotationAssignment(id=new_id, project_id=project.id, assignee_id=assignee_id,
                    case_selector={"ids": [row.case_key for row in cases]}, target_labels=source.target_labels,
                    status="open", note=source.note, due_at=source.due_at, created_by=user["id"]))
                session.flush()
                for row in cases:
                    row.assignment_id = new_id
                    for sub in session.execute(select(AnnotationSubmission).where(
                            AnnotationSubmission.case_row_id == row.id)).scalars():
                        sub.assignment_id = new_id
                    session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id,
                        assignment_id=new_id, case_row_id=row.id, actor_id=user["id"],
                        actor_name=user.get("name") or "Account", action="reassign",
                        details={"previous_assignment_id": assignment_id, "previous_assignee_id": source.assignee_id,
                                 "new_assignee_id": assignee_id}))
                moved = len(cases)
    return jsonify({"id": new_id, "transferred_cases": moved}), 201


@assignment_blueprint.post("/projects/<project_id>/close")
def close_project(project_id):
    from contextlib import ExitStack
    from models.job import utcnow

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key):
        with session_scope() as session:
            project = session.get(AnnotationProject, project_id)
            if project is None:
                return jsonify({"error": "Project not found"}), 404
            if not _can_manage_project(project, user):
                return jsonify({"error": "Project not found"}), 404
            rows = session.execute(select(AnnotationCase.assignment_id, AnnotationCase.case_key)
                                   .join(AnnotationAssignment, AnnotationAssignment.id == AnnotationCase.assignment_id)
                                   .where(AnnotationAssignment.project_id == project_id)).all()
        keys = sorted({hashlib.sha256(f"draft:{assignment_id}:{case_key}".encode()).hexdigest() for assignment_id, case_key in rows})
        with ExitStack() as stack:
            for key in keys:
                stack.enter_context(segmentation_save_lock(key))
            with session_scope() as session:
                project = session.get(AnnotationProject, project_id)
                if not _can_manage_project(project, user):
                    return jsonify({"error": "Project not found"}), 404
                if project.status == "closed":
                    return jsonify({"id": project.id, "status": "closed"})
                project.status = "closed"
                project.closed_at = utcnow()
                session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id,
                                                 actor_id=user["id"], actor_name=user.get("name") or "Account", action="close"))
    return jsonify({"id": project_id, "status": "closed"})


@assignment_blueprint.post("/projects/<project_id>/reopen")
def reopen_project(project_id):
    """Allow the project owner to resume a project closed before work was finished."""
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key), session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None:
            return jsonify({"error": "Project not found"}), 404
        if not _can_manage_project(project, user):
            return jsonify({"error": "Project not found"}), 404
        if project.status == "closed":
            clean_name = _normalize_project_name(project.name)
            conflict = session.execute(
                select(AnnotationProject).where(
                    func.lower(AnnotationProject.name) == clean_name.lower(),
                    AnnotationProject.status == "open",
                    AnnotationProject.id != project.id,
                )
            ).scalars().first()
            if conflict:
                return jsonify({"error": f"Cannot reopen: an active project named '{conflict.name}' already exists"}), 409
            project.status = "open"
            project.closed_at = None
            session.add(AnnotationReviewEvent(id=str(uuid.uuid4()), project_id=project.id,
                                             actor_id=user["id"], actor_name=user.get("name") or "Account",
                                             action="reopen"))
    return jsonify({"id": project_id, "status": "open"})


@assignment_blueprint.delete("/projects/<project_id>")
def delete_project(project_id):
    """Delete an annotation project and all its assignments, cases, and draft files."""
    import shutil
    from services.shared_annotations import viewer_cache_root

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    global_key = hashlib.sha256(b"bodymaps:annotation-assignment-creation").hexdigest()
    with segmentation_save_lock(global_key), session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None or not _can_manage_project(project, user):
            return jsonify({"error": "Project not found"}), 404

        # Delete review events
        session.execute(delete(AnnotationReviewEvent).where(AnnotationReviewEvent.project_id == project_id))

        # Delete annotator invites
        session.execute(delete(AnnotatorInvite).where(AnnotatorInvite.project_id == project_id))

        # Find assignments
        assignment_ids = session.execute(
            select(AnnotationAssignment.id).where(AnnotationAssignment.project_id == project_id)
        ).scalars().all()

        if assignment_ids:
            # Delete submissions
            session.execute(
                delete(AnnotationSubmission).where(AnnotationSubmission.assignment_id.in_(assignment_ids))
            )
            # Delete cases
            session.execute(
                delete(AnnotationCase).where(AnnotationCase.assignment_id.in_(assignment_ids))
            )
            # Delete assignments
            session.execute(
                delete(AnnotationAssignment).where(AnnotationAssignment.id.in_(assignment_ids))
            )

        # Delete the project itself
        seed_dir = project.seed_dir
        session.delete(project)

    # Clean up files on disk
    try:
        root = os.path.join(viewer_cache_root(), "edits", "assignments", project_id)
        if os.path.exists(root):
            shutil.rmtree(root, ignore_errors=True)
        if seed_dir and os.path.exists(seed_dir):
            shutil.rmtree(seed_dir, ignore_errors=True)
    except Exception:
        pass

    return jsonify({"deleted": True, "id": project_id}), 200


@assignment_blueprint.get("/projects/<project_id>/storage")
def project_storage(project_id):
    """Measure project-owned annotation files without traversing symlinks."""
    import stat
    from services.annotation_storage import draft_path, seed_path
    from services.shared_annotations import viewer_cache_root

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Project not found"}), 404
        drafts = session.execute(select(AnnotationCase.assignment_id, AnnotationCase.id, AnnotationCase.draft_revision)
            .join(AnnotationAssignment, AnnotationCase.assignment_id == AnnotationAssignment.id)
            .where(AnnotationAssignment.project_id == project_id, AnnotationCase.draft_revision.is_not(None))).all()
        submissions = session.execute(select(AnnotationSubmission.mask_low_path, AnnotationSubmission.mask_full_path)
            .join(AnnotationAssignment, AnnotationSubmission.assignment_id == AnnotationAssignment.id)
            .where(AnnotationAssignment.project_id == project_id)).all()
        seed_dir = project.seed_dir
        seed_cases = (session.execute(select(AnnotationCase.case_key)
            .join(AnnotationAssignment, AnnotationCase.assignment_id == AnnotationAssignment.id)
            .where(AnnotationAssignment.project_id == project_id, AnnotationCase.status != "unavailable"))
            .scalars().all() if project.baseline_mode == "seed" else [])
        has_stored_data = bool(seed_dir or seed_cases or drafts or submissions)
    try:
        if str(uuid.UUID(project_id)) != project_id:
            raise ValueError()
    except ValueError:
        return jsonify({"error": "Project not found"}), 404
    root = os.path.join(viewer_cache_root(), "edits", "assignments", project_id)
    total, files = 0, 0
    noncurrent_drafts = {"files": 0, "bytes": 0}
    unreferenced_submissions = {"files": 0, "bytes": 0}
    if os.path.islink(root):
        return jsonify({"error": "Project storage is unavailable"}), 503
    try:
        try:
            root_info = os.stat(root)
        except FileNotFoundError:
            # A newly created project has no annotation files yet.
            if has_stored_data:
                return jsonify({"error": "Project storage is missing; its saved annotations cannot be measured"}), 503
            return jsonify({"project_id": project_id, "bytes": 0, "files": 0,
                            "noncurrent_drafts": noncurrent_drafts, "unreferenced_submissions": unreferenced_submissions})
        if not stat.S_ISDIR(root_info.st_mode):
            return jsonify({"error": "Project storage is not a directory"}), 503
        root_real = os.path.realpath(root)
        required_files = [draft_path(project_id, assignment_id, case_id, revision)
                          for assignment_id, case_id, revision in drafts]
        required_files.extend(path for low, full in submissions for path in (low, full))
        required_files.extend(seed_path(project_id, case_key) for case_key in seed_cases)
        def within_project(path):
            return os.path.commonpath([root_real, os.path.realpath(path)]) == root_real
        def safe_path(path):
            if not path or not within_project(path):
                return False
            relative = os.path.relpath(path, root)
            current = root
            for part in relative.split(os.sep):
                current = os.path.join(current, part)
                if os.path.islink(current):
                    return False
            return True
        if ((seed_dir and (not safe_path(seed_dir) or not os.path.isdir(seed_dir))) or
                any(not safe_path(path) or not os.path.isfile(path) for path in required_files)):
            return jsonify({"error": "One or more saved annotation files are unavailable; storage cannot be verified"}), 503
        referenced = {os.path.normcase(os.path.realpath(path)) for path in required_files}
        def failed(error):
            raise error
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=failed):
            dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(directory, name))]
            for name in names:
                path = os.path.join(directory, name)
                if not os.path.islink(path) and os.path.isfile(path):
                    size = os.path.getsize(path)
                    total += size
                    files += 1
                    parts = os.path.relpath(path, root).split(os.sep)
                    if os.path.normcase(os.path.realpath(path)) not in referenced:
                        bucket = None
                        if len(parts) == 4 and parts[2] == "drafts" and name.endswith(".nii.gz"):
                            bucket = noncurrent_drafts
                        elif len(parts) == 5 and parts[2] == "submissions" and name == "combined_labels.nii.gz":
                            bucket = unreferenced_submissions
                        if bucket is not None:
                            bucket["files"] += 1
                            bucket["bytes"] += size
    except (OSError, ValueError):
        return jsonify({"error": "Could not measure project storage"}), 503
    return jsonify({"project_id": project_id, "bytes": total, "files": files,
                    "noncurrent_drafts": noncurrent_drafts, "unreferenced_submissions": unreferenced_submissions})


@assignment_blueprint.get("/projects/<project_id>/progress")
def project_progress(project_id):
    """Project-scoped progress with case states for an authorized reviewer."""
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Project not found"}), 404
        assignments = session.execute(select(AnnotationAssignment).where(
            AnnotationAssignment.project_id == project_id).order_by(AnnotationAssignment.created_at)).scalars().all()
        result = []
        for assignment in assignments:
            cases = session.execute(select(AnnotationCase).where(AnnotationCase.assignment_id == assignment.id)
                                    .order_by(AnnotationCase.case_key)).scalars().all()
            statuses = [case.status for case in cases]
            result.append({"assignment_id": assignment.id, "assignee_id": assignment.assignee_id,
                           "counts": {status: statuses.count(status) for status in set(statuses)},
                           "cases": [{"case_key": case.case_key, "status": case.status} for case in cases]})
    return jsonify({"project_id": project_id, "assignments": result})


@assignment_blueprint.get("/projects/<project_id>/export.csv")
def export_project(project_id):
    import csv
    import io
    from flask import Response

    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if not _can_review(project, user, current_roles()):
            return jsonify({"error": "Project not found"}), 404
        rows = session.execute(select(AnnotationAssignment, AnnotationCase)
            .join(AnnotationCase, AnnotationCase.assignment_id == AnnotationAssignment.id)
            .where(AnnotationAssignment.project_id == project.id)
            .order_by(AnnotationAssignment.id, AnnotationCase.case_key)).all()
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["assignment_id", "assignee_id", "case_key", "status", "draft_revision",
                         "assignee_name", "structures", "due_at", "assignment_note"])
        def csv_text(value):
            value = str(value or "")
            # Spreadsheet programs may interpret untrusted names or notes as formulas.
            return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value
        for assignment, case in rows:
            assignee = session.get(User, assignment.assignee_id) if assignment.assignee_id else None
            targets = assignment.target_labels or project.target_labels
            due = assignment.due_at or project.due_at
            writer.writerow([assignment.id, assignment.assignee_id or "", case.case_key, case.status, case.draft_revision or "",
                             csv_text((assignee.name or assignee.email) if assignee else ""),
                             csv_text(", ".join(project.target_names.get(str(label), f"Structure {label}") for label in targets)),
                             due.isoformat() + "Z" if due else "", csv_text(assignment.note)])
    return Response(output.getvalue(), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=annotation-progress.csv", "Cache-Control": "private, no-store"})
