import base64
import gzip
import io

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as routes
from services import advanced_analysis, nninteractive_predictor, role_store


@pytest.fixture
def prompt_client(tmp_path, monkeypatch):
    current = {"id": "account-a"}
    monkeypatch.setattr(routes, "current_user", lambda: current.copy())

    image = nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.float32), np.eye(4))
    ct_path = tmp_path / "ct.nii.gz"
    nib.save(image, ct_path)
    monkeypatch.setattr(routes, "_case_ct_path", lambda _case_id, low=False: str(ct_path))
    monkeypatch.setattr(routes, "_load_ct_cached", lambda *_args: (image, np.zeros((2, 2, 2), dtype=np.float32)))
    monkeypatch.setattr(routes, "_case_mask_path", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(advanced_analysis, "USE_NNINTERACTIVE", True)

    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), current, image


@pytest.mark.parametrize("kind", ["lasso", "scribble"])
def test_cropped_viewer_stroke_reaches_predictor(prompt_client, monkeypatch, kind):
    client, _, _ = prompt_client
    seen = {}

    def predict(_ct, _case_key, **kwargs):
        seen.update(kwargs)
        return np.ones((2, 2, 2), dtype=np.uint8)

    monkeypatch.setattr(nninteractive_predictor, "predict", predict)
    bbox = [[0, 2], [0, 2], [0, 1]]
    stroke = np.array([1, 1, 0, 0], dtype=np.uint8).reshape((2, 2, 1), order="F")
    payload = {"res": "full", "segment_label": 6, f"{kind}_bbox": bbox,
               f"{kind}_mask": base64.b64encode(stroke.tobytes(order="F")).decode("ascii")}

    assert client.post("/api/interactive-segment/35", json=payload).status_code == 200
    np.testing.assert_array_equal(seen[f"{kind}_mask"], stroke)
    assert seen[f"{kind}_bbox"] == bbox


def test_low_resolution_point_uses_full_resolution_inference_grid(prompt_client, tmp_path, monkeypatch):
    client, _, _ = prompt_client
    low = nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.float32), np.eye(4))
    full = nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.float32), np.diag([0.5, 0.5, 0.5, 1]))
    low_path, full_path = tmp_path / "low.nii.gz", tmp_path / "full.nii.gz"
    nib.save(low, low_path)
    nib.save(full, full_path)
    monkeypatch.setattr(routes, "_case_ct_path", lambda _case_id, low=False: str(low_path if low else full_path))
    monkeypatch.setattr(routes, "_load_ct_cached", lambda path, *_args: (low, np.zeros((2, 2, 2), np.float32)) if path == str(low_path) else (full, np.zeros((4, 4, 4), np.float32)))
    seen = {}

    def predict(ct, case_key, **kwargs):
        seen.update(shape=ct.shape, case_key=case_key, point=kwargs["point_ijk"])
        return np.ones(ct.shape, dtype=np.uint8)

    monkeypatch.setattr(nninteractive_predictor, "predict", predict)
    response = client.post("/api/interactive-segment/35", json={
        "res": "low", "segment_label": 6, "point_ijk": [1, 1, 1],
    })

    assert response.status_code == 200
    assert seen["shape"] == (4, 4, 4)
    assert seen["case_key"].endswith(":35:viewer-labels-r1-ipantsmini-v1:full")
    assert seen["point"] == (2, 2, 2)
    returned = nib.Nifti1Image.from_bytes(gzip.decompress(response.data))
    assert returned.shape == (2, 2, 2)


