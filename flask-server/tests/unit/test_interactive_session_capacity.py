import threading
import time

import numpy as np
import pytest
import base64
import gzip

from services import nninteractive_predictor as predictor


class FakeSession:
    def __init__(self, *_args, **_kwargs):
        self.last_used = time.time()
        self._lock = threading.Lock()
        self.closed = False

    def close(self):
        with self._lock:
            self.closed = True


@pytest.fixture(autouse=True)
def clean_sessions(monkeypatch):
    with predictor._STORE_LOCK:
        for session in predictor._SESSIONS.values():
            session.close()
        predictor._SESSIONS.clear()
    monkeypatch.setattr(predictor, "_MAX_SESSIONS", 2)
    monkeypatch.setattr(predictor, "_MAX_SESSIONS_PER_USER", 2)
    yield
    with predictor._STORE_LOCK:
        for session in predictor._SESSIONS.values():
            session.close()
        predictor._SESSIONS.clear()


def test_full_pool_refuses_new_session_without_destroying_existing_context(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    resident = predictor.get_or_create_session("case-a", 1, "low", ct, session_token="alice-a", owner="alice")
    other = predictor.get_or_create_session("case-b", 1, "low", ct, session_token="bob-a", owner="bob")

    with pytest.raises(predictor.PromptCapacityError):
        predictor.get_or_create_session("case-c", 1, "low", ct, session_token="carol-a", owner="carol")

    assert predictor._SESSIONS[predictor._session_key("case-a", 1, "low", "alice-a", "alice")] is resident
    assert predictor._SESSIONS[predictor._session_key("case-b", 1, "low", "bob-a", "bob")] is other
    assert not resident.closed
    assert not other.closed


def test_a_user_can_hold_prompt_and_refine_sessions_together(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    prompt = predictor.get_or_create_session("case-a", 1, "low", ct, session_token="prompt", owner="alice")
    refine = predictor.get_or_create_session("case-a", 1, "low", ct, session_token="refine", owner="alice")
    assert len(predictor._SESSIONS) == 2
    assert not prompt.closed and not refine.closed


def test_a_new_token_replaces_the_same_users_oldest_idle_session(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    oldest = predictor.get_or_create_session("case-a", 1, "low", ct, session_token="old", owner="alice")
    newer = predictor.get_or_create_session("case-b", 1, "low", ct, session_token="new", owner="alice")

    replacement = predictor.get_or_create_session("case-c", 1, "low", ct, session_token="replacement", owner="alice")

    assert oldest.closed
    assert not newer.closed and not replacement.closed
    assert len(predictor._SESSIONS) == 2


def test_release_resolves_a_lowres_prompt_that_was_bridged_to_fullres(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    bridged = predictor.get_or_create_session(
        "case-a", 1, "full", ct, session_token="viewer-token", owner="alice"
    )
    unrelated = predictor.get_or_create_session(
        "case-a", 1, "full", ct, session_token="other-token", owner="alice"
    )

    predictor.drop_session("case-a", 1, "low", "viewer-token", "alice")

    assert bridged.closed
    assert not unrelated.closed
    assert predictor._session_key("case-a", 1, "full", "other-token", "alice") in predictor._SESSIONS


def test_release_of_an_unknown_prompt_session_is_idempotent():
    predictor.drop_session("case-a", 1, "low", "already-gone", "alice")


def test_lost_prompt_session_has_a_distinct_retryable_response():
    from flask import Flask
    from api.api_blueprint import _nninteractive_error_response

    app = Flask(__name__)
    with app.app_context():
        response, status = _nninteractive_error_response(predictor.PromptSessionLostError("gone"))
    assert status == 409
    assert response.get_json()["code"] == "session_lost"


def test_releasing_a_session_waits_for_its_active_prediction(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    session = predictor.get_or_create_session(
        "case-a", 1, "low", ct, session_token="viewer-token", owner="alice"
    )
    session._lock.acquire()
    released = threading.Event()

    def release():
        predictor.drop_session("case-a", 1, "low", "viewer-token", "alice")
        released.set()

    worker = threading.Thread(target=release)
    worker.start()
    try:
        time.sleep(0.02)
        assert not released.is_set()
        assert not session.closed
    finally:
        session._lock.release()
    worker.join(timeout=1)

    assert released.is_set()
    assert session.closed


def test_capacity_refusal_maps_to_retryable_http_response():
    from flask import Flask
    from api.api_blueprint import _nninteractive_error_response

    app = Flask(__name__)
    with app.app_context():
        response, status = _nninteractive_error_response(predictor.PromptCapacityError("at capacity"))
    assert status == 429
    assert response.get_json()["retry_after"] == 5


def test_seed_decoder_rejects_overinflated_payload_and_accepts_grid_sized_seed():
    from api.api_blueprint import _decode_interactive_seed

    oversized = base64.b64encode(gzip.compress(bytes(100_000))).decode("ascii")
    with pytest.raises(ValueError):
        _decode_interactive_seed(oversized, (4, 4, 4), allow_empty=True)

    seed = np.zeros((4, 4, 4), dtype=np.uint8)
    seed[1, 2, 3] = 1
    encoded = base64.b64encode(gzip.compress(seed.tobytes(order="F"))).decode("ascii")
    decoded = _decode_interactive_seed(encoded, seed.shape)
    np.testing.assert_array_equal(decoded, seed)


def test_idle_reaper_does_not_close_a_session_while_its_request_is_running(monkeypatch):
    monkeypatch.setattr(predictor, "_NNSession", FakeSession)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    resident = predictor.get_or_create_session("case-a", 1, "low", ct, session_token="alice")
    resident.last_used = 0
    resident._lock.acquire()
    try:
        predictor._evict_expired(time.time() + predictor._SESSION_TTL + 1)
        assert not resident.closed
        assert predictor._SESSIONS
    finally:
        resident._lock.release()


def test_expired_remote_lease_retries_from_the_supplied_current_mask(monkeypatch):
    import nnInteractive.inference.remote.remote_session as remote_module

    class FakeRemote:
        instances = []

        def __init__(self, **_kwargs):
            self.buffer = None
            self.calls = []
            self.closed = False
            FakeRemote.instances.append(self)

        def ping(self): return True
        def set_image(self, _image): pass
        def set_target_buffer(self, buffer): self.buffer = buffer
        def add_initial_seg_interaction(self, mask, **_kwargs):
            self.calls.append(("seed", int(mask.sum())))
            self.buffer[:] = mask
        def reset_interactions(self): self.buffer[:] = 0
        def add_point_interaction(self, coords, **_kwargs):
            self.calls.append(("point", tuple(coords)))
            if len(FakeRemote.instances) == 1:
                raise RuntimeError("lease expired")
            self.buffer[tuple(coords)] = 1
        def close(self): self.closed = True

    monkeypatch.setattr(remote_module, "nnInteractiveRemoteInferenceSession", FakeRemote)
    ct = np.zeros((2, 2, 2), dtype=np.float32)
    baseline = np.zeros_like(ct, dtype=np.uint8)
    baseline[0, 1, 1] = 1

    result = predictor.predict(
        ct, "case-a:low", point_ijk=(1, 1, 1), segment_label=4,
        session_token="alice", owner="reader", baseline_mask=baseline,
        inject_baseline=True,
    )

    assert FakeRemote.instances[0].closed
    assert FakeRemote.instances[1].calls[0] == ("seed", 1)
    assert result[0, 1, 1] == 1
    assert result[1, 1, 1] == 1
