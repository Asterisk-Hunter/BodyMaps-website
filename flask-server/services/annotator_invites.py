"""Temporary, single-use codes that let a person join annotation work.

Any annotator can issue a code; the recipient redeems it from their own account.
The code works once and expires. Redeeming never grants admin or manager access.
Open codes are encrypted at rest so their creator can retrieve them until they
are redeemed, expired, or withdrawn; lookups still use the one-way digest.
"""

import hashlib
import secrets
import uuid
import base64
from datetime import datetime, timedelta

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app
from sqlalchemy import select, update

from models.annotator_invite import AnnotatorInvite
from models.engine import session_scope
from models.job import utcnow
from models.user import User
from models.user_role import UserRole
from services import role_store

# No 0/O, 1/I/L: the code is read aloud and typed by hand.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_LENGTH = 12
MAX_HOURS = 24 * 14
# A "permanent" code never expires. It is still single-use and can still be withdrawn. The column is NOT NULL,
# so a date no real clock reaches stands in for "never".
PERMANENT_EXPIRY = datetime(9999, 12, 31, 23, 59, 59)

GRANTED = "granted"
ALREADY = "already"


def normalize(code: str) -> str:
    """Case, spaces and dashes do not matter when typing a code."""
    return "".join(ch for ch in str(code).upper() if ch.isalnum())


def digest(code: str) -> str:
    return hashlib.sha256(normalize(code).encode("utf-8")).hexdigest()


def _display(raw: str) -> str:
    return "-".join(raw[i:i + 4] for i in range(0, len(raw), 4))


def is_permanent(expires_at: datetime) -> bool:
    return expires_at.year >= PERMANENT_EXPIRY.year


def _fernet() -> Fernet:
    secret = current_app.config.get("SECRET_KEY")
    if isinstance(secret, str):
        secret = secret.encode("utf-8")
    if not isinstance(secret, bytes) or not secret:
        raise RuntimeError("A configured SECRET_KEY is required to protect invitation codes.")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret).digest())
    return Fernet(key)


def create(created_by: str, hours, permanent: bool = False, project_id: str | None = None,
           invited_email: str | None = None) -> dict:
    """A new code that works for ``hours``, or never expires."""
    if not permanent and (not isinstance(hours, int) or isinstance(hours, bool) or not 1 <= hours <= MAX_HOURS):
        raise ValueError(f"hours must be a whole number from 1 to {MAX_HOURS}")
    if invited_email is not None:
        if not isinstance(invited_email, str) or not invited_email.strip() or len(invited_email.strip()) > 254:
            raise ValueError("invited_email must be a valid email address")
        invited_email = invited_email.strip().casefold()
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LENGTH))
    expires_at = PERMANENT_EXPIRY if permanent else utcnow() + timedelta(hours=hours)
    invite_id = str(uuid.uuid4())
    ciphertext = _fernet().encrypt(_display(raw).encode("ascii")).decode("ascii")
    with session_scope() as s:
        s.add(AnnotatorInvite(id=invite_id, code_hash=digest(raw), code_ciphertext=ciphertext,
                              created_by=created_by, project_id=project_id, invited_email=invited_email,
                              expires_at=expires_at))
    return {"id": invite_id, "code": _display(raw), "expires_at": expires_at, "permanent": permanent}


def redeem(user_id: str, code: str) -> str | None:
    """Record a valid code's redemption and grant ``annotator`` if needed.

    Returns ``GRANTED`` when access was added, ``ALREADY`` when the account
    already had access (the code is still consumed and the redeemer recorded),
    or None when the code is unknown, used or expired.
    """
    now = utcnow()
    code_hash = digest(code)
    with session_scope() as s:
        user = s.get(User, user_id)
        if user is None or user.is_system:
            raise LookupError(user_id)
        invite = s.execute(
            select(AnnotatorInvite).where(
                AnnotatorInvite.code_hash == code_hash,
                AnnotatorInvite.redeemed_at.is_(None),
                AnnotatorInvite.expires_at > now,
            )
        ).scalar_one_or_none()
        if invite is None:
            return None
        if invite.invited_email and (user.email or "").strip().casefold() != invite.invited_email:
            # Do not consume the invite when the wrong account follows a copied link.
            return None
        held = set(s.execute(select(UserRole.role).where(UserRole.user_id == user_id)).scalars())
        # The WHERE clause is what makes it single-use when two people redeem at the same moment.
        claimed = s.execute(
            update(AnnotatorInvite)
            .where(AnnotatorInvite.id == invite.id, AnnotatorInvite.redeemed_at.is_(None))
            .values(redeemed_by=user_id, redeemed_at=now, code_ciphertext=None)
        )
        if claimed.rowcount != 1:
            return None
        if role_store.ROLE_ANNOTATOR in held:
            return ALREADY
        s.add(UserRole(
            id=str(uuid.uuid4()), user_id=user_id, role=role_store.ROLE_ANNOTATOR,
            granted_by=invite.created_by, granted_at=now,
        ))
    return GRANTED


def _as_utc_text(value: datetime | None) -> str | None:
    """None for no date, and for a permanent code's "never"."""
    return value.isoformat() + "Z" if value is not None and not is_permanent(value) else None


def recent(limit: int = 50, created_by: str | None = None, project_id: str | None = None) -> list[dict]:
    """Newest first, optionally limited to the account that created each code."""
    now = utcnow()
    with session_scope() as s:
        query = select(AnnotatorInvite).order_by(AnnotatorInvite.created_at.desc())
        if created_by is not None:
            query = query.where(AnnotatorInvite.created_by == created_by)
        if project_id is not None:
            query = query.where(AnnotatorInvite.project_id == project_id)
        rows = s.execute(query.limit(limit)).scalars().all()
        redeemer_ids = {row.redeemed_by for row in rows if row.redeemed_by}
        emails = {
            user.id: user.email
            for user in s.execute(select(User).where(User.id.in_(redeemer_ids))).scalars()
        } if redeemer_ids else {}
        result = []
        for row in rows:
            status = "redeemed" if row.redeemed_at else ("expired" if row.expires_at <= now else "open")
            code = None
            if status == "open" and row.code_ciphertext:
                try:
                    code = _fernet().decrypt(row.code_ciphertext.encode("ascii")).decode("ascii")
                except (InvalidToken, ValueError):
                    code = None
            result.append({
            "id": row.id,
            "project_id": row.project_id,
            "invited_email": row.invited_email,
            "status": status,
            "created_at": _as_utc_text(row.created_at),
            "expires_at": _as_utc_text(row.expires_at),
            "permanent": is_permanent(row.expires_at),
            "redeemed_at": _as_utc_text(row.redeemed_at),
            "redeemed_by": emails.get(row.redeemed_by) if row.redeemed_by else None,
            "code": code,
            })
        return result


def revoke(invite_id: str, created_by: str | None = None) -> bool:
    """Withdraw an unused code, optionally requiring its creator to match."""
    with session_scope() as s:
        query = update(AnnotatorInvite).where(AnnotatorInvite.id == invite_id, AnnotatorInvite.redeemed_at.is_(None))
        if created_by is not None:
            query = query.where(AnnotatorInvite.created_by == created_by)
        result = s.execute(query.values(expires_at=utcnow(), code_ciphertext=None))
        return result.rowcount == 1
