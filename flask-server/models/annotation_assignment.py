"""Who annotates which cases: a range of library case numbers handed to one annotator.

``range_annotation_assignment`` is one row per hand-out ("radiologist 1 takes cases 55 to 95 for veins and arteries").
``range_annotation_assignment_case`` records the cases an annotator has finished or flagged; a case with no row is
still to do, so a fresh assignment needs no per-case rows.

Deleting the assignee's account removes their assignments (CASCADE): an assignment with nobody to do it is just
clutter in the manager's table. ``created_by`` is SET NULL so the record survives its author leaving.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class AnnotationAssignment(db.Model):
    __tablename__ = "range_annotation_assignment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    assignee_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    # Library case numbers, both ends included (the same numbers /case/<number> opens).
    range_start: Mapped[int] = mapped_column(Integer, nullable=False)
    range_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # What to annotate, e.g. "Veins and arteries"; shown to the annotator as the task.
    task: Mapped[str] = mapped_column(String(120), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    def __repr__(self) -> str:
        return f"<AnnotationAssignment {self.id} {self.range_start}-{self.range_end} -> {self.assignee_id}>"


class AnnotationAssignmentCase(db.Model):
    __tablename__ = "range_annotation_assignment_case"

    assignment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("range_annotation_assignment.id", ondelete="CASCADE"), primary_key=True,
    )
    case_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    # "done" or "flagged" (needs a second look); no row means still to do.
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
