"""Account profile pictures.

Additive table: existing accounts have no picture until they upload one.
Normalized thumbnails share the account database's durability, backup and purge
policy. Downgrade drops pictures only, without changing existing account rows.
"""

from alembic import op
import sqlalchemy as sa

revision = "a0c94f83b7d2"
down_revision = "9e6a1b5d4c2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_avatar",
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("png", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user_account.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("user_avatar")
