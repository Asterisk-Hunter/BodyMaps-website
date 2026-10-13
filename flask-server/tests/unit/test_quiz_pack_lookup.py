"""Finding the served quiz pack for one case, so the viewer can open its practice."""
from __future__ import annotations

from flask import Flask

import api.education as education_api
from services.live_quiz import QuizPackRegistry

from .test_quiz_platform import catalog_with


def test_registry_finds_the_served_pack_for_a_case():
    catalog = catalog_with(2)
    catalog["packs"][1]["approval"] = {"status": "pending"}
    registry = QuizPackRegistry(catalog)
    assert registry.pack_for_case("100")["pack_id"] == "test-pack-0-v1"
    assert registry.pack_for_case("0100")["pack_id"] == "test-pack-0-v1"
    assert registry.pack_for_case("999") is None
    # A pending pack is found only when the registry serves unreviewed packs.
    assert registry.pack_for_case("101") is None
    assert QuizPackRegistry(catalog, allow_unreviewed=True).pack_for_case("101")["pack_id"] == "test-pack-1-v1"


def test_quiz_pack_lookup_by_case_names_the_pack_without_its_answers(monkeypatch):
    monkeypatch.setattr("services.live_quiz._DEFAULT_REGISTRY", QuizPackRegistry(catalog_with(1)))
    app = Flask(__name__)
    app.register_blueprint(education_api.education_blueprint, url_prefix="/api")
    client = app.test_client()

    found = client.get("/api/education/quiz-packs?case_id=100")
    assert found.status_code == 200
    pack = found.get_json()["pack"]
    assert set(pack) == {"pack_id", "case_id", "title", "difficulty"}
    assert (pack["pack_id"], pack["case_id"], pack["difficulty"]) == ("test-pack-0-v1", "100", "easy")
    assert "correct_choice_id" not in found.get_data(as_text=True)
    assert client.get("/api/education/quiz-packs?case_id=7").get_json() == {"pack": None}
    missing = client.get("/api/education/quiz-packs")
    assert missing.status_code == 400
    assert missing.get_json()["code"] == "invalid_quiz_pack_request"
