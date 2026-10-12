"""CancerVerse tumor masks through the real routes: the mask, its 3D meshes, and the unchanged cases.

CancerVerse has tumor masks only, for the scans with an annotated tumor, built into the overlay by
scripts/build_cancerverse_masks.py. These tests lay such an overlay down and call the API.

api.api_blueprint has import-time side effects (it creates directories from env-configured paths),
so the fixture points every path at a temp dir before the import. The module is imported once per
pytest process: run this file as its own step, as ci.yml does.
"""
import importlib
import os

import nibabel as nib
import numpy as np
import pytest

pytest.importorskip("asgiref")      # get-segmentations is an `async def` route
pytest.importorskip("trimesh")
pytest.importorskip("skimage")

CASE = "CV_00000007"          # has a tumor mask: liver (33) and stomach (36)
NO_MASK = "CV_00000008"       # in the library, no annotated tumor


def _label_volume():
    data = np.zeros((48, 44, 40), dtype=np.uint8)
    data[8:24, 10:30, 10:30] = 33
    data[30:42, 10:24, 10:24] = 36
    return data


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("cv_masks")
    overlay = base / "overlay"
    for var, value in [
        ("DATABASE_URL", f"sqlite:///{base / 'cv.db'}"),
        ("PANTS_PATH", str(base / "data")),
        ("PANTS_LOWRES_PATH", str(base / "lowres")),
        ("PERMISSIONS_DIR", str(base / "perm")),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", str(base / "chunks")),
        ("CANCERVERSE_OVERLAY_PATH", str(overlay)),
        ("MOUNT_GUARD", "0"),
    ]:
        os.environ[var] = value

    mask_dir = overlay / "mask_only" / CASE
    mask_dir.mkdir(parents=True)
    affine = np.array([[-0.8, 0, 0, 120.0], [0, -0.8, 0, 90.0], [0, 0, 2.0, -300.0], [0, 0, 0, 1.0]])
    image = nib.Nifti1Image(_label_volume(), affine)
    image.set_data_dtype(np.uint8)
    nib.save(image, str(mask_dir / "combined_labels.nii.gz"))

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.api_blueprint as api_bp           # heavy; imported once

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    flask_app = Flask(__name__)
    flask_app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    flask_app.register_blueprint(api_bp.api_blueprint, url_prefix="/api")
    return {"app": flask_app, "api": api_bp, "base": base, "overlay": overlay,
            "mask": mask_dir / "combined_labels.nii.gz"}


@pytest.fixture()
def client(env):
    return env["app"].test_client()


# ------------------------------------------------------------------------------- the mask itself
def test_the_tumor_mask_is_served_as_the_scans_segmentation(env, client):
    resp = client.get(f"/api/get-segmentations/{CASE}.nii.gz")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"].startswith("application/gzip")
    assert resp.get_data() == env["mask"].read_bytes()
    assert resp.headers["Cache-Control"] == "public, no-cache", "a rebuilt mask must be revalidated"


def test_a_scan_without_a_mask_still_gets_the_graceful_no_masks_answer(client):
    resp = client.get(f"/api/get-segmentations/{NO_MASK}.nii.gz")
    assert resp.status_code == 200
    assert resp.get_json() == {"masks_available": False}


def test_a_malformed_cancerverse_id_is_not_an_error(client):
    resp = client.get("/api/get-segmentations/CV_abc.nii.gz")
    assert resp.status_code == 200 and resp.get_json() == {"masks_available": False}


def test_the_mask_is_served_while_the_dataset_mount_is_down(env, client):
    """The mask lives in the overlay on local disk, so a storage outage does not take it away."""
    from services import mount_health as mh
    mon = mh.MountMonitor(["/x"], probe=lambda p: True)
    mon._down = True
    mh.reset_for_tests(mon)
    try:
        assert client.get(f"/api/get-segmentations/{CASE}.nii.gz").status_code == 200
        assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    finally:
        mh.reset_for_tests(None)


def test_case_paths_report_the_mask(env):
    from api.utils import get_case_nifti_paths
    with_mask = get_case_nifti_paths(CASE)
    assert with_mask["masks_available"] is True and with_mask["mask"].endswith("combined_labels.nii.gz")
    without = get_case_nifti_paths(NO_MASK)
    assert without["masks_available"] is False and without["mask"] is None


def test_pants_segmentations_are_unchanged(env, client, monkeypatch):
    """A PanTS case still reads PANTS_PATH/mask_only (here: absent -> the route's own error, not ours)."""
    resp = client.get("/api/get-segmentations/17.nii.gz")
    assert resp.status_code != 200 or resp.get_json(silent=True) != {"masks_available": False}


