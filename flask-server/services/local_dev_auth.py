"""Opt-in automatic identity for loopback development with a local database."""
import os
from urllib.parse import urlsplit

from flask import request
from sqlalchemy import select

from models.engine import session_scope
from models.job import utcnow
from models.user import User

LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001"
LOCAL_EMAIL = "developer@bodymaps.local"


def local_development_user():
    from constants import Constants
    if os.environ.get("BODYMAPS_LOCAL_AUTO_SIGNIN", "false").lower() != "true":
        return None
    if os.environ.get("TRUST_PROXY", "false").lower() == "true":
        return None
    if not Constants.DATABASE_URL.startswith("sqlite:///"):
        return None
    loopback = {"localhost", "127.0.0.1", "::1"}
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return None
    if urlsplit(request.host_url).hostname not in loopback:
        return None
    if request.headers.get("Origin") and urlsplit(request.headers["Origin"]).hostname not in loopback:
        return None
    with session_scope() as session:
        user = session.get(User, LOCAL_USER_ID)
        if user is None:
            if session.execute(select(User).where(User.email == LOCAL_EMAIL)).scalar_one_or_none():
                return None
            user = User(id=LOCAL_USER_ID, email=LOCAL_EMAIL, name="Local Developer",
                        password_hash=None, email_verified_at=utcnow(), plan="enterprise",
                        account_type="researcher")
            session.add(user)
            session.flush()
        return user.to_public_dict()
