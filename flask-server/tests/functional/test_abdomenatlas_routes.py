"""AbdomenAtlas through the real routes: the CT, the viewer mask, its 3D meshes, the thumbnail, the library.

AbdomenAtlas is the library's third dataset: PanTS-like folders on the dataset mount (the CT, the metadata
CSV) plus a writable overlay holding what the site builds from it (the viewer mask, thumbnails, low-res
copies). These tests lay both down and call the API.

api.api_blueprint has import-time side effects (it creates directories from env-configured paths and
reads the metadata files), so the fixture points every path at a temp dir before the import. The module
is imported once per pytest process: run this file as its own step, as ci.yml does.
"""
import importlib
import os

import nibabel as nib
import numpy as np
import pytest

pytest.importorskip("asgiref")      # get-segmentations is an `async def` route
pytest.importorskip("trimesh")
pytest.importorskip("skimage")

CASE = "BDMAP_00000007"        # CT on the mount, viewer mask built
NO_MASK = "BDMAP_00000008"     # CT on the mount, mask not built yet
NO_CT = "BDMAP_00000009"       # in the library, but its CT folder is unreadable / absent

CSV = (
    "BDMAP ID,spacing,shape,sex,age,scanner,contrast,number of liver lesion instances,"
    "number of pancreatic lesion instances,number of kidney lesion instances,number of colon lesion instances,"
    "narrative report\n"
    "BDMAP_00000007,[0.8 0.8 2.5],\"(48, 44, 40)\",F,51,siemens,Arterial,2.0,0.0,0.0,0.0,private findings\n"
    "BDMAP_00000008,[1.5 1.5 1.5],\"(48, 44, 40)\",M,62,philips,Plain,0.0,0.0,0.0,0.0,private findings\n"
    "BDMAP_00000009,[1.5 1.5 1.5],\"(48, 44, 40)\",M,,,Venous,0.0,4.0,0.0,0.0,private findings\n"
)


def _label_volume():
    data = np.zeros((48, 44, 40), dtype=np.uint8)
    data[6:26, 8:30, 8:30] = 14          # liver
    data[10:16, 12:18, 12:18] = 33       # liver lesion, inside the liver
    data[30:42, 10:24, 10:24] = 17       # pancreas
    return data


def _save(path, data, dtype=np.uint8):
    path.parent.mkdir(parents=True, exist_ok=True)
    affine = np.array([[-0.8, 0, 0, 120.0], [0, -0.8, 0, 90.0], [0, 0, 2.0, -300.0], [0, 0, 0, 1.0]])
    image = nib.Nifti1Image(data, affine)
    image.set_data_dtype(dtype)
    nib.save(image, str(path))


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("at_routes")
    data, overlay = base / "atlas", base / "overlay"
    for var, value in [
        ("DATABASE_URL", f"sqlite:///{base / 'at.db'}"),
        ("PANTS_PATH", str(base / "pants")),
        ("PANTS_LOWRES_PATH", str(base / "lowres")),
        ("PERMISSIONS_DIR", str(base / "perm")),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", str(base / "chunks")),
        ("ABDOMENATLAS_PATH", str(data)),
        ("ABDOMENATLAS_OVERLAY_PATH", str(overlay)),
        ("MOUNT_GUARD", "0"),
    ]:
        os.environ[var] = value
    os.environ.pop("ABDOMENATLAS_META_FILE", None)
    os.environ.pop("CANCERVERSE_PATH", None)
    os.environ.pop("CANCERVERSE_OVERLAY_PATH", None)

    data.mkdir(parents=True)
    (data / "AbdomenAtlas3.0MiniWithMeta.csv").write_text(CSV, encoding="utf-8")
    ct_array = np.random.default_rng(0).integers(-500, 500, size=(48, 44, 40)).astype(np.int16)
    for case in (CASE, NO_MASK):
        _save(data / "image_only" / case / "ct.nii.gz", ct_array, np.int16)
    _save(overlay / "mask_only" / CASE / "combined_labels.nii.gz", _label_volume())
    _save(overlay / "lowres" / "image_only" / CASE / "ct_lowres.nii.gz", ct_array[::2, ::2, ::2], np.int16)
    thumb = overlay / "profile_only" / CASE / "profile.jpg"
    thumb.parent.mkdir(parents=True)
    thumb.write_bytes(b"\xff\xd8\xff\xe0fake-jpeg")

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
    return {
        "app": flask_app, "api": api_bp, "base": base, "overlay": overlay, "data": data,
        "ct": data / "image_only" / CASE / "ct.nii.gz",
        "mask": overlay / "mask_only" / CASE / "combined_labels.nii.gz",
        "lowres": overlay / "lowres" / "image_only" / CASE / "ct_lowres.nii.gz",
        "thumb": thumb,
    }


