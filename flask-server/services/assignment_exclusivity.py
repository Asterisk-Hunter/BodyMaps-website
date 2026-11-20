"""Cross-check case ownership between range assignments and project workflow."""

from sqlalchemy import select


PANTS_CASE_COUNT = 9901
CANCERVERSE_LAST_NUMBER = 34323


def case_key_to_library_number(case_key: str) -> int | None:
    """Map canonical project case keys to the same global number used by /case/<n>."""
    if not isinstance(case_key, str):
        return None
    prefix, separator, digits = case_key.partition("_")
    if not separator or not digits.isdigit():
        return None
    number = int(digits)
    if number < 1:
        return None
    prefix = prefix.upper()
    if prefix == "PANTS":
        return number if number <= PANTS_CASE_COUNT else None
    if prefix == "CV":
        return PANTS_CASE_COUNT + number if number <= 24422 else None
    if prefix == "BDMAP":
        return CANCERVERSE_LAST_NUMBER + number
    return None


def project_case_conflicts(session, start: int, end: int) -> list[dict]:
    """Return active project-owned cases in a range, for range-assignment creation."""
    from models.annotation_project import AnnotationAssignment, AnnotationCase
    from models.user import User

    active_statuses = ("published", "unavailable", "released")
    rows = session.execute(
        select(AnnotationCase.case_key, AnnotationAssignment.id, User.name, User.email)
        .join(AnnotationAssignment, AnnotationCase.assignment_id == AnnotationAssignment.id)
        .outerjoin(User, User.id == AnnotationAssignment.assignee_id)
        .where(AnnotationCase.status.notin_(active_statuses))
    ).all()
    conflicts = []
    for case_key, assignment_id, name, email in rows:
        number = case_key_to_library_number(case_key)
        if number is not None and start <= number <= end:
            conflicts.append({
                "id": f"project:{assignment_id}:{case_key}",
                "assignee": name or email or "Project assignee",
                "start": number, "end": number,
                "shared_start": number, "shared_end": number,
            })
    return conflicts


def range_case_conflicts(session, case_keys: list[str]) -> set[str]:
    """Return project case keys covered by any active range assignment."""
    from models.annotation_assignment import AnnotationAssignment as RangeAssignment

    numbers = {case_key_to_library_number(key): key for key in case_keys}
    numbers.pop(None, None)
    if not numbers:
        return set()
    low, high = min(numbers), max(numbers)
    ranges = session.execute(
        select(RangeAssignment.range_start, RangeAssignment.range_end)
        .where(RangeAssignment.range_start <= high, RangeAssignment.range_end >= low)
    ).all()
    return {key for number, key in numbers.items()
            if any(start <= number <= end for start, end in ranges)}
