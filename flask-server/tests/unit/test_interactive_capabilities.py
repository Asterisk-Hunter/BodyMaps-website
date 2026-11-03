"""Capability reporting copied from the upstream behavior, pinned to this fork's cache names."""
from flask import Flask

import api.api_blueprint as api_routes
import services.nninteractive_predictor as predictor


def _get():
    app = Flask(__name__)
    with app.test_request_context("/", method="GET"):
        return api_routes.interactive_capabilities()


def test_reports_only_capabilities_returned_by_the_model_server(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: {
        "license": "CC BY-NC-SA 4.0",
        "inference_session_version": "2.6.0",
        "supported_interactions": {"points": True},
    })

    response = _get()

    assert response.get_json() == {
        "available": True,
        "license": "CC BY-NC-SA 4.0",
        "model_version": "2.6.0",
        "interactions": {"point": True, "box": None, "scribble": None, "lasso": None},
        "refine": None,
        "undo": None,
    }


def test_reports_the_loaded_checkpoints_prompt_and_refine_support(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: {
        "license": "CC BY-NC-SA 4.0",
        "inference_session_version": "2.6.0",
        "supported_interactions": {
            "scribble": True, "lasso": True, "points": True, "bbox2d": True, "bbox3d": False,
        },
        "supports_initial_label": True,
        "supports_zero_shot_label_refinement": True,
        "supports_undo": True,
    })

    body = _get().get_json()

    assert body["interactions"] == {"point": True, "box": True, "scribble": True, "lasso": True}
    assert body["refine"] is True
    assert body["undo"] is True


def test_refine_is_disabled_when_checkpoint_cannot_accept_an_initial_label(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: {
        "supports_initial_label": False,
        "supports_zero_shot_label_refinement": True,
    })

    assert _get().get_json()["refine"] is False


def test_unavailable_model_server_produces_an_explicit_unavailable_capability_response(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: None)

    assert _get().get_json() == {
        "available": False,
        "license": None,
        "model_version": None,
        "interactions": None,
        "refine": None,
        "undo": None,
    }


def test_capability_cache_reuses_success_and_keeps_stale_values_during_outage(monkeypatch):
    import requests

    calls = {"n": 0}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"license": "CC BY-NC-SA 4.0"}

    def fake_get(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise requests.ConnectionError("server down")
        return Response()

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(predictor, "_CAPS_CACHE", None)
    monkeypatch.setattr(predictor, "_CAPS_FETCHED_AT", 0.0)
    monkeypatch.setattr(predictor, "_CAPS_FAILED_AT", 0.0)

    first = predictor.get_capabilities()
    assert first == {"license": "CC BY-NC-SA 4.0"}
    assert predictor.get_capabilities() is first
    assert calls["n"] == 1

    monkeypatch.setattr(predictor, "_CAPS_FETCHED_AT", -10_000.0)
    assert predictor.get_capabilities() is first
    assert calls["n"] == 2
