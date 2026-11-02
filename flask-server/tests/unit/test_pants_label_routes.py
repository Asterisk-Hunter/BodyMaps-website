import base64
import gzip
import json
import os
from collections import OrderedDict
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as routes
from constants import Constants


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    import api.auth as auth

    user = {"id": "label-route-test-user", "email": "label-route-test@example.test"}
    monkeypatch.setattr(auth, "current_user", lambda: user.copy())
    monkeypatch.setattr(routes, "current_user", lambda: user.copy())
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


def test_anonymous_dataset_save_is_rejected(dataset, monkeypatch):
    import api.auth as auth

    client, _source, data, _ = dataset
    monkeypatch.setattr(auth, "current_user", lambda: None)
    monkeypatch.setattr(routes, "current_user", lambda: None)

    response = client.post(
        "/api/save-segmentation/35?res=full",
        data=gzip.compress(data.tobytes(order="F")),
    )

    assert response.status_code == 401


def test_interactive_ct_prefers_the_viewers_low_resolution_grid(dataset):
    _, _, _, tmp_path = dataset
    low_ct = tmp_path / "lowres" / "image_only" / "PanTS_00000035" / "ct_lowres.nii.gz"
    low_ct.parent.mkdir(parents=True)
    low_ct.write_bytes(b"low-resolution fixture")
    assert Path(routes._case_ct_path("35", low=True)) == low_ct
    low_ct.unlink()
    assert routes._case_ct_path("35", low=True) == routes._case_ct_path("35", low=False)


def test_custom_structures_and_voxels_roundtrip_with_conflict_detection(dataset):
    client, source, _, _ = dataset
    original = source.read_bytes()
    metadata = client.get("/api/segmentation-metadata/35").get_json()
    labels = response_labels(client.get("/api/get-segmentations/35.nii.gz")).copy()
    labels[0, 0, 0] = 80
    structures = {"80": {"name": "My target", "color": [12, 34, 56, 255]}}
    headers = {"If-Match": metadata["revision"], "X-Labelmap-Metadata": json.dumps(structures)}
    response = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(labels.tobytes(order="F")), headers=headers)
    assert response.status_code == 200
    revision = response.get_json()["revision"]
    loaded = client.get("/api/segmentation-metadata/35").get_json()
    assert loaded == {"custom_structures": structures, "revision": revision}
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), labels)
    conflict = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(np.zeros_like(labels).tobytes(order="F")), headers=headers)
    assert conflict.status_code == 409
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), labels)
    assert source.read_bytes() == original


@pytest.mark.parametrize("structures", [{"256": {"name": "Bad", "color": [0, 0, 0, 255]}}, {"80": {"name": "", "color": [0, 0, 0, 255]}}, {"80": {"name": "Bad", "color": [999, 0, 0, 255]}}])
def test_invalid_custom_metadata_cannot_overwrite_saved_mask(dataset, structures):
    client, source, _, _ = dataset
    labels = response_labels(client.get("/api/get-segmentations/35.nii.gz"))
    original = source.read_bytes()
    response = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(labels.tobytes(order="F")), headers={"X-Labelmap-Metadata": json.dumps(structures)})
    assert response.status_code == 400
    assert source.read_bytes() == original


def test_two_tabs_cannot_both_save_the_same_revision(dataset):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    client, _, _, _ = dataset
    revision = client.get("/api/segmentation-metadata/35").get_json()["revision"]
    labels = response_labels(client.get("/api/get-segmentations/35.nii.gz"))
    barrier = Barrier(2)

    def save(case_id, label):
        proposal = labels.copy()
        proposal[0, 0, 0] = label
        with client.application.test_client() as tab:
            barrier.wait(timeout=10)
            return tab.post(f"/api/save-segmentation/{case_id}?res=full", data=gzip.compress(proposal.tobytes(order="F")), headers={"If-Match": revision}).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(save, "35", 80)
        second = pool.submit(save, "00035", 81)
        assert sorted([first.result(timeout=20), second.result(timeout=20)]) == [200, 409]


def test_other_datasets_without_saved_metadata_do_not_break_viewer_loading(dataset):
    client, _, _, _ = dataset
    assert client.get("/api/segmentation-metadata/CV_00000001").status_code == 404
    assert client.get("/api/segmentation-metadata/BDMAP_00000001").status_code == 404


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
    monkeypatch.setattr(routes, "_AI_METRICS_CACHE", OrderedDict())
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
    response = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(edited.tobytes(order="F")))
    assert response.status_code == 200, response.get_json()
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), edited)
    # Resolve the model baseline in the same authenticated request context as
    # the viewer; outside a request there is intentionally no account scope.
    with client:
        client.get("/api/get-segmentations/35.nii.gz")
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
    response = client.post("/api/save-segmentation/35?res=low", data=gzip.compress(edited.tobytes(order="F")))
    assert response.status_code == 200
    master = response_labels(client.get("/api/get-segmentations/35.nii.gz"))
    assert master.shape == data.shape
    assert master[2, 2, 2] == 99
    with client:
        client.get("/api/get-segmentations/35.nii.gz?res=low")
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


