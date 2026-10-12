"""Updated CancerVerse scans live in a writable overlay: serving, caching, thumbnails, previews."""
import os
import sys

import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as api_routes
import api.utils as u
from constants import Constants

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

APP = Flask(__name__)
CASE = "CV_00000007"


def touch(path, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path)


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    root, overlay, lowres = tmp_path / "CancerVerse", tmp_path / "overlay", tmp_path / "cv_lowres"
    monkeypatch.setattr(Constants, "CANCERVERSE_PATH", str(root))
    monkeypatch.setattr(Constants, "CANCERVERSE_OVERLAY_PATH", str(overlay))
    monkeypatch.setattr(Constants, "CANCERVERSE_LOWRES_PATH", str(lowres))
    monkeypatch.setenv("BODYMAPS_ACCEL_REDIRECT_ENABLED", "true")
    return root, overlay, lowres


def serve(path):
    with APP.test_request_context("/"):
        return api_routes._serve_dataset_volume(path)


def test_overlay_cts_are_offloaded_to_nginx_through_their_own_internal_location(dirs):
    root, overlay, _ = dirs
    new = touch(overlay / "image_only" / CASE / "ct.nii.gz")
    old = touch(root / "image_only" / "CV_00000001" / "ct.nii.gz")
    assert serve(new).headers["X-Accel-Redirect"] == f"/_bodymaps_volume_cancerverse_overlay/image_only/{CASE}/ct.nii.gz"
    assert serve(old).headers["X-Accel-Redirect"] == "/_bodymaps_volume_cancerverse/image_only/CV_00000001/ct.nii.gz"


def test_the_nginx_config_defines_every_internal_location_the_app_can_redirect_to():
    conf = open(os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "nginx-bodymaps.conf"), encoding="utf-8").read()
    for prefix in ("_bodymaps_volume_lowres", "_bodymaps_volume_pants", "_bodymaps_volume_cancerverse_lowres",
                   "_bodymaps_volume_cancerverse_overlay", "_bodymaps_volume_cancerverse"):
        assert f"location ^~ /{prefix}/ {{" in conf, prefix


def test_overlay_cts_are_revalidated_but_dataset_cts_stay_immutable(dirs):
    """An updated scan replaces a file at the same URL, so a 7-day immutable copy would show the old CT."""
    root, overlay, _ = dirs
    new = touch(overlay / "image_only" / CASE / "ct.nii.gz")
    old = touch(root / "image_only" / "CV_00000001" / "ct.nii.gz")
    assert serve(new).headers["Cache-Control"] == "public, no-cache"
    assert serve(old).headers["Cache-Control"] == "public, max-age=604800, immutable"
    assert serve(new).headers["Cross-Origin-Resource-Policy"] == "cross-origin"


def test_overlay_cts_are_revalidated_without_nginx_too(dirs, monkeypatch):
    monkeypatch.setenv("BODYMAPS_ACCEL_REDIRECT_ENABLED", "false")
    _, overlay, _ = dirs
    response = serve(touch(overlay / "image_only" / CASE / "ct.nii.gz"))
    assert "X-Accel-Redirect" not in response.headers
    assert response.headers["Cache-Control"] == "public, no-cache"


def test_a_replaced_scan_never_uses_the_lowres_copy_made_from_the_old_ct(dirs):
    root, overlay, lowres = dirs
    stale = touch(lowres / "image_only" / CASE / "ct_lowres.nii.gz")
    touch(root / "image_only" / CASE / "ct.nii.gz")
    before = u.get_case_nifti_paths(CASE)
    assert os.path.normpath(before["lowres_image"]) == os.path.normpath(stale)    # untouched scan: as before

    touch(overlay / "image_only" / CASE / "ct.nii.gz")                                    # the scan was updated
    after = u.get_case_nifti_paths(CASE)
    assert after["image"].startswith(str(overlay))
    assert os.path.normpath(after["lowres_image"]) != os.path.normpath(stale) and not os.path.exists(after["lowres_image"])   # -> full resolution is served


def test_untouched_scans_keep_their_dataset_paths(dirs):
    root, _, lowres = dirs
    ct = touch(root / "image_only" / "CV_00000001" / "ct.nii.gz")
    paths = u.get_case_nifti_paths("CV_00000001")
    assert paths["image"] == ct
    assert paths["lowres_image"] == f"{lowres}/image_only/CV_00000001/ct_lowres.nii.gz"


def preview(case_id):
    with APP.test_request_context("/"):
        response = api_routes.get_image_preview(case_id)
        if isinstance(response, tuple):                       # (json body, status) for an error
            return response
        response.direct_passthrough = False
        return response


def test_thumbnails_come_from_the_overlay_first_and_new_ones_revalidate(dirs):
    root, overlay, _ = dirs
    touch(root / "profile_only" / "CV_00000001" / "profile.jpg", b"old dataset thumb")
    touch(overlay / "profile_only" / "CV_00000001" / "profile.jpg", b"new overlay thumb")
    touch(root / "profile_only" / "CV_00000002" / "profile.jpg", b"dataset only thumb")
    updated, untouched = preview("CV_00000001"), preview("CV_00000002")
    assert updated.get_data() == b"new overlay thumb" and updated.headers["Cache-Control"] == "public, no-cache"
    assert untouched.get_data() == b"dataset only thumb"
    assert untouched.headers["Cache-Control"] == "public, max-age=31536000, immutable"


def test_a_scan_without_any_thumbnail_is_a_404_not_a_crash(dirs):
    response = preview("CV_00000099")
    status = response[1] if isinstance(response, tuple) else response.status_code
    assert status == 404


# ---------------------------------------------------------------- thumbnail script
def test_previews_can_be_drawn_for_the_staged_scans_into_the_overlay(tmp_path):
    nib = pytest.importorskip("nibabel")
    pytest.importorskip("PIL")
    import make_profile_previews as mpp

    overlay = tmp_path / "overlay"
    ct = overlay / "image_only" / CASE / "ct.nii.gz"
    ct.parent.mkdir(parents=True)
    volume = np.random.default_rng(0).integers(-500, 1500, size=(24, 20, 16)).astype(np.int16)
    nib.save(nib.Nifti1Image(volume, np.eye(4)), str(ct))

    assert mpp._process_case(str(ct), str(overlay), overwrite=False) == "ok"
    out = overlay / "profile_only" / CASE / "profile.jpg"
    assert out.exists() and out.stat().st_size > 0
    assert mpp._process_case(str(ct), str(overlay), overwrite=False) == "skip"           # re-runs resume
