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

Who may change what every visitor sees is narrower than admin: the three annotator-invite routes, and granting or
removing ``annotator``, need ``annotation_manager``. ``annotation_manager`` itself cannot be granted or removed
here at all (``scripts/grant_role.py`` on the server), so an admin cannot hand the power to themselves or anyone.
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

from flask import Blueprint, jsonify, request

from api.auth import current_roles, current_user, require_role
from services import annotator_invites, auth_store, model_health, role_store
from services.public_errors import known_message

# What a refused role change may say, and why. The wording is fixed here so a response never repeats an error's text.
_ROLE_REFUSALS = {
    role_store.SELF_DEMOTE_MESSAGE: role_store.SELF_DEMOTE,
    role_store.LAST_ADMIN_MESSAGE: role_store.LAST_ADMIN,
    role_store.SELF_DELETE_MESSAGE: role_store.SELF_DELETE,
}


def _role_refusal(error):
    """409: the request is well-formed and the caller is allowed to make it; the state of the world refuses it."""
    message = known_message(error, tuple(_ROLE_REFUSALS), "That change isn't allowed.")
    return jsonify({"error": message, "reason": _ROLE_REFUSALS.get(message, "refused")}), 409

admin_blueprint = Blueprint("admin", __name__)


def _is_annotation_manager() -> bool:
    return role_store.ROLE_ANNOTATION_MANAGER in current_roles()


def _grantable_roles() -> list[str]:
    """The roles this caller can hand out or withdraw from the Accounts tab."""
    roles = [role_store.ROLE_ADMIN]
    if _is_annotation_manager():
        roles.append(role_store.ROLE_ANNOTATOR)
    return sorted(roles)


def _refuse_role_change(role: str):
    """None when the caller may grant or withdraw ``role``, else the response to return."""
    if role == role_store.ROLE_ANNOTATION_MANAGER:
        return jsonify({"error": "This role can only be changed on the server."}), 403
    if role == role_store.ROLE_ANNOTATOR and not _is_annotation_manager():
        return jsonify({"error": "Only an annotation manager can change who may edit scans."}), 403
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
    refused = _refuse_role_change(role)
    if refused:
        return refused
    try:
        roles = role_store.revoke(user_id, role, acting_user_id=current_user()["id"])
    except role_store.RoleError as e:
        # 409: the request is well-formed and the caller is allowed to make it —
        # the state of the world is what refuses it.
        return _role_refusal(e)
    except ValueError:
        return jsonify({"error": "Unknown role"}), 400
    return jsonify({"user_id": user_id, "roles": roles}), 200


@admin_blueprint.route("/admin/annotator-invites", methods=["POST"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def create_annotator_invite():
    raw_body = request.get_json(silent=True)
    body = raw_body if isinstance(raw_body, dict) else {}
    permanent = body.get("permanent", False)
    if not isinstance(permanent, bool):
        return jsonify({"error": "permanent must be true or false"}), 400
    try:
        invite = annotator_invites.create(current_user()["id"], body.get("hours", 24), permanent=permanent)
    except ValueError:
        # A fixed message: nothing from the exception goes back to the caller.
        return jsonify({"error": f"hours must be a whole number from 1 to {annotator_invites.MAX_HOURS}"}), 400
    # The only time the code is ever shown: the database keeps just its digest.
    expires_at = None if invite["permanent"] else invite["expires_at"].isoformat() + "Z"
    return jsonify({"id": invite["id"], "code": invite["code"], "expires_at": expires_at, "permanent": invite["permanent"]}), 201


@admin_blueprint.route("/admin/annotator-invites", methods=["GET"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def list_annotator_invites():
    return jsonify({"invites": annotator_invites.recent()}), 200


@admin_blueprint.route("/admin/annotator-invites/<invite_id>", methods=["DELETE"])
@require_role(role_store.ROLE_ANNOTATION_MANAGER)
def revoke_annotator_invite(invite_id: str):
    if not annotator_invites.revoke(invite_id):
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
        return _role_refusal(e)

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
