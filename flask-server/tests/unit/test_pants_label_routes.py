import gzip
import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as routes
from constants import Constants


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    root = tmp_path / "pants"
    mask_path = root / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"
    mask_path.parent.mkdir(parents=True)
    data = np.zeros((20, 20, 20), dtype=np.uint8)
    data[2:8, 2:8, 2:8] = 25  # named source stomach
    data[12:16, 2:6, 2:6] = 26  # named source SMA
    data[12:16, 12:16, 12:16] = 28  # named source pancreatic lesion
    nib.save(nib.Nifti1Image(data, np.diag([0.75, 0.75, 5, 1])), mask_path)
    monkeypatch.setattr(Constants, "PANTS_PATH", str(root))
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "ipantsmini-v1", raising=False)
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "LOWRES_ROOT", str(tmp_path / "lowres"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), mask_path, data, tmp_path


def response_labels(response):
    return np.asanyarray(nib.Nifti1Image.from_bytes(gzip.decompress(response.data)).dataobj)


def test_overlay_and_ai_baseline_use_viewer_labels_without_changing_source(dataset):
    client, source, data, _ = dataset
    original = source.read_bytes()
    response = client.get("/api/get-segmentations/35.nii.gz")
    assert response.status_code == 200
    displayed = response_labels(response)
    np.testing.assert_array_equal(displayed == 26, data == 25)
    np.testing.assert_array_equal(displayed == 27, data == 26)
    np.testing.assert_array_equal(displayed == 22, data == 28)
    baseline = np.asanyarray(nib.load(routes._case_mask_path("35")).dataobj)
    np.testing.assert_array_equal(baseline, displayed)
    assert source.read_bytes() == original


def test_low_resolution_overlay_and_baseline_share_the_same_schema(dataset):
    client, source, _, tmp_path = dataset
    low = tmp_path / "lowres" / "mask_only" / "PanTS_00000035" / "combined_labels_lowres.nii.gz"
    low.parent.mkdir(parents=True)
    image = nib.load(source)
    low_data = np.asanyarray(image.dataobj)[::2, ::2, ::2]
    nib.save(nib.Nifti1Image(low_data, np.diag([1.5, 1.5, 10, 1])), low)
    response = client.get("/api/get-segmentations/35.nii.gz?res=low")
    assert response.status_code == 200
    displayed = response_labels(response)
    np.testing.assert_array_equal(displayed == 26, low_data == 25)
    baseline = nib.load(routes._case_mask_path("35", low=True))
    np.testing.assert_array_equal(np.asanyarray(baseline.dataobj), displayed)
    np.testing.assert_array_equal(baseline.affine, nib.load(low).affine)


def test_normalized_mount_is_not_remapped_again(dataset, monkeypatch):
    client, source, data, _ = dataset
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "viewer-v1")
    response = client.get("/api/get-segmentations/35.nii.gz")
    np.testing.assert_array_equal(response_labels(response), data)
    assert Path(routes._case_mask_path("35")) == source


def test_ai_measurements_do_not_use_precomputed_source_number_metrics(dataset, monkeypatch):
    client, _, _, _ = dataset
    monkeypatch.setattr(routes, "_ai_local_image_path", lambda *args: None)
    monkeypatch.setattr(routes, "_AI_METRICS_CACHE", {})
    monkeypatch.setattr(routes, "get_mask_data_internal", lambda *args: {"organ_metrics": [{"organ_name": "stomach", "volume_cm3": 999}]})
    response = client.post("/api/mask-data", data={"sessionKey": "35"})
    metrics, _ = routes._ai_load_metrics("35", [])
    for entries in [response.get_json()["organ_metrics"], metrics]:
        stomach = next(entry for entry in entries if entry["organ_name"] == "stomach")
        assert stomach["volume_cm3"] == 0.61


def test_huggingface_fallback_is_normalized_at_the_backend_boundary(dataset, monkeypatch):
    client, source, data, _ = dataset
    monkeypatch.setattr(Constants, "PANTS_PATH", None)
    monkeypatch.setattr(routes, "_ai_download_case_file", lambda *args: str(source))
    response = client.get("/api/get-segmentations/35.nii.gz?source=hf")
    assert response.status_code == 200
    np.testing.assert_array_equal(response_labels(response) == 26, data == 25)


def test_mirror_mask_is_available_when_the_local_mount_is_down(dataset, monkeypatch):
    client, source, data, _ = dataset
    monkeypatch.setattr(routes, "mount_down_response", lambda: ({"error": "mount down"}, 503))
    monkeypatch.setattr(routes, "_ai_download_case_file", lambda *args: str(source))
    assert client.get("/api/get-segmentations/35.nii.gz").status_code == 503
    response = client.get("/api/get-segmentations/35.nii.gz?source=hf")
    assert response.status_code == 200
    np.testing.assert_array_equal(response_labels(response) == 26, data == 25)


def test_local_low_mask_keeps_working_during_a_source_mount_outage(dataset, monkeypatch):
    client, _, data, tmp_path = dataset
    low = tmp_path / "lowres" / "mask_only" / "PanTS_00000035" / "combined_labels_lowres.nii.gz"
    low.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(data[::2, ::2, ::2], np.diag([1.5, 1.5, 10, 1])), low)
    monkeypatch.setattr(routes, "mount_down_response", lambda: ({"error": "mount down"}, 503))
    response = client.get("/api/get-segmentations/35.nii.gz?res=low")
    assert response.status_code == 200
    np.testing.assert_array_equal(response_labels(response) == 26, data[::2, ::2, ::2] == 25)