@pytest.fixture()
def client(env):
    return env["app"].test_client()


def _mount_down():
    from services import mount_health as mh
    mon = mh.MountMonitor(["/x"], probe=lambda p: True)
    mon._down = True
    mh.reset_for_tests(mon)
    return mh


# --------------------------------------------------------------------------------------- the CT
def test_the_ct_is_served_from_the_dataset_folder(env, client):
    resp = client.get(f"/api/get-main-nifti/{CASE}.nii.gz")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"].startswith("application/gzip")
    assert resp.get_data() == env["ct"].read_bytes()
    assert "immutable" in resp.headers["Cache-Control"], "a dataset CT never changes at its URL"


def test_the_low_res_copy_is_served_only_when_asked_for_and_present(env, client):
    low = client.get(f"/api/get-main-nifti/{CASE}.nii.gz?res=low")
    assert low.status_code == 200 and low.get_data() == env["lowres"].read_bytes()
    assert low.headers["Cache-Control"] == "public, no-cache", "an overlay copy is revalidated"
    full = client.get(f"/api/get-main-nifti/{NO_MASK}.nii.gz?res=low")        # no low-res copy: full size
    assert full.status_code == 200
    assert full.get_data() == (env["data"] / "image_only" / NO_MASK / "ct.nii.gz").read_bytes()


def test_a_scan_whose_ct_is_missing_is_a_clean_404(client):
    resp = client.get(f"/api/get-main-nifti/{NO_CT}.nii.gz")
    assert resp.status_code == 404 and resp.get_json() == {"error": "Could not find filepath"}


def test_malformed_ids_are_refused_not_crashed_on(client):
    assert client.get("/api/get-main-nifti/BDMAP_abc.nii.gz").status_code == 400
    assert client.get("/api/get-main-nifti/BDMAP_.nii.gz").status_code == 400
    assert client.get("/api/get-main-nifti/..%2FBDMAP_00000007.nii.gz").status_code in (400, 404)


def test_the_ct_is_refused_while_the_dataset_mount_is_down_but_the_overlay_is_not(env, client):
    mh = _mount_down()
    try:
        assert client.get(f"/api/get-main-nifti/{CASE}.nii.gz").status_code == 503
        assert client.get(f"/api/get-segmentations/{CASE}.nii.gz").status_code == 200, "the mask is local disk"
        assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    finally:
        mh.reset_for_tests(None)


# -------------------------------------------------------------------------------------- the mask
def test_the_viewer_mask_is_served_as_the_scans_segmentation(env, client):
    resp = client.get(f"/api/get-segmentations/{CASE}.nii.gz")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"].startswith("application/gzip")
    assert resp.get_data() == env["mask"].read_bytes()
    assert resp.headers["Cache-Control"] == "public, no-cache", "a rebuilt mask must be revalidated"


def test_a_scan_whose_mask_is_not_built_yet_gets_the_graceful_no_masks_answer(client):
    for case in (NO_MASK, NO_CT, "BDMAP_abc"):
        resp = client.get(f"/api/get-segmentations/{case}.nii.gz")
        assert resp.status_code == 200 and resp.get_json() == {"masks_available": False}, case
    assert client.post(f"/api/get-specific-segmentations/{CASE}", data={"organs": "[]"}).get_json() == {
        "masks_available": False}


