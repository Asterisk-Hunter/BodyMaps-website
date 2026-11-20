"""annotation assignments

``annotation_assignment`` - one row per range of library case numbers handed to an annotator for one task.
``annotation_assignment_case`` - the cases of an assignment the annotator has finished or flagged (no row = to do).

Purely additive and reversible: both tables come up empty and nothing existing is touched.

Revision ID: b8e41d6a2f93
Revises: a9d3e5f17b2c
Create Date: 2026-11-14 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8e41d6a2f93'
down_revision: Union[str, None] = 'a9d3e5f17b2c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'annotation_assignment',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('assignee_id', sa.String(length=36), nullable=False),
        sa.Column('range_start', sa.Integer(), nullable=False),
        sa.Column('range_end', sa.Integer(), nullable=False),
        sa.Column('task', sa.String(length=120), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('due_at', sa.DateTime(), nullable=True),
        sa.Column('created_by', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['assignee_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['user_account.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('annotation_assignment', schema=None) as batch_op:
        batch_op.create_index('ix_annotation_assignment_assignee_id', ['assignee_id'], unique=False)
    op.create_table(
        'annotation_assignment_case',
        sa.Column('assignment_id', sa.String(length=36), nullable=False),
        sa.Column('case_number', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['assignment_id'], ['annotation_assignment.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('assignment_id', 'case_number'),
    )


def downgrade() -> None:
    op.drop_table('annotation_assignment_case')
    with op.batch_alter_table('annotation_assignment', schema=None) as batch_op:
        batch_op.drop_index('ix_annotation_assignment_assignee_id')
    op.drop_table('annotation_assignment')