def test_saved_viewer_edits_survive_reload_and_leave_quiz_source_intact(dataset):
    client, source, data, _ = dataset
    original = source.read_bytes()
    edited = data.copy()
    edited[data == 25] = 26
    edited[data == 26] = 27
    edited[data == 28] = 22
    edited[0, 0, 0] = 99  # a new custom viewer structure
    response = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(edited.tobytes()))
    assert response.status_code == 200, response.get_json()
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), edited)
    np.testing.assert_array_equal(np.asanyarray(nib.load(routes._case_mask_path("35")).dataobj), edited)
    assert source.read_bytes() == original
    assert int(np.count_nonzero(np.asanyarray(nib.load(source).dataobj) == 28)) == 64


def test_low_resolution_save_updates_full_master_and_preview_keeps_its_grid(dataset):
    client, source, data, tmp_path = dataset
    low = tmp_path / "lowres" / "mask_only" / "PanTS_00000035" / "combined_labels_lowres.nii.gz"
    low.parent.mkdir(parents=True)
    low_data = data[::2, ::2, ::2]
    nib.save(nib.Nifti1Image(low_data, np.diag([1.5, 1.5, 10, 1])), low)
    edited = response_labels(client.get("/api/get-segmentations/35.nii.gz?res=low")).copy()
    edited[1, 1, 1] = 99
    response = client.post("/api/save-segmentation/35?res=low", data=gzip.compress(edited.tobytes()))
    assert response.status_code == 200
    master = response_labels(client.get("/api/get-segmentations/35.nii.gz"))
    assert master.shape == data.shape
    assert master[2, 2, 2] == 99
    preview_path = routes._case_mask_path("35", low=True)
    preview = nib.load(preview_path)
    assert preview.shape == edited.shape
    np.testing.assert_array_equal(preview.affine, nib.load(low).affine)
    np.testing.assert_array_equal(np.asanyarray(preview.dataobj), edited)


def test_deleted_structure_cannot_be_served_from_an_obsolete_mesh_file(dataset):
    client, source, data, _ = dataset
    first = client.get("/api/cases/35/mesh-manifest").get_json()
    url = next(organ["url"] for organ in first["organs"] if organ["id"] == 27)
    data[data == 26] = 0
    nib.save(nib.Nifti1Image(data, nib.load(source).affine), source)
    updated = client.get("/api/cases/35/mesh-manifest").get_json()
    assert 27 not in {organ["id"] for organ in updated["organs"]}
    assert client.get(url).status_code == 404


def test_old_mesh_cache_is_rebuilt_even_if_its_timestamp_is_newer(dataset):
    client, _, _, _ = dataset
    cache = Path(Constants.MESH_PATH) / "PanTS_00000035"
    cache.mkdir(parents=True)
    manifest = cache / "manifest.json"
    manifest.write_text(json.dumps({"caseId": "PanTS_00000035", "organs": [{"id": 26, "key": "stomach"}]}))
    os.utime(manifest, (4_000_000_000, 4_000_000_000))
    response = client.get("/api/cases/35/mesh-manifest")
    assert response.status_code == 200
    result = response.get_json()
    assert {organ["id"] for organ in result["organs"]} == {22, 26, 27}
    assert result.get("labelmap_revision")


@pytest.mark.parametrize("viewer_label,source_label", [(26, 25), (22, 28)])
def test_prompt_and_undo_sync_share_correct_baseline_and_versioned_session(dataset, monkeypatch, viewer_label, source_label):
    client, source, data, _ = dataset
    image_dir = Path(Constants.PANTS_PATH) / "image_only" / "PanTS_00000035"
    image_dir.mkdir(parents=True)
    image = nib.load(source)
    nib.save(nib.Nifti1Image(np.zeros(data.shape, dtype=np.float32), image.affine), image_dir / "ct.nii.gz")
    monkeypatch.setattr(routes, "_load_ct_cached", lambda *args: (image, np.zeros(data.shape, dtype=np.float32)))
    from services import advanced_analysis, nninteractive_predictor
    monkeypatch.setattr(advanced_analysis, "USE_NNINTERACTIVE", True)
    calls = []

    def predict(ct, case_key, **kwargs):
        calls.append((case_key.rsplit(":", 1)[0], kwargs["baseline_mask"].copy()))
        return kwargs["baseline_mask"].copy()

    class Session:
        interaction_count = 0

        def reset(self, baseline_mask=None):
            self.mask = baseline_mask.copy()

        def get_result(self):
            return self.mask

    def get_session(case_id, label, resolution, ct, baseline_mask=None):
        calls.append((case_id, baseline_mask.copy()))
        return Session()

    monkeypatch.setattr(nninteractive_predictor, "predict", predict)
    monkeypatch.setattr(nninteractive_predictor, "get_or_create_session", get_session)
    payload = {"res": "full", "segment_label": viewer_label, "inject_baseline": True, "point_ijk": [3, 3, 3]}
    prompt = client.post("/api/interactive-segment/35", json=payload)
    sync = client.post("/api/interactive-segment/35/sync", json={**payload, "active_prompts": []})
    assert prompt.status_code == 200, prompt.get_json(silent=True)
    assert sync.status_code == 200, sync.get_json(silent=True)
    assert calls[0][0] == calls[1][0]
    assert "viewer-labels-r1" in calls[0][0]
    for _, baseline in calls:
        np.testing.assert_array_equal(baseline, data == source_label)
