"""Temporary, single-use invitation codes that grant the ``annotator`` role.

An admin creates one, hands the code to a person, and the person redeems it from their account. A SHA-256
digest validates the code; an encrypted copy is retained only while it remains open so its creator can
retrieve it. The encrypted copy is cleared on redemption or withdrawal.

``created_by`` and ``redeemed_by`` are SET NULL: deleting an account must not erase the record of who was
let in, or who let them in.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class AnnotatorInvite(db.Model):
    __tablename__ = "annotator_invite"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    code_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="SET NULL"), nullable=True,
    )
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("annotation_project.id", ondelete="CASCADE"), nullable=True, index=True)
    invited_email: Mapped[str | None] = mapped_column(String(254), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    redeemed_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="SET NULL"), nullable=True,
    )
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def __repr__(self) -> str:
        return f"<AnnotatorInvite {self.id} expires={self.expires_at}>"
