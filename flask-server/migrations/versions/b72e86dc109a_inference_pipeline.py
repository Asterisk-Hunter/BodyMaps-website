"""Persist owned inference pipeline selection, stages and reconstruction."""
from alembic import op
import sqlalchemy as sa

revision = "b72e86dc109a"
down_revision = "a0c94f83b7d2"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("job") as batch:
        batch.add_column(sa.Column("reconstruction_path", sa.Text(), nullable=True))
        batch.add_column(sa.Column("pipeline", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("pipeline_stages", sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table("job") as batch:
        batch.drop_column("pipeline_stages")
        batch.drop_column("pipeline")
        batch.drop_column("reconstruction_path")
