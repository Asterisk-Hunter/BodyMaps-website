import pytest

from services.annotation_workflow import expand_selector, normalize_case, transition


def test_case_selector_normalizes_deduplicates_and_excludes():
    assert expand_selector("pants", {"ranges": [{"from": 55, "to": 57}], "ids": ["PanTS_55"], "exclude": [56]}) == ["PanTS_00000055", "PanTS_00000057"]


@pytest.mark.parametrize("case", ["../55", "CV_55", True, "-1", "123456789"])
def test_invalid_case_is_rejected(case):
    with pytest.raises(ValueError):
        normalize_case("pants", case)


def test_transitions_enforce_review_and_closed_project():
    assert transition("in_progress", "submit") == "submitted"
    assert transition("submitted", "approve", project_open=False) == "approved"
    assert transition("approved", "publish", project_open=False) == "published"
    with pytest.raises(ValueError):
        transition("submitted", "publish")
    with pytest.raises(ValueError):
        transition("in_progress", "submit", project_open=False)