def test_save_uses_live_volume_geometry_when_slices_are_reversed(dataset):
    client, source, _, _ = dataset
    reference = nib.load(routes._case_mask_path("35"))
    expected = np.asanyarray(reference.dataobj).copy()
    expected[3, 9, 17] = 14
    # Cornerstone may sort the slice stack in the opposite direction to the file.
    lps_affine = np.diag([-1., -1., 1., 1.]) @ reference.affine
    lps_affine[:3, 3] += lps_affine[:3, 2] * (expected.shape[2] - 1)
    lps_affine[:3, 2] *= -1
    spacing = np.linalg.norm(lps_affine[:3, :3], axis=0)
    geometry = {"dimensions": list(expected.shape), "spacing": spacing.tolist(),
                "origin": lps_affine[:3, 3].tolist(),
                "direction": (lps_affine[:3, :3] / spacing).flatten(order="F").tolist()}
    response = client.post("/api/save-segmentation/35?res=full", headers={
        "X-Labelmap-Geometry": json.dumps(geometry)},
        data=gzip.compress(expected[:, :, ::-1].tobytes(order="F")))
    assert response.status_code == 200, response.get_json()
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), expected)
    np.testing.assert_array_equal(nib.load(routes._case_mask_path("35")).affine, reference.affine)


def test_bad_save_geometry_leaves_previous_mask_intact(dataset):
    client, _, _, _ = dataset
    original = client.get("/api/get-segmentations/35.nii.gz").data
    geometry = {"dimensions": [20, 20, 20], "spacing": [1, 1, 0],
                "origin": [0, 0, 0], "direction": np.eye(3).flatten().tolist()}
    response = client.post("/api/save-segmentation/35", headers={
        "X-Labelmap-Geometry": json.dumps(geometry)}, data=gzip.compress(bytes(8000)))
    assert response.status_code == 400
    assert client.get("/api/get-segmentations/35.nii.gz").data == original
    assert not Path(routes._pants_edited_mask_path("35")).exists()


def test_repeated_save_while_previous_mask_response_is_open(dataset):
    client, _, data, _ = dataset
    edited = data.copy()
    first = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(edited.tobytes(order="F")))
    assert first.status_code == 200
    # An in-flight browser download must not lock the master against later saves.
    previous_response = client.get("/api/get-segmentations/35.nii.gz", buffered=False)
    try:
        edited[3, 9, 17] = 14
        second = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(edited.tobytes(order="F")))
        assert second.status_code == 200, second.get_json()
    finally:
        previous_response.close()
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), edited)


def test_save_success_does_not_depend_on_windows_console_encoding(dataset, monkeypatch):
    import io
    import sys
    client, _, data, _ = dataset
    console = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict")
    with monkeypatch.context() as patch:
        patch.setattr(sys, "stdout", console)
        response = client.post("/api/save-segmentation/35?res=full", data=gzip.compress(data.tobytes(order="F")))
    assert response.status_code == 200, response.get_json()


def test_save_rejects_foreign_geometry_before_it_can_erase_the_mask(dataset):
    client, _, _, _ = dataset
    reference = nib.load(routes._case_mask_path("35"))
    geometry = {"dimensions": list(reference.shape), "spacing": [0.75, 0.75, 5],
                "origin": [1000, 1000, 1000], "direction": [-1, 0, 0, 0, -1, 0, 0, 0, 1]}
    response = client.post("/api/save-segmentation/35?res=full", headers={
        "X-Labelmap-Geometry": json.dumps(geometry)}, data=gzip.compress(bytes(8000)))
    assert response.status_code == 400
    assert not Path(routes._pants_edited_mask_path("35")).exists()


def test_save_rejects_corrupt_gzip_without_overwriting(dataset):
    client, _, _, _ = dataset
    # Same byte count as the reference so invalid gzip cannot be mistaken for raw labels.
    response = client.post("/api/save-segmentation/35?res=full", data=b"\x1f\x8b" + bytes(7998))
    assert response.status_code == 400
    assert not Path(routes._pants_edited_mask_path("35")).exists()


