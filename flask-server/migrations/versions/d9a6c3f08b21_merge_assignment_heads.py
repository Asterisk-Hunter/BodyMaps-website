"""merge project and range assignment revisions

Revision ID: d9a6c3f08b21
Revises: b8e41d6a2f93, e74c2ab0196f
Create Date: 2026-11-19
"""
from typing import Sequence, Union


revision: str = "d9a6c3f08b21"
down_revision: Union[str, Sequence[str], None] = ("b8e41d6a2f93", "e74c2ab0196f")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Both feature branches are additive; this revision only joins their histories.
    pass


def downgrade() -> None:
    # The merge point has no schema of its own.
    pass
