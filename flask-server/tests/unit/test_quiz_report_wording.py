"""Wording of the quiz question generated from a structured report's lesion attenuation."""
from __future__ import annotations

from services.quiz_generation import report_finding_for

from .test_quiz_report_questions import lesion_block, structured_report


def test_report_attenuation_choices_are_sentence_case_with_unchanged_ids():
    raw = structured_report(lesions=lesion_block(1, region="tail", size="2.3 x 1.2", attenuation="Hypoattenuating"))
    question, _truth, warnings = report_finding_for(
        raw, lesion_present=True, region="tail", diameter_mm=23.0, viewer_cue={"clear_overlays": True}
    )
    assert question and warnings == []
    assert [(c["id"], c["label"]) for c in question["choices"]] == [
        ("hyperattenuating", "Hyperattenuating"),
        ("isoattenuating", "Isoattenuating"),
        ("hypoattenuating", "Hypoattenuating"),
        ("not_described", "Not described"),
    ]
    assert question["correct_choice_id"] == "hypoattenuating"


def test_report_attenuation_explanation_reads_as_a_sentence():
    raw = structured_report(lesions=lesion_block(1, region="head", size="2.3 x 1.2", attenuation="Hyperattenuating"))
    question, _truth, _warnings = report_finding_for(
        raw, lesion_present=True, region="head", diameter_mm=23.0, viewer_cue={"clear_overlays": True}
    )
    assert question
    assert question["explanation"] == (
        "The structured report describes the pancreatic-head lesion as hyperattenuating relative to the pancreas."
    )
