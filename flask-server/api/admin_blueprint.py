"""Admin: the account list, granting/revoking roles, and closing an account.

Routes (registered under <BASE_PATH>/api), all admin-only:
  GET    /admin/people?q=&limit=&offset=   -> accounts + their roles
  POST   /admin/people/<user_id>/roles     {role} -> grant
  DELETE /admin/people/<user_id>/roles/<role>     -> revoke
  DELETE /admin/people/<user_id>                  -> schedule for deletion
  POST   /admin/people/<user_id>/restore          -> undo a scheduled deletion
  POST   /admin/annotator-invites {hours|permanent} -> a single-use code, temporary or permanent that makes its redeemer an annotator
  GET    /admin/annotator-invites                 -> recent codes: open, redeemed (by whom) or expired
  DELETE /admin/annotator-invites/<id>            -> withdraw a code nobody has used yet

Project permissions belong to the project creator. Any signed-in account may create team invitation codes;
each account can list or withdraw only its own unused codes. The legacy ``annotation_manager`` role is not a
project-wide access bypass and cannot be granted through this API.
  GET    /admin/models/health                     -> per-model run health (Diagnostics page)

Deliberately NOT behind ANALYTICS_DASHBOARD. That flag exists because the usage
endpoints report on how every account behaves and it should take a deliberate
act to serve that anywhere; role management is ordinary account administration
and has to work on a normal deploy, or the flag becomes the thing standing
between an admin and granting someone access.

These endpoints do expose every account's email to an admin. That is the point
of the page — an admin has to be able to find the person they're granting a role
to — but it is why the only way in is require_role("admin").
"""

import re

from flask import Blueprint, jsonify, request

from api.auth import current_user, require_role
from models.annotation_project import AnnotationProject
from models.engine import session_scope
from services import annotator_invites, auth_store, model_health, role_store

admin_blueprint = Blueprint("admin", __name__)


def _grantable_roles() -> list[str]:
    """The site admin can grant annotator access; project controls stay owner-scoped."""
    return sorted([role_store.ROLE_ADMIN, role_store.ROLE_ANNOTATOR])


def _refuse_role_change(role: str):
    """None when the caller may grant or withdraw ``role``, else the response to return."""
    if role == role_store.ROLE_ANNOTATION_MANAGER:
        return jsonify({"error": "This role can only be changed on the server."}), 403
    return None


@admin_blueprint.route("/admin/people", methods=["GET"])
@require_role(role_store.ROLE_ADMIN)
def people():
    """Accounts, newest first, optionally filtered by ?q= against email/name."""
    try:
        limit = int(request.args.get("limit") or 25)
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        return jsonify({"error": "limit and offset must be numbers"}), 400

    result = role_store.search_people(
        query=request.args.get("q") or None, limit=limit, offset=offset,
    )
    # So the UI can render the toggles from the server's vocabulary rather than
    # keeping a second copy of the role list.
    result["roles"] = _grantable_roles()
    return jsonify(result), 200


@admin_blueprint.route("/admin/people/<user_id>/roles", methods=["POST"])
@require_role(role_store.ROLE_ADMIN)
def grant_role(user_id: str):
    raw_body = request.get_json(silent=True)
    body = raw_body if isinstance(raw_body, dict) else {}
    role = body.get("role") or ""
    refused = _refuse_role_change(role)
    if refused:
        return refused
    try:
        roles = role_store.grant(user_id, role, granted_by=current_user()["id"])
    except LookupError:
        return jsonify({"error": "Account not found"}), 404
    except ValueError:
        return jsonify({"error": "Unknown role"}), 400
    return jsonify({"user_id": user_id, "roles": roles}), 200


@admin_blueprint.route("/admin/people/<user_id>/roles/<role>", methods=["DELETE"])
@require_role(role_store.ROLE_ADMIN)
def revoke_role(user_id: str, role: str):
    try:
        roles = role_store.revoke(user_id, role, acting_user_id=current_user()["id"])
    except role_store.RoleError as e:
        # 409: the request is well-formed and the caller is allowed to make it —
        # the state of the world is what refuses it.
        return jsonify({"error": str(e), "reason": e.reason}), 409
    except ValueError:
        return jsonify({"error": "Unknown role"}), 400
    return jsonify({"user_id": user_id, "roles": roles}), 200