def test_low_resolution_seed_and_box_are_scaled_to_the_full_model_grid(prompt_client, tmp_path, monkeypatch):
    client, _, _ = prompt_client
    low = nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.float32), np.diag([2.0, 2.0, 2.0, 1.0]))
    full = nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.float32), np.eye(4))
    low_path, full_path = tmp_path / "low-seed.nii.gz", tmp_path / "full-seed.nii.gz"
    nib.save(low, low_path)
    nib.save(full, full_path)
    monkeypatch.setattr(routes, "_case_ct_path", lambda _case_id, low=False: str(low_path if low else full_path))
    monkeypatch.setattr(
        routes,
        "_load_ct_cached",
        lambda path, *_args: (low, np.zeros((2, 2, 2), np.float32))
        if path == str(low_path) else (full, np.zeros((4, 4, 4), np.float32)),
    )
    seen = {}

    def predict(ct, _case_key, **kwargs):
        seen.update(shape=ct.shape, point=kwargs["point_ijk"], box=kwargs["box_ijk"], seed=kwargs["baseline_mask"])
        return np.ones(ct.shape, dtype=np.uint8)

    monkeypatch.setattr(nninteractive_predictor, "predict", predict)
    seed_low = np.zeros((2, 2, 2), dtype=np.uint8)
    seed_low[1, 0, 1] = 1
    seed = base64.b64encode(gzip.compress(seed_low.tobytes(order="F"))).decode("ascii")

    response = client.post("/api/interactive-segment/35", json={
        "res": "low", "segment_label": 6, "point_ijk": [1, 1, 1],
        "box_ijk": [[1, 0, 1], [2, 1, 2]], "initial_seg_gz_b64": seed,
    })

    assert response.status_code == 200
    assert seen["shape"] == (4, 4, 4)
    assert seen["point"] == (2, 2, 2)
    assert seen["box"] == ((2, 0, 2), (4, 3, 4))
    assert seen["seed"].shape == (4, 4, 4)
    assert int(seen["seed"].sum()) == 8
    assert seen["seed"][2:4, 0:2, 2:4].all()
    returned = nib.Nifti1Image.from_bytes(gzip.decompress(response.data))
    assert returned.shape == (2, 2, 2)
    np.testing.assert_allclose(returned.affine, low.affine)


def test_stroke_gzip_cannot_inflate_beyond_its_crop():
    bomb = base64.b64encode(gzip.compress(bytes(1_000_000))).decode("ascii")
    with pytest.raises(ValueError):
        advanced_analysis._decode_mask_payload(bomb, (2, 2, 2), [[0, 2], [0, 2], [0, 1]])


def test_numpy_stroke_payload_remains_supported():
    stroke = np.array([1, 1, 0, 0], dtype=np.uint8).reshape((2, 2, 1))
    buffer = io.BytesIO()
    np.save(buffer, stroke, allow_pickle=False)
    encoded = base64.b64encode(gzip.compress(buffer.getvalue())).decode("ascii")
    decoded = advanced_analysis._decode_mask_payload(encoded, (2, 2, 2), [[0, 2], [0, 2], [0, 1]])
    np.testing.assert_array_equal(decoded, stroke)


@pytest.mark.parametrize("kind", ["lasso", "scribble"])
def test_cropped_stroke_is_preserved_during_undo_replay(prompt_client, monkeypatch, kind):
    client, _, _ = prompt_client
    seen = []

    class Session:
        interaction_count = 0

        def reset(self, baseline_mask=None):
            pass

        def add_interaction(self, **kwargs):
            seen.append(kwargs)

        def get_result(self):
            return np.ones((2, 2, 2), dtype=np.uint8)

    monkeypatch.setattr(nninteractive_predictor, "get_or_create_session", lambda *_a, **_kw: Session())
    bbox = [[0, 2], [0, 2], [0, 1]]
    stroke = np.array([1, 1, 0, 0], dtype=np.uint8).reshape((2, 2, 1), order="F")
    prompt = {"type": kind, f"{kind}_bbox": bbox,
              f"{kind}_mask": base64.b64encode(stroke.tobytes(order="F")).decode("ascii")}
    response = client.post("/api/interactive-segment/35/sync", json={"res": "full", "segment_label": 6, "active_prompts": [prompt]})
    assert response.status_code == 200
    np.testing.assert_array_equal(seen[0][f"{kind}_mask"], stroke)
    assert seen[0][f"{kind}_bbox"] == bbox


def test_catalog_prompt_sessions_are_scoped_to_the_signed_in_account(prompt_client, monkeypatch):
    client, current, _image = prompt_client
    seen_case_keys = []

    def predict(_ct, case_key, **_kwargs):
        seen_case_keys.append(case_key)
        return np.ones((2, 2, 2), dtype=np.uint8)

    monkeypatch.setattr(nninteractive_predictor, "predict", predict)
    payload = {"res": "full", "segment_label": 6, "point_ijk": [0, 0, 0]}

    assert client.post("/api/interactive-segment/35", json=payload).status_code == 200
    current["id"] = "account-b"
    assert client.post("/api/interactive-segment/35", json=payload).status_code == 200

    assert len(seen_case_keys) == 2
    assert seen_case_keys[0] != seen_case_keys[1]


