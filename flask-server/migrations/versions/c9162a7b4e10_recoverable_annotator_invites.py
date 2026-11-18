"""Allow creators to retrieve open annotator invite codes.

Revision ID: c9162a7b4e10
Revises: 8180f9e6bd3b
Create Date: 2026-11-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c9162a7b4e10"
down_revision: Union[str, None] = "8180f9e6bd3b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("annotator_invite", sa.Column("code_ciphertext", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("annotator_invite", "code_ciphertext")