@admin_blueprint.route("/admin/annotator-invites", methods=["POST"])
def create_annotator_invite():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    raw_body = request.get_json(silent=True)
    body = raw_body if isinstance(raw_body, dict) else {}
    permanent = body.get("permanent", False)
    if not isinstance(permanent, bool):
        return jsonify({"error": "permanent must be true or false"}), 400
    project_id = body.get("project_id")
    if not isinstance(project_id, str) or not project_id:
        return jsonify({"error": "A project is required for this invitation."}), 400
    invited_email = body.get("email")
    if invited_email is not None and (not isinstance(invited_email, str) or
            not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", invited_email.strip()) or len(invited_email.strip()) > 254):
        return jsonify({"error": "Enter a valid email address for this invitation."}), 400
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None or project.created_by != user["id"] or project.status != "open":
            return jsonify({"error": "Project not found."}), 404
    try:
        invite = annotator_invites.create(user["id"], body.get("hours", 24), permanent=permanent,
                                          project_id=project_id, invited_email=invited_email)
    except ValueError:
        # A fixed message: nothing from the exception goes back to the caller.
        return jsonify({"error": f"hours must be a whole number from 1 to {annotator_invites.MAX_HOURS}"}), 400
    # The one-time response shows the code immediately; while open, the creator can
    # retrieve it again from the authenticated recent-codes list.
    expires_at = None if invite["permanent"] else invite["expires_at"].isoformat() + "Z"
    return jsonify({"id": invite["id"], "code": invite["code"], "expires_at": expires_at, "permanent": invite["permanent"]}), 201


@admin_blueprint.route("/admin/annotator-invites", methods=["GET"])
def list_annotator_invites():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    project_id = request.args.get("project_id")
    if not project_id:
        return jsonify({"error": "A project is required."}), 400
    with session_scope() as session:
        project = session.get(AnnotationProject, project_id)
        if project is None or project.created_by != user["id"]:
            return jsonify({"error": "Project not found."}), 404
    return jsonify({"invites": annotator_invites.recent(created_by=user["id"], project_id=project_id)}), 200


@admin_blueprint.route("/admin/annotator-invites/<invite_id>", methods=["DELETE"])
def revoke_annotator_invite(invite_id: str):
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    if not annotator_invites.revoke(invite_id, created_by=user["id"]):
        return jsonify({"error": "No unused code with that id"}), 404
    return jsonify({"revoked": True}), 200


@admin_blueprint.route("/admin/people/<user_id>", methods=["DELETE"])
@require_role(role_store.ROLE_ADMIN)
def delete_account(user_id: str):
    """Close someone's account.

    The same reversible path the account owner gets from their own privacy
    settings: unusable and signed out everywhere immediately, but the row and
    the data survive DELETION_GRACE_DAYS. An admin acting on a report, or
    cleaning up a duplicate, is exactly the case where being able to change
    your mind matters — and unlike the owner, they can't sign back in to undo
    it, which is why /restore below exists.
    """
    try:
        role_store.guard_deletion(user_id, acting_user_id=current_user()["id"])
    except role_store.RoleError as e:
        # 409, same as a refused revoke: well-formed request, allowed caller,
        # and the state of the world is what refuses it.
        return jsonify({"error": str(e), "reason": e.reason}), 409

    result = auth_store.request_deletion(user_id)
    if result is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user_id": user_id, **result}), 200


@admin_blueprint.route("/admin/people/<user_id>/restore", methods=["POST"])
@require_role(role_store.ROLE_ADMIN)
def restore_account(user_id: str):
    """Undo a scheduled deletion, while the grace window is still open."""
    user = auth_store.cancel_deletion(user_id)
    if user is None:
        return jsonify({
            "error": "That account is gone, or its 30-day window has already closed."
        }), 404
    return jsonify({"user_id": user_id, "deletion_requested_at": None}), 200


@admin_blueprint.route("/admin/models/health", methods=["GET"])
@require_role(role_store.ROLE_ADMIN)
def models_health():
    """How each model's recent runs ended, newest decides (services/model_health.py)."""
    resp = jsonify({"window_days": model_health.WINDOW_DAYS, "models": model_health.model_health()})
    resp.headers["Cache-Control"] = "no-store"
    return resp, 200
