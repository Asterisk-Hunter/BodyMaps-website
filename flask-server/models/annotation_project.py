"""Persistent records for the opt-in annotation project workflow."""
from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class AnnotationProject(db.Model):
    __tablename__ = "annotation_project"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    scan_source: Mapped[str] = mapped_column(String(32), nullable=False)
    target_labels: Mapped[list] = mapped_column(JSON, nullable=False)
    target_names: Mapped[dict] = mapped_column(JSON, nullable=False)
    baseline_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    seed_dir: Mapped[str | None] = mapped_column(Text)
    reviewer_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    due_at = mapped_column(DateTime)
    closed_at = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")


class AnnotationAssignment(db.Model):
    __tablename__ = "annotation_assignment"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_project.id", ondelete="CASCADE"), nullable=False, index=True)
    assignee_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"), index=True)
    case_selector: Mapped[dict] = mapped_column(JSON, nullable=False)
    target_labels: Mapped[list | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    due_at = mapped_column(DateTime)


class AnnotationCase(db.Model):
    __tablename__ = "annotation_case"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    assignment_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_assignment.id", ondelete="CASCADE"), nullable=False, index=True)
    case_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="not_started")
    draft_revision: Mapped[str | None] = mapped_column(String(64))
    # Avoid a cyclic foreign key; service validates the referenced submission.
    current_submission_id: Mapped[str | None] = mapped_column(String(36))
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at = mapped_column(DateTime, nullable=False, default=utcnow)
    last_activity_at = mapped_column(DateTime, nullable=False, default=utcnow)
    __table_args__ = (
        UniqueConstraint("assignment_id", "case_key", name="uq_annotation_assignment_case"),
        # A CT has one active annotation owner, regardless of target structure.
        # The DB constraint closes the race between application workers.
        Index(
            "uq_annotation_case_active_case_key", "case_key", unique=True,
            sqlite_where=text("status NOT IN ('published', 'unavailable', 'released')"),
            postgresql_where=text("status NOT IN ('published', 'unavailable', 'released')"),
        ),
    )


class AnnotationSubmission(db.Model):
    __tablename__ = "annotation_submission"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    case_row_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_case.id", ondelete="CASCADE"), nullable=False, index=True)
    assignment_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_assignment.id", ondelete="CASCADE"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    submitted_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    submitted_by_name: Mapped[str] = mapped_column(String(200), nullable=False)
    submitted_at = mapped_column(DateTime, nullable=False, default=utcnow)
    note: Mapped[str | None] = mapped_column(Text)
    mask_low_path: Mapped[str] = mapped_column(Text, nullable=False)
    mask_full_path: Mapped[str] = mapped_column(Text, nullable=False)
    mask_revision: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="in_review")
    reviewer_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    reviewed_at = mapped_column(DateTime)
    review_note: Mapped[str | None] = mapped_column(Text)
    published_at = mapped_column(DateTime)
    published_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    __table_args__ = (UniqueConstraint("case_row_id", "version", name="uq_annotation_submission_version"),)


class AnnotationReviewEvent(db.Model):
    __tablename__ = "annotation_review_event"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    assignment_id: Mapped[str | None] = mapped_column(String(36), index=True)
    case_row_id: Mapped[str | None] = mapped_column(String(36), index=True)
    submission_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("user_account.id", ondelete="SET NULL"))
    actor_name: Mapped[str] = mapped_column(String(200), nullable=False)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    details: Mapped[dict | None] = mapped_column(JSON)
