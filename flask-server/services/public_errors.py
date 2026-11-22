"""What an error response may say.

An error's own text can carry file paths, library internals or other things a caller should never see, so a
response never repeats it. When a failure has a message written for the person (a validation message from our own
code), it is listed by its fixed wording and that wording is what gets sent, never the raw text. Anything else
falls back to a general sentence. The real error is written to the server log.
"""
import logging

_log = logging.getLogger("bodymaps.errors")


def known_message(error, known, fallback):
    """The fixed sentence from `known` that begins the error's text, else `fallback`.

    The result is always one of the strings passed in, never anything taken from the error, so a path or a
    stack detail inside the error can not reach the response.
    """
    text = str(error)
    for message in known:
        if text.startswith(message):
            return message
    return fallback


def log_failure(where, error):
    """Record the real error on the server (type and text), for whoever debugs it."""
    _log.warning("%s failed: %s: %s", where, type(error).__name__, error)
