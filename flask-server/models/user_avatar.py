"""One normalized profile picture per account, included in database backups."""

from sqlalchemy import ForeignKey, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db


class UserAvatar(db.Model):
    __tablename__ = "user_avatar"

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"), primary_key=True
    )
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    # Load the small version without loading the image on every /auth/me call.
    png: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
