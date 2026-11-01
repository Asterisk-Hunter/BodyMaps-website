import gzip
import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as routes
from constants import Constants


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = tmp_path / "pants"
    mask_path = root / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"
    mask_path.parent.mkdir(parents=True)
    data = np.zeros((8, 8, 8), dtype=np.uint8)
    data[2:6, 2:6, 2:6] = 25
    nib.save(nib.Nifti1Image(data, np.diag([0.75, 0.75, 5, 1])), mask_path)
    monkeypatch.setattr(Constants, "PANTS_PATH", str(root))
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "ipantsmini-v1", raising=False)
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "LOWRES_ROOT", str(tmp_path / "lowres"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), data, tmp_path


def _save(client, edited, resolution):
    response = client.post(
        f"/api/save-segmentation/35?res={resolution}",
        data=gzip.compress(edited.tobytes(order="F")),
    )
    assert response.status_code == 200, response.get_json()


def test_saved_full_mask_requires_http_revalidation(client):
    client, data, tmp_path = client
    edited = data.copy()
    edited[0, 0, 0] = 99
    _save(client, edited, "full")

    full_response = client.get("/api/get-segmentations/35.nii.gz")
    assert full_response.status_code == 200
    assert full_response.headers["Cache-Control"] == "no-cache"


def test_saved_low_preview_requires_http_revalidation(client):
    client, data, tmp_path = client
    low_path = tmp_path / "lowres" / "mask_only" / "PanTS_00000035" / "combined_labels_lowres.nii.gz"
    low_path.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(data[::2, ::2, ::2], np.diag([1.5, 1.5, 10, 1])), low_path)
    low_edited = data[::2, ::2, ::2].copy()
    low_edited[0, 0, 0] = 99
    _save(client, low_edited, "low")

    preview_response = client.get("/api/get-segmentations/35.nii.gz?res=low")
    assert preview_response.status_code == 200
    assert preview_response.headers["Cache-Control"] == "no-cache"
