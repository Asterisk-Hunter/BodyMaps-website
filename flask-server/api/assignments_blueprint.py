"""Annotation assignments: hand ranges of cases to annotators and follow their progress.

Routes (registered under <BASE_PATH>/api):
  GET    /assignments/mine                       -> the caller's own assignments, with the mark on each case
  PUT    /assignments/<id>/cases/<number>        {status: done|flagged|todo} -> mark one case (assignee or manager)
  GET    /assignments                            -> every assignment with progress          (annotation manager)
  POST   /assignments                            {assignee_id, start, end, task, note?, due?, force?}  (annotation manager)
  PATCH  /assignments/<id>                       {assignee_id?, task?, note?, due?}         (annotation manager)
  DELETE /assignments/<id>                                                                 (annotation manager)
  GET    /assignments/people                     -> accounts that can be given cases        (annotation manager)

Managing who edits what is the annotation manager's job (the same role that hands out ``annotator``), so every
route that changes or lists other people's work needs it. An annotator only ever sees and marks their own.
"""

from flask import Blueprint, jsonify, request

from api.auth import current_roles, current_user, require_auth, require_role
from services import assignment_store, role_store

assignments_blueprint = Blueprint("assignments", __name__)

_REFUSAL_STATUS = {"overlap": 409}

# What the caller is told for each refusal. Fixed text keyed by the reason: nothing from the exception itself is
# echoed back, so no internal detail can leak through an error response.
_REFUSAL_MESSAGES = {
    "bad_range": "Cases must be whole numbers from 1 up, the first before the last, with no more than 50,000 in one assignment.",
    "bad_task": "Say what should be annotated, as text of up to 120 characters.",
    "bad_note": "The note must be text of up to 2000 characters.",
    "bad_due": "The due date must look like 2026-12-31.",
    "no_such_person": "That account was not found.",
    "not_an_annotator": "Only an annotator can be given cases. Make them an annotator first.",
    "overlap": "Part of this range is already assigned for the same task.",
    "bad_status": "The status must be done, flagged or todo.",
    "bad_case": "The case must be a number.",
    "outside_range": "That case is not part of this assignment.",
}


def _body() -> dict:
    raw = request.get_json(silent=True)
    return raw if isinstance(raw, dict) else {}


def _overlaps(details: dict) -> list[dict]:
    """The overlap list for the response, rebuilt field by field so only the expected values are sent."""
    out = []
    for o in details.get("overlaps", []):
        out.append({
            "id": str(o["id"]), "assignee": str(o["assignee"]),
            "start": int(o["start"]), "end": int(o["end"]),
            "shared_start": int(o["shared_start"]), "shared_end": int(o["shared_end"]),
        })
    return out


def _refusal(e: assignment_store.AssignmentError):
    reason = e.reason if e.reason in _REFUSAL_MESSAGES else "bad_range"
    payload = {"error": _REFUSAL_MESSAGES[reason], "reason": reason}
    if reason == "overlap":
        payload["overlaps"] = _overlaps(e.details)
    return jsonify(payload), _REFUSAL_STATUS.get(reason, 400)


@assignments_blueprint.route("/assignments/mine", methods=["GET"])
@require_auth
def my_assignments():
    return jsonify({"assignments": assignment_store.list_for(current_user()["id"])}), 200


@assignments_blueprint.route("/assignments/<assignment_id>/cases/<int:case_number>", methods=["PUT"])
@require_auth
def mark_case(assignment_id: str, case_number: int):
    try:
        result = assignment_store.set_case_status(
            assignment_id, case_number, _body().get("status"),
            acting_user_id=current_user()["id"],
            is_manager=role_store.ROLE_ANNOTATION_MANAGER in current_roles(),
        )
    except assignment_store.AssignmentError as e:
        return _refusal(e)
    except (LookupError, PermissionError):
        # The same answer for "no such assignment" and "not yours": an id that is not theirs is not theirs to probe.
        return jsonify({"error": "No such assignment"}), 404
    return jsonify(result), 200


@assignments_blueprint.route("/assignments", methods=["GET"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def list_assignments():
    return jsonify({"assignments": assignment_store.list_all()}), 200


@assignments_blueprint.route("/assignments/people", methods=["GET"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def assignable_people():
    return jsonify({"people": assignment_store.assignable_people()}), 200


@assignments_blueprint.route("/assignments", methods=["POST"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def create_assignment():
    body = _body()
    force = body.get("force", False)
    if not isinstance(force, bool):
        return jsonify({"error": "force must be true or false"}), 400
    try:
        created = assignment_store.create(
            assignee_id=body.get("assignee_id"), start=body.get("start"), end=body.get("end"),
            task=body.get("task"), note=body.get("note"), due=body.get("due"),
            created_by=current_user()["id"], force=force,
        )
    except assignment_store.AssignmentError as e:
        return _refusal(e)
    return jsonify(created), 201


@assignments_blueprint.route("/assignments/<assignment_id>", methods=["PATCH"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def update_assignment(assignment_id: str):
    body = _body()
    changes = {k: body[k] for k in ("assignee_id", "task", "note", "due") if k in body}
    try:
        return jsonify(assignment_store.update(assignment_id, changes)), 200
    except assignment_store.AssignmentError as e:
        return _refusal(e)
    except LookupError:
        return jsonify({"error": "No such assignment"}), 404


@assignments_blueprint.route("/assignments/<assignment_id>", methods=["DELETE"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def delete_assignment(assignment_id: str):
    if not assignment_store.delete_assignment(assignment_id):
        return jsonify({"error": "No such assignment"}), 404
    return jsonify({"deleted": True}), 200
