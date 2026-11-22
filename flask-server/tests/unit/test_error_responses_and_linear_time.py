"""Responses never repeat an error's text, and text from a client never makes a pattern run for ages."""
import re
import time
from pathlib import Path

import pytest

from services import ai_reasoning, intent_parser
from services.public_errors import known_message

API = Path(__file__).resolve().parents[2] / "api"


# ---- error responses -------------------------------------------------------

def test_a_known_message_is_sent_as_its_fixed_wording_never_the_raw_text():
    error = ValueError("Invalid job ID at /srv/secret/path/jobs.py line 81")
    assert known_message(error, ("Invalid job ID", "Job is not active"), "fallback") == "Invalid job ID"


def test_anything_unlisted_gets_the_general_sentence():
    error = ValueError("Traceback (most recent call last): /home/visitor/app.py")
    assert known_message(error, ("Invalid job ID",), "That job request was not valid.") == "That job request was not valid."


def test_the_result_is_never_longer_than_what_was_listed():
    error = KeyError("/etc/passwd")
    assert known_message(error, (), "nothing") == "nothing"


# The handlers that used to answer with an error's own text. A response built from str(error) is what was leaking.
LEAKY = re.compile(r"""jsonify\(\{\s*"error":\s*(?:f?["'][^"']*\{[^}]*(?:error|exc|\be\b|ve)\b[^}]*\}[^"']*["']|str\((?:e|error|exc|ve)\))""")


# These answer with typed domain errors (a quiz attempt that has expired, a room that is full, project validation)
# whose wording is written for the person, not with the text of an unexpected failure.
DOMAIN_ERROR_FILES = {"education.py", "live_rooms.py", "assignment_blueprint.py"}


@pytest.mark.parametrize("path", [p for p in sorted(API.glob("*.py")) if p.name not in DOMAIN_ERROR_FILES], ids=lambda p: p.name)
def test_no_handler_puts_an_errors_text_in_its_response(path):
    offenders = [
        f"{path.name}:{number}: {line.strip()}"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if LEAKY.search(line)
    ]
    assert not offenders, "an error's text reaches the response:\n" + "\n".join(offenders)


# ---- patterns that must stay linear ---------------------------------------

def _within(seconds, call):
    started = time.perf_counter()
    result = call()
    assert time.perf_counter() - started < seconds
    return result


HOSTILE = [
    " " * 60000 + "—",
    "1" + " " * 60000 + "—",
    "— " * 30000,
    "5" + " " * 60000 + "x–",
    "\t" * 60000 + "–",
    "\n" + " " * 60000 + "—",
    "—" + " " * 60000 + "abcdefghijklmnopqrstuvwxyz",
]


@pytest.mark.parametrize("text", HOSTILE, ids=range(len(HOSTILE)))
def test_dash_clean_up_is_linear(text):
    _within(2, lambda: ai_reasoning.strip_em_dashes(text))
    _within(2, lambda: ai_reasoning.strip_em_dashes_streaming(text))


def test_question_mark_check_is_linear():
    _within(1, lambda: intent_parser._ends_with_question_mark("?" * 80000 + " x"))


@pytest.mark.parametrize("sentence, expected", [
    ("Is it big?", True),
    ("Is it big? ", True),
    ('He asked "is it big?"', True),
    ("Is it big?)", True),
    ("Is it big?!.", True),
    ("Is it big", False),
    ("Is it big?x", False),
    ("?(", False),
    ("", False),
    ("   ", False),
])
def test_a_trailing_question_mark_is_found_like_before(sentence, expected):
    assert intent_parser._ends_with_question_mark(sentence) is expected


@pytest.mark.parametrize("text, expected", [
    ("Liver — spleen", "Liver, spleen"),
    ("5 — 10 mm", "5-10 mm"),
    ("5—10", "5-10"),
    ("a\n— b", "a\nb"),
    ("a —\nb", "a,\nb"),
    ("— start", "start"),
    ("7.35 – 7.45", "7.35 to 7.45"),
    ("one – two", "one, two"),
    ("10 mm – 15 mm", "10 mm to 15 mm"),
    ("`a — b` and c — d", "`a — b` and c, d"),
])
def test_dash_clean_up_gives_the_same_replies_as_before(text, expected):
    assert ai_reasoning.strip_em_dashes(text) == expected


@pytest.mark.parametrize("text, kept", [
    ("The lesion is 5 —", "The lesion is 5"),
    ("The lesion is 5 – 1", "The lesion is 5"),
    ("A sentence — ", "A sentence"),
    ("Done.", "Done."),
])
def test_a_growing_reply_holds_back_a_dash_that_may_start_a_range(text, kept):
    assert ai_reasoning.strip_em_dashes_streaming(text) == kept
