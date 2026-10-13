"""The solo challenge without its answer data: a 409 the client can tell apart, or a 503
while the dataset mount is down, instead of a bare 400."""
from __future__ import annotations

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.education as education_api
from services import mount_health
from services.education_store import (
    CHALLENGE_ID,
    ChallengeUnavailable,
    DatasetStorageUnavailable,
    EducationStore,
)

from .test_education_store import Clock, education_store, passing_grader, valid_submission  # noqa: F401


def _client(store, monkeypatch):
    monkeypatch.setattr(education_api, "_store", store)
    app = Flask(__name__)
    app.register_blueprint(education_api.education_blueprint, url_prefix="/api")
    return app.test_client()


@pytest.fixture
def mount_monitor():
    """A monitor whose verdict the test controls (no probing, no threads)."""
    monitor = mount_health.MountMonitor(["/does/not/matter"], probe=lambda _path: True)
    mount_health.reset_for_tests(monitor)
    yield monitor
    mount_health.reset_for_tests(None)


def test_start_without_the_case_mask_says_the_challenge_is_unavailable(tmp_path, monkeypatch, mount_monitor):
    store = EducationStore(tmp_path / "sessions", tmp_path / "pants", now=Clock(), grader=passing_grader)
    with pytest.raises(ChallengeUnavailable):
        store.start_attempt(CHALLENGE_ID)

    response = _client(store, monkeypatch).post(f"/api/education/challenges/{CHALLENGE_ID}/attempts", json={})

    assert response.status_code == 409
    assert response.get_json()["code"] == "challenge_unavailable"


def test_mask_removed_after_start_says_the_challenge_is_unavailable(education_store, monkeypatch, mount_monitor):  # noqa: F811
    client = _client(education_store, monkeypatch)
    mask = education_store.pants_path / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"

    graded, graded_key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(graded["attempt_id"], graded_key, valid_submission())
    pending, pending_key = education_store.start_attempt(CHALLENGE_ID)
    mask.unlink()

    with pytest.raises(ChallengeUnavailable):
        education_store._ground_truth()
    with pytest.raises(ChallengeUnavailable):
        education_store.submit(pending["attempt_id"], pending_key, valid_submission())
    with pytest.raises(ChallengeUnavailable):
        education_store.reveal_segmentation(graded["attempt_id"], graded_key)

    submitted = client.post(
        f"/api/education/attempts/{pending['attempt_id']}/submit",
        json=valid_submission(),
        headers={"X-Attempt-Key": pending_key},
    )
    assert submitted.status_code == 409
    assert submitted.get_json()["code"] == "challenge_unavailable"
    revealed = client.get(
        f"/api/education/attempts/{graded['attempt_id']}/reveal-segmentation.nii.gz",
        headers={"X-Attempt-Key": graded_key},
    )
    assert revealed.status_code == 409
    assert revealed.get_json()["code"] == "challenge_unavailable"


def test_mask_without_a_lesion_says_the_challenge_is_unavailable(education_store, mount_monitor):  # noqa: F811
    mask = education_store.pants_path / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((12, 12, 5), dtype=np.uint8), np.eye(4)), mask)

    with pytest.raises(ChallengeUnavailable):
        education_store._ground_truth()


def test_a_dataset_mount_outage_is_a_retryable_503_not_a_missing_challenge(education_store, monkeypatch, mount_monitor):  # noqa: F811
    client = _client(education_store, monkeypatch)
    graded, graded_key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(graded["attempt_id"], graded_key, valid_submission())
    pending, pending_key = education_store.start_attempt(CHALLENGE_ID)
    (education_store.pants_path / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz").unlink()
    mount_monitor._down = True

    with pytest.raises(DatasetStorageUnavailable):
        education_store.start_attempt(CHALLENGE_ID)
    started = client.post(f"/api/education/challenges/{CHALLENGE_ID}/attempts", json={})
    assert started.status_code == 503
    assert started.get_json()["code"] == "dataset_storage_unavailable"
    submitted = client.post(
        f"/api/education/attempts/{pending['attempt_id']}/submit",
        json=valid_submission(),
        headers={"X-Attempt-Key": pending_key},
    )
    assert submitted.status_code == 503
    revealed = client.get(
        f"/api/education/attempts/{graded['attempt_id']}/reveal-segmentation.nii.gz",
        headers={"X-Attempt-Key": graded_key},
    )
    assert revealed.status_code == 503

    # Once the mount answers again, a missing mask reads as missing.
    mount_monitor._down = False
    assert client.post(f"/api/education/challenges/{CHALLENGE_ID}/attempts", json={}).status_code == 409
