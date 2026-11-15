"""Assignments: which annotator works on which range of cases, and how far along they are.

A manager hands an annotator a range of library case numbers (the numbers /case/<number> opens) for one task,
such as "Veins and arteries". The annotator sees their own list, opens each case, and marks it done or flagged.
A case with no mark is still to do. Two assignments for the same task that share a case are an overlap: the
manager is told and has to confirm, since doing the same work twice is usually a slip but sometimes the point
(a second reader).
"""

import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, select
from sqlalchemy import update as sql_update
from sqlalchemy.exc import IntegrityError

from models.annotation_assignment import AnnotationAssignment, AnnotationAssignmentCase
from models.engine import session_scope
from models.job import utcnow
from models.user import User
from models.user_role import UserRole
from services import role_store

MAX_CASE_NUMBER = 200_000
MAX_RANGE_SIZE = 50_000
STATUS_DONE = "done"
STATUS_FLAGGED = "flagged"
STATUS_TODO = "todo"
CASE_STATUSES = frozenset({STATUS_DONE, STATUS_FLAGGED, STATUS_TODO})


class AssignmentError(ValueError):
    """A refused request. ``reason`` is machine readable; ``details`` carries extra data (e.g. the overlaps)."""

    def __init__(self, reason: str, message: str, details=None):
        super().__init__(message)
        self.reason = reason
        self.details = details or {}


def _clean_range(start, end) -> tuple[int, int]:
    for v in (start, end):
        if not isinstance(v, int) or isinstance(v, bool):
            raise AssignmentError("bad_range", "The first and last case must be whole numbers.")
    if not 1 <= start <= end <= MAX_CASE_NUMBER:
        raise AssignmentError("bad_range", f"Cases run from 1 up to {MAX_CASE_NUMBER}, with the first before the last.")
    if end - start + 1 > MAX_RANGE_SIZE:
        raise AssignmentError("bad_range", f"One assignment can hold at most {MAX_RANGE_SIZE} cases.")
    return start, end


def _clean_task(task) -> str:
    if task is not None and not isinstance(task, str):
        raise AssignmentError("bad_task", "The task must be text.")
    task = " ".join((task or "").split())
    if not task:
        raise AssignmentError("bad_task", "Say what should be annotated, for example Veins and arteries.")
    if len(task) > 120:
        raise AssignmentError("bad_task", "The task is limited to 120 characters.")
    return task


def _clean_note(note) -> str | None:
    if note is not None and not isinstance(note, str):
        raise AssignmentError("bad_note", "The note must be text.")
    note = (note or "").strip()
    if len(note) > 2000:
        raise AssignmentError("bad_note", "The note is limited to 2000 characters.")
    return note or None


def _clean_due(due) -> datetime | None:
    if due is None or due == "":
        return None
    if not isinstance(due, str):
        raise AssignmentError("bad_due", "The due date must look like 2026-12-31.")
    try:
        parsed = datetime.fromisoformat(due.replace("Z", "+00:00"))
    except ValueError:
        raise AssignmentError("bad_due", "The due date must look like 2026-12-31.")
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def _counts(s, assignment_ids: list[str]) -> dict[str, dict[str, int]]:
    out = {i: {"done": 0, "flagged": 0} for i in assignment_ids}
    if not assignment_ids:
        return out
    rows = s.execute(
        select(AnnotationAssignmentCase.assignment_id, AnnotationAssignmentCase.status, func.count())
        .where(AnnotationAssignmentCase.assignment_id.in_(assignment_ids))
        .group_by(AnnotationAssignmentCase.assignment_id, AnnotationAssignmentCase.status)
    ).all()
    for aid, status, n in rows:
        if status in out[aid]:
            out[aid][status] = n
    return out


def _as_dict(a: AnnotationAssignment, user: User | None, counts: dict[str, int]) -> dict:
    total = a.range_end - a.range_start + 1
    return {
        "id": a.id,
        "assignee": {"id": a.assignee_id, "name": (user.name if user else None), "email": (user.email if user else None)},
        "start": a.range_start,
        "end": a.range_end,
        "task": a.task,
        "note": a.note,
        "due_at": _iso(a.due_at),
        "created_at": _iso(a.created_at),
        "total": total,
        "done": counts["done"],
        "flagged": counts["flagged"],
        "todo": max(0, total - counts["done"] - counts["flagged"]),
    }


def _find_overlaps(s, start: int, end: int, task: str, ignore_id: str | None = None) -> list[dict]:
    q = select(AnnotationAssignment, User).join(User, User.id == AnnotationAssignment.assignee_id).where(
        and_(AnnotationAssignment.range_start <= end, AnnotationAssignment.range_end >= start,
             func.lower(AnnotationAssignment.task) == task.lower())
    )
    if ignore_id:
        q = q.where(AnnotationAssignment.id != ignore_id)
    out = []
    for a, u in s.execute(q).all():
        out.append({
            "id": a.id, "assignee": u.name or u.email, "start": a.range_start, "end": a.range_end,
            "shared_start": max(start, a.range_start), "shared_end": min(end, a.range_end),
        })
    return out


def _require_annotator(s, user_id: str) -> User:
    who = s.get(User, user_id) if isinstance(user_id, str) else None
    if who is None or who.deletion_requested_at is not None:
        raise AssignmentError("no_such_person", "That account was not found.")
    if not (set(role_store.roles_for(user_id)) & role_store.ANNOTATING_ROLES):
        raise AssignmentError("not_an_annotator", "Only an annotator can be given cases. Make them an annotator first.")
    return who