def test_case_paths_report_the_mask(env):
    from api.utils import get_case_nifti_paths
    with_mask = get_case_nifti_paths(CASE)
    assert with_mask["dataset"] == "AbdomenAtlas" and with_mask["folder_id"] == CASE
    assert with_mask["masks_available"] is True and with_mask["mask"] == str(env["mask"])
    assert with_mask["image"] == str(env["ct"]) and with_mask["lowres_image"] == str(env["lowres"])
    without = get_case_nifti_paths("bdmap_8")
    assert without["folder_id"] == NO_MASK
    assert without["masks_available"] is False and without["mask"] is None


def test_other_datasets_are_unchanged(env, client):
    """A PanTS case still reads PANTS_PATH (absent here -> the route's own error, not the Atlas answer)."""
    resp = client.get("/api/get-segmentations/17.nii.gz")
    assert resp.status_code != 200 or resp.get_json(silent=True) != {"masks_available": False}
    cv = client.get("/api/get-segmentations/CV_00000001.nii.gz")                # CancerVerse, no overlay set
    assert cv.status_code == 200 and cv.get_json() == {"masks_available": False}


# ---------------------------------------------------------------------------------- the thumbnail
def test_the_card_thumbnail_comes_from_the_overlay(env, client):
    resp = client.get(f"/api/get_image_preview/{CASE}")
    assert resp.status_code == 200 and resp.get_data() == env["thumb"].read_bytes()
    assert resp.headers["Cache-Control"] == "public, no-cache", "a redrawn thumbnail must be revalidated"
    assert client.get(f"/api/get_image_preview/{NO_MASK}").status_code == 404


# ------------------------------------------------------------------------------------- 3D meshes
def test_organ_meshes_are_baked_from_the_mask(env, client):
    resp = client.get(f"/api/cases/{CASE}/mesh-manifest")
    assert resp.status_code == 200, resp.get_data(as_text=True)[:300]
    manifest = resp.get_json()
    assert manifest["caseId"] == CASE and manifest["bounds"] and manifest["center"]
    assert {o["key"] for o in manifest["organs"]} == {"liver", "liver_lesion", "pancreas"}
    assert {o["id"] for o in manifest["organs"]} == {14, 33, 17}
    for organ in manifest["organs"]:
        assert organ["url"].split("?", 1)[0] == f"/api/cases/{CASE}/render_only/{organ['key']}.glb"
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
    os.remove(os.path.join(Constants.MESH_PATH, CASE, "liver.glb"))
    resp = client.get(f"/api/cases/{CASE}/render_only/liver.glb")
    assert resp.status_code == 200 and resp.get_data()[:4] == b"glTF"


def test_a_structure_the_case_does_not_have_has_no_mesh(client):
    assert client.get(f"/api/cases/{CASE}/render_only/spleen.glb").status_code == 404


def test_a_case_without_a_mask_has_no_meshes(client):
    assert client.get(f"/api/cases/{NO_MASK}/mesh-manifest").status_code == 404
    assert client.get(f"/api/cases/{NO_MASK}/render_only/liver.glb").status_code == 404


def test_mesh_routes_still_refuse_malformed_ids(client):
    assert client.get("/api/cases/BDMAP_12/render_only/liver.glb").status_code == 400
    assert client.get(f"/api/cases/{CASE}/render_only/../../etc.glb").status_code in (400, 404)
    assert client.get("/api/cases/BDMAP_abc/mesh-manifest").status_code == 404


# -------------------------------------------------------- no exception text reaches the browser
SECRET = "secret /home/visitor/private/path Traceback"


