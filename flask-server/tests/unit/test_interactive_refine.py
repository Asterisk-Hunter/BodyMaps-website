"""Regression coverage for the current fork's direct nnInteractive refine path."""
import numpy as np
import pytest

from services import nninteractive_predictor as predictor


class RefineRemote:
    instances = []
    supports_refine = True

    def __init__(self, **_kwargs):
        self.buffer = None
        self.calls = []
        self.supports_zero_shot_label_refinement = self.supports_refine
        type(self).instances.append(self)

    def ping(self):
        return True

    def set_image(self, _image):
        self.calls.append(("set_image",))

    def set_target_buffer(self, buffer):
        self.buffer = buffer

    def reset_interactions(self):
        self.calls.append(("reset",))
        self.buffer[:] = 0

    def add_initial_seg_interaction(self, mask, run_prediction=False):
        self.calls.append(("initial_seg", int(mask.sum()), run_prediction))
        self.buffer[:] = mask
        if run_prediction:
            self.buffer[1:, :, :] |= mask[:-1, :, :]

    def close(self):
        pass


@pytest.fixture(autouse=True)
def clean_prompt_sessions(monkeypatch):
    import nnInteractive.inference.remote.remote_session as remote_module

    RefineRemote.instances = []
    RefineRemote.supports_refine = True
    monkeypatch.setattr(remote_module, "nnInteractiveRemoteInferenceSession", RefineRemote)
    with predictor._STORE_LOCK:
        predictor._SESSIONS.clear()
    yield
    with predictor._STORE_LOCK:
        for session in predictor._SESSIONS.values():
            session.close()
        predictor._SESSIONS.clear()


def test_refine_sends_current_mask_as_a_prediction_seed():
    ct = np.zeros((4, 4, 4), dtype=np.float32)
    seed = np.zeros(ct.shape, dtype=np.uint8)
    seed[1, 2, 2] = 1

    result = predictor.predict(ct, "case-a:full", segment_label=6,
                               session_token="refine", baseline_mask=seed, refine=True)

    remote = RefineRemote.instances[0]
    assert remote.calls == [
        ("set_image",),
        ("reset",),
        ("initial_seg", 1, True),
    ]
    assert result[1, 2, 2] == 1
    assert result[2, 2, 2] == 1


@pytest.mark.parametrize("seed", [None, np.zeros((4, 4, 4), dtype=np.uint8)])
def test_refine_rejects_missing_or_empty_seed_before_opening_a_model_session(seed):
    with pytest.raises(ValueError, match="no voxels to refine"):
        predictor.predict(np.zeros((4, 4, 4), dtype=np.float32), "case-a:full",
                          session_token="refine", baseline_mask=seed, refine=True)

    assert RefineRemote.instances == []
    assert predictor._SESSIONS == {}


def test_refine_respects_checkpoint_capability():
    RefineRemote.supports_refine = False
    seed = np.ones((4, 4, 4), dtype=np.uint8)

    with pytest.raises(ValueError, match="can't refine"):
        predictor.predict(np.zeros(seed.shape, dtype=np.float32), "case-a:full",
                          session_token="refine", baseline_mask=seed, refine=True)

    assert not any(call[0] == "initial_seg" for call in RefineRemote.instances[0].calls)
