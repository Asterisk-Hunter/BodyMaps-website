"""Scope annotator invitations to projects.

Revision ID: a42f01c6d9e3
Revises: c9162a7b4e10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a42f01c6d9e3"
down_revision: Union[str, None] = "c9162a7b4e10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    has_column = any(column["name"] == "project_id" for column in inspector.get_columns("annotator_invite"))
    has_index = any(index["name"] == "ix_annotator_invite_project_id" for index in inspector.get_indexes("annotator_invite"))
    if has_index:
        op.drop_index("ix_annotator_invite_project_id", table_name="annotator_invite")
    with op.batch_alter_table("annotator_invite", recreate="always") as batch:
        if not has_column:
            batch.add_column(sa.Column("project_id", sa.String(length=36), nullable=True))
        batch.create_foreign_key("fk_annotator_invite_project_id", "annotation_project", ["project_id"], ["id"], ondelete="CASCADE")
        batch.create_index("ix_annotator_invite_project_id", ["project_id"])


def downgrade() -> None:
    with op.batch_alter_table("annotator_invite", recreate="always") as batch:
        batch.drop_index("ix_annotator_invite_project_id")
        batch.drop_constraint("fk_annotator_invite_project_id", type_="foreignkey")
        batch.drop_column("project_id")
