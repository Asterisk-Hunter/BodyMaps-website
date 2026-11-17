"""Validation and state transitions for annotation projects."""
import re

SOURCES = {"pants": "PanTS", "cancerverse": "CV", "abdomenatlas": "BDMAP"}
TRANSITIONS = {
    ("not_started", "save_draft"): "in_progress",
    ("in_progress", "save_draft"): "in_progress",
    ("rework", "save_draft"): "in_progress",
    ("in_progress", "submit"): "submitted",
    ("submitted", "approve"): "approved",
    ("submitted", "rework"): "rework",
    ("approved", "rework"): "rework",
    ("approved", "publish"): "published",
}


def transition(status, action, *, project_open=True):
    if action in {"save_draft", "submit"} and not project_open:
        raise ValueError("Project is closed")
    try:
        return TRANSITIONS[(status, action)]
    except KeyError:
        raise ValueError("Invalid annotation state transition") from None


def normalize_case(source, case):
    prefix = SOURCES.get(source)
    if not prefix or isinstance(case, bool):
        raise ValueError("Invalid source or case")
    value = str(case).strip()
    match = re.fullmatch(r"(?:(PanTS|CV|BDMAP)_)?([0-9]{1,8})", value, re.IGNORECASE)
    if not match or (match.group(1) and match.group(1).lower() != prefix.lower()):
        raise ValueError("Case does not match project source")
    return f"{prefix}_{int(match.group(2)):08d}"


def expand_selector(source, selector, *, limit=10000):
    if not isinstance(selector, dict) or set(selector) - {"ranges", "ids", "exclude"}:
        raise ValueError("Invalid case selector")
    ranges, ids, excluded = (selector.get(k, []) for k in ("ranges", "ids", "exclude"))
    if not all(isinstance(v, list) for v in (ranges, ids, excluded)):
        raise ValueError("Selector fields must be lists")
    selected = {normalize_case(source, x) for x in ids}
    for entry in ranges:
        if not isinstance(entry, dict) or set(entry) != {"from", "to"}:
            raise ValueError("Invalid case range")
        first = int(normalize_case(source, entry["from"]).rsplit("_", 1)[1])
        last = int(normalize_case(source, entry["to"]).rsplit("_", 1)[1])
        if first > last or last - first + 1 > limit:
            raise ValueError("Invalid or oversized case range")
        selected.update(normalize_case(source, n) for n in range(first, last + 1))
        if len(selected) > limit:
            raise ValueError("Too many cases")
    if len(selected) > limit:
        raise ValueError("Too many cases")
    return sorted(selected - {normalize_case(source, x) for x in excluded})