def create(*, assignee_id: str, start, end, task, note=None, due=None, created_by: str, force: bool = False) -> dict:
    start, end = _clean_range(start, end)
    task, note, due_at = _clean_task(task), _clean_note(note), _clean_due(due)
    with session_scope() as s:
        assignee = _require_annotator(s, assignee_id)
        overlaps = _find_overlaps(s, start, end, task)
        if overlaps and not force:
            raise AssignmentError("overlap", "Part of this range is already assigned for the same task.", {"overlaps": overlaps})
        a = AnnotationAssignment(
            id=str(uuid.uuid4()), assignee_id=assignee_id, range_start=start, range_end=end, task=task,
            note=note, due_at=due_at, created_by=created_by,
        )
        s.add(a)
        s.flush()
        result = _as_dict(a, assignee, {"done": 0, "flagged": 0})
        result["overlaps"] = overlaps
        return result


def list_all() -> list[dict]:
    """Every assignment, newest first, with progress."""
    with session_scope() as s:
        rows = s.execute(
            select(AnnotationAssignment, User)
            .join(User, User.id == AnnotationAssignment.assignee_id)
            .order_by(AnnotationAssignment.created_at.desc(), AnnotationAssignment.range_start)
        ).all()
        counts = _counts(s, [a.id for a, _ in rows])
        return [_as_dict(a, u, counts[a.id]) for a, u in rows]


def list_for(user_id: str) -> list[dict]:
    """One account's own assignments with the status of every case marked so far."""
    with session_scope() as s:
        rows = s.execute(
            select(AnnotationAssignment, User)
            .join(User, User.id == AnnotationAssignment.assignee_id)
            .where(AnnotationAssignment.assignee_id == user_id)
            .order_by(AnnotationAssignment.range_start)
        ).all()
        ids = [a.id for a, _ in rows]
        counts = _counts(s, ids)
        marks: dict[str, dict[str, str]] = {i: {} for i in ids}
        if ids:
            for aid, num, status in s.execute(
                select(AnnotationAssignmentCase.assignment_id, AnnotationAssignmentCase.case_number, AnnotationAssignmentCase.status)
                .where(AnnotationAssignmentCase.assignment_id.in_(ids))
            ).all():
                marks[aid][str(num)] = status
        out = []
        for a, u in rows:
            d = _as_dict(a, u, counts[a.id])
            d["marks"] = marks[a.id]
            out.append(d)
        return out


def update(assignment_id: str, changes: dict) -> dict:
    """Change an assignment's person, task, note or due date. Only keys present in ``changes`` are touched."""
    with session_scope() as s:
        a = s.get(AnnotationAssignment, assignment_id)
        if a is None:
            raise LookupError(assignment_id)
        if "assignee_id" in changes:
            _require_annotator(s, changes["assignee_id"])
            a.assignee_id = changes["assignee_id"]
        if "task" in changes:
            a.task = _clean_task(changes["task"])
        if "note" in changes:
            a.note = _clean_note(changes["note"])
        if "due" in changes:
            a.due_at = _clean_due(changes["due"])
        s.flush()
        return _as_dict(a, s.get(User, a.assignee_id), _counts(s, [a.id])[a.id])


def delete_assignment(assignment_id: str) -> bool:
    with session_scope() as s:
        a = s.get(AnnotationAssignment, assignment_id)
        if a is None:
            return False
        s.execute(delete(AnnotationAssignmentCase).where(AnnotationAssignmentCase.assignment_id == assignment_id))
        s.delete(a)
        return True


def set_case_status(assignment_id: str, case_number, status, *, acting_user_id: str, is_manager: bool) -> dict:
    """Mark one case of an assignment. Only its assignee, or a manager, may."""
    if not isinstance(status, str) or status not in CASE_STATUSES:
        raise AssignmentError("bad_status", "The status must be done, flagged or todo.")
    if not isinstance(case_number, int) or isinstance(case_number, bool):
        raise AssignmentError("bad_case", "The case must be a number.")
    with session_scope() as s:
        a = s.get(AnnotationAssignment, assignment_id)
        if a is None:
            raise LookupError(assignment_id)
        if a.assignee_id != acting_user_id and not is_manager:
            raise PermissionError(assignment_id)
        if not a.range_start <= case_number <= a.range_end:
            raise AssignmentError("outside_range", "That case is not part of this assignment.")
        mark = (AnnotationAssignmentCase.assignment_id == assignment_id) & (AnnotationAssignmentCase.case_number == case_number)
        if status == STATUS_TODO:
            s.execute(delete(AnnotationAssignmentCase).where(mark))
        else:
            # Two tabs, a double click, or a manager marking at the same moment can race to insert the same row.
            # Update first; insert only if nothing was there, and if someone else inserted in between, update theirs.
            changed = s.execute(sql_update(AnnotationAssignmentCase).where(mark).values(status=status, updated_at=utcnow())).rowcount
            if not changed:
                try:
                    with s.begin_nested():
                        s.add(AnnotationAssignmentCase(assignment_id=assignment_id, case_number=case_number,
                                                       status=status, updated_at=utcnow()))
                except IntegrityError:
                    s.execute(sql_update(AnnotationAssignmentCase).where(mark).values(status=status, updated_at=utcnow()))
        s.flush()
        return _as_dict(a, s.get(User, a.assignee_id), _counts(s, [a.id])[a.id])


def assignable_people() -> list[dict]:
    """Accounts that may be given cases: those holding an annotating role."""
    with session_scope() as s:
        rows = s.execute(
            select(User).join(UserRole, UserRole.user_id == User.id)
            .where(UserRole.role.in_(sorted(role_store.ANNOTATING_ROLES)), User.deletion_requested_at.is_(None))
            .group_by(User.id).order_by(func.lower(func.coalesce(User.name, User.email)))
        ).scalars().all()
        return [{"id": u.id, "name": u.name, "email": u.email} for u in rows]
