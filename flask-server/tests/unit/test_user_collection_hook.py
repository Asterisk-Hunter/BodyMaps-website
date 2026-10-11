"""The inference route must offer every finished scan to the user-dataset gatekeeper.

On Aug 14 an unrelated merge dropped this one call from the inference path. The gatekeeper itself
kept passing its own tests (they call it directly), nothing failed, and no scan was collected for
seven weeks. These tests read the route's source, so they need no heavy imports, and fail if the
call is removed, moved before the result is delivered, or left unprotected.
"""
import ast
import os

import pytest

BLUEPRINT = os.path.join(os.path.dirname(__file__), "..", "..", "api", "api_blueprint.py")


@pytest.fixture(scope="module")
def tree():
    with open(BLUEPRINT, encoding="utf-8") as f:
        return ast.parse(f.read())


def _function(tree, name, parent=None):
    scope = parent if parent is not None else tree
    for node in ast.walk(scope):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"{name} not found")


def _calls(node, name):
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                out.append(n)
    return out


def test_gatekeeper_call_exists_in_the_inference_worker(tree):
    start = _function(tree, "_start_auto_segmentation")
    worker = _function(tree, "do_segmentation_and_zip", start)
    calls = _calls(worker, "collect_user_scan_async")
    assert len(calls) == 1, "the inference worker must call collect_user_scan_async exactly once"
    kwargs = {k.arg for k in calls[0].keywords}
    assert {"ct_path", "output_mask_dir", "model", "user_id", "ip", "session_id"} <= kwargs


def test_it_is_imported_from_the_gatekeeper_module(tree):
    start = _function(tree, "_start_auto_segmentation")
    imports = [n for n in ast.walk(start) if isinstance(n, ast.ImportFrom) and n.module == "services.user_dataset"]
    assert any(a.name == "collect_user_scan_async" for imp in imports for a in imp.names)


def test_it_runs_only_after_the_result_is_delivered(tree):
    """Collection must never delay or affect the user: it comes after the job is marked completed."""
    start = _function(tree, "_start_auto_segmentation")
    worker = _function(tree, "do_segmentation_and_zip", start)
    collect = _calls(worker, "collect_user_scan_async")[0]
    completed = [
        c for c in _calls(worker, "_set_inference_job")
        if any(k.arg == "status" and isinstance(k.value, ast.Constant) and k.value.value == "completed"
               for k in c.keywords)
    ]
    assert completed, "the worker no longer marks the job completed"
    assert max(c.lineno for c in completed) < collect.lineno


def test_a_collection_failure_can_never_fail_the_request(tree):
    """The call sits in a try/except Exception, so a bug in the gatekeeper is logged, not raised."""
    start = _function(tree, "_start_auto_segmentation")
    worker = _function(tree, "do_segmentation_and_zip", start)
    collect = _calls(worker, "collect_user_scan_async")[0]
    guarded = False
    for node in ast.walk(worker):
        if isinstance(node, ast.Try) and any(h.type is not None and getattr(h.type, "id", "") == "Exception"
                                             for h in node.handlers):
            if any(c is collect for c in ast.walk(ast.Module(body=node.body, type_ignores=[]))
                   if isinstance(c, ast.Call)):
                guarded = True
    assert guarded, "collect_user_scan_async must be wrapped in try/except Exception"


def test_every_inference_entry_point_goes_through_that_worker(tree):
    """Both user-facing routes funnel through _start_auto_segmentation; a new one that does not
    would silently skip collection, so adding one must be a decision."""
    callers = {
        n.name for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and _calls(n, "_start_auto_segmentation")
        and n.name != "_start_auto_segmentation"
    }
    assert callers == {"auto_segment", "run_epai_inference"}, callers