def test_low_save_preserves_untouched_full_resolution_detail(dataset):
    client, source, data, tmp_path = dataset
    source_image = nib.load(source)
    detailed = data.copy()
    detailed[9, 9, 9] = 14  # small structure absent from a [::2] preview
    nib.save(nib.Nifti1Image(detailed, source_image.affine), source)
    low_path = tmp_path / "lowres" / "mask_only" / "PanTS_00000035" / "combined_labels_lowres.nii.gz"
    low_path.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(detailed[::2, ::2, ::2], np.diag([1.5, 1.5, 10, 1])), low_path)
    edited = response_labels(client.get("/api/get-segmentations/35.nii.gz?res=low")).copy()
    edited[0, 0, 0] = 99
    response = client.post("/api/save-segmentation/35?res=low", data=gzip.compress(edited.tobytes(order="F")))
    assert response.status_code == 200
    saved = response_labels(client.get("/api/get-segmentations/35.nii.gz"))
    assert saved[9, 9, 9] == 14
    assert saved[0, 0, 0] == 99
    assert response.get_json()["labelled_voxels"] == int(np.count_nonzero(saved))


def test_catalog_saves_and_meshes_are_private_to_each_account(dataset, monkeypatch):
    client, source, _, _ = dataset
    current = {"id": "account-a"}
    monkeypatch.setattr(routes, "current_user", lambda: current.copy())
    original = source.read_bytes()
    a = response_labels(client.get("/api/get-segmentations/35.nii.gz")).copy()
    a[0, 0, 0] = 14
    assert client.post("/api/save-segmentation/35?res=full", data=gzip.compress(a.tobytes(order="F"))).status_code == 200
    a_manifest = client.get("/api/cases/35/mesh-manifest").get_json()
    assert 14 in {organ["id"] for organ in a_manifest["organs"]}
    a_liver_url = next(organ["url"] for organ in a_manifest["organs"] if organ["id"] == 14)
    current["id"] = "account-b"
    b = response_labels(client.get("/api/get-segmentations/35.nii.gz")).copy()
    assert b[0, 0, 0] == 0
    b[0, 0, 0] = 3
    assert client.post("/api/save-segmentation/35?res=full", data=gzip.compress(b.tobytes(order="F"))).status_code == 200
    assert 14 not in {organ["id"] for organ in client.get("/api/cases/35/mesh-manifest").get_json()["organs"]}
    assert client.get(a_liver_url).status_code == 404
    current["id"] = "account-a"
    np.testing.assert_array_equal(response_labels(client.get("/api/get-segmentations/35.nii.gz")), a)
    assert 14 in {organ["id"] for organ in client.get("/api/cases/35/mesh-manifest").get_json()["organs"]}
    assert source.read_bytes() == original


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


@pytest.mark.parametrize("prompt", [
    {"point_ijk": [4, 4, 4], "is_positive": False},
    {"point_ijk": [4, 4, 4], "initial_seg_gz_b64": "seed"},
    {"point_ijk": [4, 4, 4], "scribble_mask": "stroke", "scribble_bbox": [[3, 5], [3, 5], [3, 4]]},
    {"point_ijk": [4, 4, 4], "lasso_mask": "stroke", "lasso_bbox": [[3, 5], [3, 5], [3, 4]]},
])
def test_model_only_prompts_are_refused_when_nninteractive_is_disabled(dataset, monkeypatch, prompt):
    client, source, _labels, tmp_path = dataset
    import services.advanced_analysis as analysis

    image_path = tmp_path / "pants" / "image_only" / "PanTS_00000035" / "ct.nii.gz"
    image_path.parent.mkdir(parents=True)
    reference = nib.load(source)
    ct = np.zeros(reference.shape, dtype=np.float32)
    nib.save(nib.Nifti1Image(ct, reference.affine), image_path)
    monkeypatch.setattr(analysis, "USE_NNINTERACTIVE", False)
    monkeypatch.setattr(
        analysis,
        "segment_from_prompt",
        lambda *_args, **_kwargs: pytest.fail("model-only prompt fell back to region growing"),
    )
    if prompt.get("initial_seg_gz_b64"):
        seed = np.zeros(reference.shape, dtype=np.uint8)
        seed[4, 4, 4] = 1
        prompt = {**prompt, "initial_seg_gz_b64": base64.b64encode(
            gzip.compress(seed.tobytes(order="F"))
        ).decode("ascii")}

    response = client.post("/api/interactive-segment/35", json={"res": "full", **prompt})

    assert response.status_code == 503
    assert "interactive model" in response.get_json()["error"].lower()