def test_catalog_undo_sync_sessions_are_scoped_to_the_signed_in_account(prompt_client, monkeypatch):
    client, current, _image = prompt_client
    seen_case_scopes = []

    class Session:
        interaction_count = 0

        def reset(self, baseline_mask=None):
            pass

        def get_result(self):
            return np.ones((2, 2, 2), dtype=np.uint8)

    def get_session(case_id, _label, _resolution, _ct, baseline_mask=None):
        seen_case_scopes.append(case_id)
        return Session()

    monkeypatch.setattr(nninteractive_predictor, "get_or_create_session", get_session)
    payload = {"res": "full", "segment_label": 6, "active_prompts": []}

    assert client.post("/api/interactive-segment/35/sync", json=payload).status_code == 200
    current["id"] = "account-b"
    assert client.post("/api/interactive-segment/35/sync", json=payload).status_code == 200

    assert len(seen_case_scopes) == 2
    assert seen_case_scopes[0] != seen_case_scopes[1]


@pytest.mark.parametrize("route_suffix", ["", "/sync"])
def test_other_account_cannot_use_upload_uuid_for_interactive_state(
    prompt_client, monkeypatch, route_suffix
):
    client, current, _image = prompt_client
    session_id = "12345678-1234-1234-1234-123456789abc"
    monkeypatch.setattr(routes, "_get_inference_job", lambda _sid: {"user_id": "account-a"})
    monkeypatch.setattr(role_store, "has_role", lambda *_args: False)
    current["id"] = "account-b"
    if route_suffix == "/sync":
        monkeypatch.setattr(nninteractive_predictor, "get_or_create_session", lambda *_args, **_kwargs: pytest.fail("model session must not be reached"))
        payload = {"res": "full", "segment_label": 6, "active_prompts": []}
    else:
        monkeypatch.setattr(nninteractive_predictor, "predict", lambda *_args, **_kwargs: pytest.fail("model must not be reached"))
        payload = {"res": "full", "segment_label": 6, "point_ijk": [0, 0, 0]}

    response = client.post(f"/api/interactive-segment/{session_id}{route_suffix}", json=payload)

    assert response.status_code == 403


def test_upload_owner_can_use_their_interactive_session(prompt_client, monkeypatch):
    client, _current, _image = prompt_client
    session_id = "12345678-1234-1234-1234-123456789abc"
    monkeypatch.setattr(routes, "_get_inference_job", lambda _sid: {"user_id": "account-a"})
    case_keys = []
    monkeypatch.setattr(
        nninteractive_predictor, "predict",
        lambda _ct, case_key, **_kwargs: (case_keys.append(case_key) or np.ones((2, 2, 2), dtype=np.uint8)),
    )

    response = client.post(
        f"/api/interactive-segment/{session_id}",
        json={"res": "full", "segment_label": 6, "point_ijk": [0, 0, 0]},
    )

    assert response.status_code == 200
    assert len(case_keys) == 1


def test_other_account_cannot_save_upload_uuid_segmentation(prompt_client, tmp_path, monkeypatch):
    client, current, _image = prompt_client
    session_id = "12345678-1234-1234-1234-123456789abc"
    mask_path = tmp_path / "combined_labels.nii.gz"
    original = np.zeros((2, 2, 2), dtype=np.uint8)
    nib.save(nib.Nifti1Image(original, np.eye(4)), mask_path)
    monkeypatch.setattr(routes, "_case_mask_path", lambda *_args, **_kwargs: str(mask_path))
    monkeypatch.setattr(routes, "_get_inference_job", lambda _sid: {"user_id": "account-a"})
    monkeypatch.setattr(role_store, "has_role", lambda *_args: False)
    current["id"] = "account-b"

    replacement = np.full((2, 2, 2), 7, dtype=np.uint8)
    response = client.post(
        f"/api/save-segmentation/{session_id}?res=full",
        data=gzip.compress(replacement.tobytes(order="F")),
        content_type="application/gzip",
    )

    assert response.status_code == 403
    np.testing.assert_array_equal(np.asanyarray(nib.load(mask_path).dataobj), original)


def test_upload_owner_can_save_their_segmentation(prompt_client, tmp_path, monkeypatch):
    client, _current, _image = prompt_client
    session_id = "12345678-1234-1234-1234-123456789abc"
    mask_path = tmp_path / "owned-combined_labels.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4)), mask_path)
    monkeypatch.setattr(routes, "_case_mask_path", lambda *_args, **_kwargs: str(mask_path))
    monkeypatch.setattr(routes, "_get_inference_job", lambda _sid: {"user_id": "account-a"})

    replacement = np.full((2, 2, 2), 7, dtype=np.uint8)
    response = client.post(
        f"/api/save-segmentation/{session_id}?res=full",
        data=gzip.compress(replacement.tobytes(order="F")),
        content_type="application/gzip",
    )

    assert response.status_code == 200
    np.testing.assert_array_equal(np.asanyarray(nib.load(mask_path).dataobj), replacement)
