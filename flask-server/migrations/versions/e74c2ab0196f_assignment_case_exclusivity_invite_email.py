"""Enforce active case exclusivity and bind roster invitations to email.

Revision ID: e74c2ab0196f
Revises: a42f01c6d9e3
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e74c2ab0196f"
down_revision: Union[str, None] = "a42f01c6d9e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ACTIVE_CASE_PREDICATE = "status NOT IN ('published', 'unavailable', 'released')"


def upgrade() -> None:
    bind = op.get_bind()
    duplicates = bind.execute(sa.text(
        "SELECT case_key, COUNT(*) AS n FROM annotation_case "
        f"WHERE {ACTIVE_CASE_PREDICATE} GROUP BY case_key HAVING COUNT(*) > 1 "
        "ORDER BY case_key"
    )).fetchall()
    if duplicates:
        cases = ", ".join(f"{row.case_key} ({row.n} active rows)" for row in duplicates[:20])
        raise RuntimeError(
            "Cannot enforce one active annotator per CT until existing duplicate active assignments are resolved: "
            + cases
        )

    op.add_column("annotator_invite", sa.Column("invited_email", sa.String(length=254), nullable=True))
    op.create_index("ix_annotator_invite_invited_email", "annotator_invite", ["invited_email"], unique=False)
    op.create_index(
        "uq_annotation_case_active_case_key", "annotation_case", ["case_key"], unique=True,
        sqlite_where=sa.text(ACTIVE_CASE_PREDICATE),
        postgresql_where=sa.text(ACTIVE_CASE_PREDICATE),
    )


def downgrade() -> None:
    op.drop_index("uq_annotation_case_active_case_key", table_name="annotation_case")
    op.drop_index("ix_annotator_invite_invited_email", table_name="annotator_invite")
    op.drop_column("annotator_invite", "invited_email")