# ------------------------------------------------------------------------------------- 3D meshes
def test_meshes_of_the_tumors_are_baked_from_the_mask(env, client):
    resp = client.get(f"/api/cases/{CASE}/mesh-manifest")
    assert resp.status_code == 200, resp.get_data(as_text=True)[:300]
    manifest = resp.get_json()
    assert manifest["caseId"] == CASE and manifest["bounds"] and manifest["center"]
    assert {o["key"] for o in manifest["organs"]} == {"liver_lesion", "stomach_lesion"}
    assert {o["id"] for o in manifest["organs"]} == {33, 36}
    for organ in manifest["organs"]:
        assert organ["url"] == f"/api/cases/{CASE}/render_only/{organ['key']}.glb"
        glb = client.get(organ["url"])
        assert glb.status_code == 200 and glb.headers["Content-Type"] == "model/gltf-binary"
        assert glb.get_data()[:4] == b"glTF"


def test_baked_meshes_are_cached_and_rebaked_when_the_mask_is_rebuilt(env, client):
    from constants import Constants
    manifest_path = os.path.join(Constants.MESH_PATH, CASE, "manifest.json")
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    first = os.path.getmtime(manifest_path)
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    assert os.path.getmtime(manifest_path) == first, "a second request must reuse the cached meshes"
    later = first + 100                                    # the mask is rebuilt after the meshes were baked
    os.utime(env["mask"], (later, later))
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    assert os.path.getmtime(manifest_path) > first, "a mask newer than the meshes must be re-meshed"


def test_a_missing_mesh_file_is_regenerated_from_the_mask(env, client):
    from constants import Constants
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    glb = os.path.join(Constants.MESH_PATH, CASE, "liver_lesion.glb")
    os.remove(glb)
    resp = client.get(f"/api/cases/{CASE}/render_only/liver_lesion.glb")
    assert resp.status_code == 200 and resp.get_data()[:4] == b"glTF"


def test_a_tumor_type_the_case_does_not_have_has_no_mesh(env, client):
    resp = client.get(f"/api/cases/{CASE}/render_only/spleen_lesion.glb")
    assert resp.status_code == 404


def test_a_case_without_a_mask_has_no_meshes(client):
    assert client.get(f"/api/cases/{NO_MASK}/mesh-manifest").status_code == 404
    assert client.get(f"/api/cases/{NO_MASK}/render_only/liver_lesion.glb").status_code == 404


def test_mesh_routes_still_refuse_malformed_ids(client):
    assert client.get("/api/cases/CV_12/render_only/liver_lesion.glb").status_code == 400
    assert client.get(f"/api/cases/{CASE}/render_only/../../etc.glb").status_code in (400, 404)
    assert client.get("/api/cases/CV_abc/mesh-manifest").status_code == 404


def test_pants_mesh_routes_are_unchanged(client):
    assert client.get("/api/cases/abc/mesh-manifest").status_code == 400            # numeric ids only
    assert client.get("/api/cases/PanTS_00000001/render_only/../x.glb").status_code in (400, 404)


# ------------------------------------------------------------ no exception text reaches the browser
SECRET = "secret /home/visitor/private/path Traceback"


def _fresh_case(env, name):
    """A case with a mask but no cached meshes, so the bake path runs."""
    import shutil
    folder = env["overlay"] / "mask_only" / name
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy(env["mask"], folder / "combined_labels.nii.gz")
    return name


def test_a_failed_bake_returns_a_fixed_message_not_the_exception(env, client, monkeypatch, capsys):
    case = _fresh_case(env, "CV_00000009")

    def boom(*args, **kwargs):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(env["api"], "bake_case_meshes", boom)
    resp = client.get(f"/api/cases/{case}/mesh-manifest")
    assert resp.status_code == 500
    assert resp.get_json() == {"error": "Mesh generation failed"}
    assert "secret" not in resp.get_data(as_text=True) and "/home/visitor" not in resp.get_data(as_text=True)
    assert SECRET in capsys.readouterr().out, "the cause must still be logged on the server"


def test_a_failed_regeneration_returns_a_fixed_message_not_the_exception(env, client, monkeypatch, capsys):
    from constants import Constants
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    os.remove(os.path.join(Constants.MESH_PATH, CASE, "liver_lesion.glb"))

    def boom(*args, **kwargs):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(env["api"], "generate_organ_glb_bytes", boom)
    resp = client.get(f"/api/cases/{CASE}/render_only/liver_lesion.glb")
    assert resp.status_code == 500
    assert resp.get_json() == {"error": "Mesh generation failed"}
    assert "secret" not in resp.get_data(as_text=True)
    assert SECRET in capsys.readouterr().out


def test_a_missing_tumor_type_says_so_without_the_exceptions_own_text(env, client, monkeypatch):
    from constants import Constants
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    glb = os.path.join(Constants.MESH_PATH, CASE, "liver_lesion.glb")
    os.remove(glb)

    def no_such(*args, **kwargs):
        raise ValueError(SECRET)

    monkeypatch.setattr(env["api"], "generate_organ_glb_bytes", no_such)
    resp = client.get(f"/api/cases/{CASE}/render_only/liver_lesion.glb")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "This scan has no such tumor type"}
    assert "secret" not in resp.get_data(as_text=True)
