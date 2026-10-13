import gzip
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
    monkeypatch.setenv("PANTS_LABELMAP_CACHE", str(tmp_path / "viewer-labels"))
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
    baseline = np.asanyarray(nib.load(routes._ai_local_mask_path("35")).dataobj)
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
    baseline = nib.load(routes._dataset_mask_for_viewer(routes._case_mask_path("35", low=True)))
    np.testing.assert_array_equal(np.asanyarray(baseline.dataobj), displayed)
    np.testing.assert_array_equal(baseline.affine, nib.load(low).affine)


def test_normalized_mount_is_not_remapped_again(dataset, monkeypatch):
    client, source, data, _ = dataset
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "viewer-v1")
    response = client.get("/api/get-segmentations/35.nii.gz")
    np.testing.assert_array_equal(response_labels(response), data)
    assert Path(routes._case_mask_path("35")) == source


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