def test_a_failed_bake_returns_a_fixed_message_not_the_exception(env, client, monkeypatch, capsys):
    import shutil
    case = "BDMAP_00000010"
    folder = env["overlay"] / "mask_only" / case
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy(env["mask"], folder / "combined_labels.nii.gz")

    def boom(*args, **kwargs):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(env["api"], "bake_case_meshes", boom)
    resp = client.get(f"/api/cases/{case}/mesh-manifest")
    assert resp.status_code == 500 and resp.get_json() == {"error": "Mesh generation failed"}
    assert "secret" not in resp.get_data(as_text=True) and "/home/visitor" not in resp.get_data(as_text=True)
    assert SECRET in capsys.readouterr().out, "the cause must still be logged on the server"


def test_a_failed_regeneration_returns_a_fixed_message_not_the_exception(env, client, monkeypatch, capsys):
    from constants import Constants
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    os.remove(os.path.join(Constants.MESH_PATH, CASE, "liver.glb"))

    def boom(*args, **kwargs):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(env["api"], "generate_organ_glb_bytes", boom)
    resp = client.get(f"/api/cases/{CASE}/render_only/liver.glb")
    assert resp.status_code == 500 and resp.get_json() == {"error": "Mesh generation failed"}
    assert "secret" not in resp.get_data(as_text=True)
    assert SECRET in capsys.readouterr().out


def test_a_missing_structure_says_so_without_the_exceptions_own_text(env, client, monkeypatch):
    from constants import Constants
    assert client.get(f"/api/cases/{CASE}/mesh-manifest").status_code == 200
    os.remove(os.path.join(Constants.MESH_PATH, CASE, "liver.glb"))

    def no_such(*args, **kwargs):
        raise ValueError(SECRET)

    monkeypatch.setattr(env["api"], "generate_organ_glb_bytes", no_such)
    resp = client.get(f"/api/cases/{CASE}/render_only/liver.glb")
    assert resp.status_code == 404 and resp.get_json() == {"error": "This scan has no such structure"}
    assert "secret" not in resp.get_data(as_text=True)


# ------------------------------------------------------------------------------------ the library
def _search(client, query=""):
    resp = client.get("/api/search?per_page=50" + ("&" + query if query else ""))
    assert resp.status_code == 200
    return resp.get_json()


def test_the_dataset_is_in_the_library_with_its_metadata(client):
    body = _search(client, "dataset=abdomenatlas")
    assert body["total"] == 3
    by_id = {item["case_id"]: item for item in body["items"]}
    assert set(by_id) == {CASE, NO_MASK, NO_CT}
    first = by_id[CASE]
    assert first["dataset"] == "AbdomenAtlas" and first["tumor"] == 1 and first["tumor types"] == ["liver"]
    assert first["sex"] == "F" and first["age"] == 51 and first["ct phase"] == "Arterial"
    assert by_id[NO_MASK]["tumor"] == 0 and by_id[NO_MASK]["ct phase"] == "Non-contrast"
    assert by_id[NO_CT]["tumor types"] == ["pancreas"]
    assert "private findings" not in str(body), "report text is never exposed by search"


def test_the_default_library_includes_it_and_the_other_filters_still_apply(client):
    assert {i["case_id"] for i in _search(client)["items"]} >= {CASE, NO_MASK, NO_CT}
    assert {i["case_id"] for i in _search(client, "dataset=abdomenatlas&tumor_type[]=pancreas")["items"]} == {NO_CT}
    assert {i["case_id"] for i in _search(client, "dataset=abdomenatlas&ct_phase[]=Non-contrast")["items"]} == {NO_MASK}
    assert {i["case_id"] for i in _search(client, f"caseid={CASE}")["items"]} == {CASE}
    assert {i["case_id"] for i in _search(client, "caseid=bdmap_8")["items"]} == {NO_MASK}
    assert _search(client, "dataset=pants")["total"] == 0, "the other datasets do not leak in"


def test_the_facets_report_the_dataset_size(client):
    body = client.get("/api/facets?fields=ct_phase&dataset=abdomenatlas").get_json()
    assert body["total"] == 3 and body["dataset_counts"]["AbdomenAtlas"] == 3
    assert body["dataset_counts"]["PanTS"] == 0
