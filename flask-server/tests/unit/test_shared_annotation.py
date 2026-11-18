"""Shared annotation override: an annotator saves a dataset scan's segmentation for EVERYONE.

A dataset scan (PanTS, CancerVerse, AbdomenAtlas) has ONE version for everybody: the original, or the one an
approved annotator saved with /save-segmentation-shared. Nobody keeps a private copy. These tests pin the
permission gate, the lost-update guard, who sees what, the 2D mask + low-res preview, the mesh cache
location, the history archive, the revert, and the same behaviour for CancerVerse and AbdomenAtlas.
"""
import gzip
import json
import os

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as routes
import api.auth as auth_module
from constants import Constants
from services import role_store

CASE = 35
PANTS = "PanTS_00000035"


class Who:
    """The signed-in account for the next request (None = signed out)."""

    def __init__(self):
        self.user = None
        self.roles = []

    def sign_in(self, user_id, roles=()):
        self.user = {"id": user_id, "name": f"User {user_id}", "email": f"{user_id}@example.org"}
        self.roles = list(roles)

    def sign_out(self):
        self.user, self.roles = None, []


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    root = tmp_path / "pants"
    mask_path = root / "mask_only" / PANTS / "combined_labels.nii.gz"
    mask_path.parent.mkdir(parents=True)
    original = np.zeros((8, 8, 8), dtype=np.uint8)
    original[2:6, 2:6, 2:6] = 25
    nib.save(nib.Nifti1Image(original, np.diag([0.75, 0.75, 5, 1])), mask_path)
    monkeypatch.setattr(Constants, "PANTS_PATH", str(root))
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "ipantsmini-v1", raising=False)
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"), raising=False)
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "LOWRES_ROOT", str(tmp_path / "lowres"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    monkeypatch.setattr(routes, "_run_in_background", lambda work: None)  # lazy by default; see the prewarm tests
    who = Who()
    for module in (routes, auth_module):
        monkeypatch.setattr(module, "current_user", lambda: who.user)
    for module in (routes, auth_module):
        monkeypatch.setattr(module, "current_roles", lambda: who.roles)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), original, who, tmp_path


def _payload(volume):
    return gzip.compress(volume.tobytes(order="F"))


def _shared_status(client):
    response = client.get(f"/api/shared-annotation/{CASE}")
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def _save_shared(client, volume, if_match="none", case=CASE):
    headers = {} if if_match is None else {"If-Match": if_match}
    return client.post(f"/api/save-segmentation-shared/{case}?res=full", data=_payload(volume), headers=headers)


def _served(client, query=""):
    response = client.get(f"/api/get-segmentations/{CASE}.nii.gz{query}")
    assert response.status_code == 200, response.get_data()[:200]
    return response, np.asarray(nib.Nifti1Image.from_bytes(gzip.decompress(response.get_data())).dataobj)


def _corrected(original):
    fixed = original.copy()
    fixed[0, 0, 0] = 7
    return fixed


# ---- who may save ------------------------------------------------------------------------------

def test_roles_vocabulary_has_annotator_and_admin():
    assert role_store.ROLE_ANNOTATOR == "annotator"
    assert {"admin", "annotator"} <= set(role_store.ROLES)


def test_signed_out_cannot_save_shared(env):
    client, original, who, _ = env
    assert _save_shared(client, _corrected(original)).status_code == 401


def test_plain_account_cannot_save_shared_and_nothing_is_written(env):
    client, original, who, tmp_path = env
    who.sign_in("plain")
    assert _save_shared(client, _corrected(original)).status_code == 403
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))


@pytest.mark.parametrize("roles", [["annotator"], ["admin", "annotator"]])
def test_annotators_can_save_shared(env, roles):
    client, original, who, _ = env
    who.sign_in("approved", roles)
    response = _save_shared(client, _corrected(original))
    assert response.status_code == 200, response.get_json()
    assert os.path.isfile(routes._pants_shared_edit_path(CASE))


def test_legacy_manager_role_alone_cannot_save_shared(env):
    client, original, who, _ = env
    who.sign_in("legacy-manager", ["annotation_manager"])
    assert _save_shared(client, _corrected(original)).status_code == 403
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))


def test_being_an_admin_is_not_enough_to_change_what_everyone_sees(env):
    client, original, who, _ = env
    who.sign_in("just-an-admin", ["admin"])
    assert _save_shared(client, _corrected(original)).status_code == 403
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))
    assert _shared_status(client)["can_override"] is False
    assert client.delete(f"/api/shared-annotation/{CASE}").status_code == 403


def test_signed_out_and_plain_cannot_revert(env):
    client, original, who, _ = env
    assert client.delete(f"/api/shared-annotation/{CASE}").status_code == 401
    who.sign_in("plain")
    assert client.delete(f"/api/shared-annotation/{CASE}").status_code == 403


# ---- the lost-update guard -----------------------------------------------------------------------

def test_save_without_if_match_is_refused_not_guessed(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original), if_match=None).status_code == 428
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))


def test_stale_if_match_is_a_conflict(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original), if_match="deadbeef").status_code == 409
    assert _save_shared(client, _corrected(original), if_match="none").status_code == 200
    # The second annotator still holds the "none" they opened the scan with.
    who.sign_in("second", ["annotator"])
    assert _save_shared(client, _corrected(original), if_match="none").status_code == 409


def test_second_save_with_the_new_revision_succeeds_and_bumps_the_version(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    status = _shared_status(client)
    assert status["exists"] and status["version"] == 1 and status["saved_by"] == "User approved"
    second = original.copy()
    second[7, 7, 7] = 9
    assert _save_shared(client, second, if_match=status["revision"]).status_code == 200
    assert _shared_status(client)["version"] == 2


# ---- who sees what -------------------------------------------------------------------------------

def test_everyone_sees_the_original_until_someone_overrides(env):
    client, original, who, _ = env
    who.sign_in("reader")
    _, seen = _served(client)
    # The dataset's source labels are converted to the viewer's ids on the way out; the shape is the original's.
    assert seen.shape == original.shape and np.array_equal(seen != 0, original != 0)
    assert _shared_status(client)["exists"] is False


def test_other_accounts_see_the_shared_version_after_an_override(env):
    client, original, who, _ = env
    fixed = _corrected(original)
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, fixed).status_code == 200
    for reader in ("reader-1", "reader-2"):
        who.sign_in(reader)
        response, seen = _served(client)
        assert np.array_equal(seen, fixed)
        assert response.headers["Cache-Control"] == "no-cache"
    who.sign_out()
    _, seen = _served(client)
    assert np.array_equal(seen, fixed)


def test_reopening_after_a_second_override_shows_the_newest(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    first = _corrected(original)
    assert _save_shared(client, first).status_code == 200
    second = first.copy()
    second[7, 7, 7] = 9
    assert _save_shared(client, second, if_match=_shared_status(client)["revision"]).status_code == 200
    who.sign_in("reader")
    _, seen = _served(client)
    assert np.array_equal(seen, second)


def test_the_original_file_is_never_modified(env):
    client, original, who, tmp_path = env
    source = tmp_path / "pants" / "mask_only" / PANTS / "combined_labels.nii.gz"
    before = source.read_bytes()
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    assert source.read_bytes() == before


def test_low_resolution_preview_follows_the_shared_version(env):
    client, original, who, tmp_path = env
    low_path = tmp_path / "lowres" / "mask_only" / PANTS / "combined_labels_lowres.nii.gz"
    low_path.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(original[::2, ::2, ::2], np.diag([1.5, 1.5, 10, 1])), low_path)
    fixed = original.copy()
    fixed[2:6, 2:6, 2:6] = 12  # a whole-structure correction the coarse grid can show
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, fixed).status_code == 200
    who.sign_in("reader")
    response, preview = _served(client, "?res=low")
    assert response.headers["Cache-Control"] == "no-cache"
    assert preview.shape == (4, 4, 4)
    assert 12 in np.unique(preview) and 25 not in np.unique(preview)


# ---- 3D meshes ------------------------------------------------------------------------------------

def test_meshes_come_from_a_separate_shared_cache_so_the_original_is_not_overwritten(env):
    client, original, who, tmp_path = env
    original_dir = routes._pants_mesh_directory(PANTS)
    assert original_dir == os.path.join(Constants.MESH_PATH, PANTS)
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    who.sign_in("reader")
    with client.application.test_request_context("/"):
        shared_dir = routes._pants_mesh_directory(PANTS)
    assert shared_dir == os.path.join(Constants.MESH_PATH, "shared", PANTS)
    assert shared_dir != original_dir


def test_mesh_cache_goes_stale_when_the_shared_version_changes(env, monkeypatch):
    client, original, who, tmp_path = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    who.sign_in("reader")
    with client.application.test_request_context("/"):
        shared_mask = routes._ai_local_mask_path(str(CASE))
        revision = routes.labelmap_revision(shared_mask)
        mesh_dir = routes._pants_mesh_directory(PANTS)
    os.makedirs(mesh_dir)
    manifest_path = os.path.join(mesh_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump({"labelScheme": routes.LABEL_SCHEME, "labelmap_revision": revision, "organs": []}, handle)
    monkeypatch.setattr(Constants, "PANTS_LABEL_SCHEMA", "viewer-v1", raising=False)
    with client.application.test_request_context("/"):
        assert routes._mesh_cache_is_stale(manifest_path, str(CASE)) is False
    second = original.copy()
    second[7, 7, 7] = 9
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, second, if_match=_shared_status(client)["revision"]).status_code == 200
    who.sign_in("reader")
    with client.application.test_request_context("/"):
        assert routes._mesh_cache_is_stale(manifest_path, str(CASE)) is True


# ---- history and revert ---------------------------------------------------------------------------

def test_replacing_a_shared_version_archives_the_old_one(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    first = _corrected(original)
    assert _save_shared(client, first).status_code == 200
    assert not os.path.isdir(routes._pants_shared_history_dir(CASE))  # nothing to archive on the first save
    second = first.copy()
    second[7, 7, 7] = 9
    assert _save_shared(client, second, if_match=_shared_status(client)["revision"]).status_code == 200
    archived = [n for n in os.listdir(routes._pants_shared_history_dir(CASE)) if n.endswith(".nii.gz")]
    assert len(archived) == 1
    kept = np.asarray(nib.load(os.path.join(routes._pants_shared_history_dir(CASE), archived[0])).dataobj)
    assert np.array_equal(kept, first)


def test_history_is_pruned_to_the_newest_versions(env, monkeypatch):
    client, original, who, _ = env
    monkeypatch.setattr(routes, "SHARED_HISTORY_KEEP", 3)
    who.sign_in("approved", ["annotator"])
    volume = original.copy()
    assert _save_shared(client, volume).status_code == 200
    for step in range(6):
        volume = volume.copy()
        volume[step, 0, 0] = 50 + step
        assert _save_shared(client, volume, if_match=_shared_status(client)["revision"]).status_code == 200
    names = [n for n in os.listdir(routes._pants_shared_history_dir(CASE)) if n.endswith(".nii.gz")]
    assert len(names) == 3


def test_revert_restores_the_original_for_everyone_and_archives_the_override(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    _, baseline = _served(client)
    fixed = _corrected(original)
    assert _save_shared(client, fixed).status_code == 200
    revision = _shared_status(client)["revision"]
    response = client.delete(f"/api/shared-annotation/{CASE}", headers={"If-Match": revision})
    assert response.status_code == 200 and response.get_json()["reverted"] is True
    who.sign_in("reader")
    _, seen = _served(client)
    assert np.array_equal(seen, baseline)
    assert _shared_status(client)["exists"] is False
    archived = os.listdir(routes._pants_shared_history_dir(CASE))
    assert any(n.endswith(".nii.gz") for n in archived)
    with client.application.test_request_context("/"):
        assert routes._pants_mesh_directory(PANTS) == os.path.join(Constants.MESH_PATH, PANTS)


def test_revert_with_a_stale_revision_is_refused(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    response = client.delete(f"/api/shared-annotation/{CASE}", headers={"If-Match": "stale"})
    assert response.status_code == 409
    assert os.path.isfile(routes._pants_shared_edit_path(CASE))


def test_revert_when_there_is_no_override_is_a_harmless_no_op(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    response = client.delete(f"/api/shared-annotation/{CASE}")
    assert response.status_code == 200 and response.get_json()["reverted"] is False


# ---- status endpoint and unsupported scans ----------------------------------------------------------

def test_status_tells_each_account_whether_it_may_override(env):
    client, original, who, _ = env
    who.sign_in("plain")
    assert _shared_status(client)["can_override"] is False
    who.sign_in("approved", ["annotator"])
    assert _shared_status(client)["can_override"] is True
    who.sign_out()
    assert client.get(f"/api/shared-annotation/{CASE}").status_code == 401


def test_a_session_upload_id_is_not_a_shared_scan(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    response = client.post("/api/save-segmentation-shared/123e4567-e89b-12d3-a456-426614174000", data=b"",
                           headers={"If-Match": "none"})
    assert response.status_code == 400


def test_a_wrong_sized_payload_is_rejected_and_writes_nothing(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    response = client.post(f"/api/save-segmentation-shared/{CASE}?res=full", data=gzip.compress(b"\x00" * 10),
                           headers={"If-Match": "none"})
    assert response.status_code == 400
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))
    assert _shared_status(client)["exists"] is False


# ---- organ statistics, staging and the caches that remember them ------------------------------------

def test_service_and_blueprint_agree_on_where_the_shared_mask_lives(env):
    from services import shared_annotations
    assert shared_annotations.shared_mask_path(PANTS) == routes._pants_shared_edit_path(CASE)
    assert shared_annotations.shared_mask_path(PANTS, low=True) == routes._pants_shared_edit_path(CASE, low=True)


def test_organ_statistics_are_measured_from_the_shared_mask(env, monkeypatch):
    import api.utils as api_utils
    client, original, who, tmp_path = env
    seen = []

    class Recorder:
        def __init__(self, ct_path, mask_path, *args, **kwargs):
            seen.append(str(mask_path))

        def set_organ_intensities(self, *_):
            pass

        def calculate_metrics(self):
            return {"organ_metrics": []}

        def calculate_pdac_sma_staging(self):
            return "staged"

    monkeypatch.setattr(api_utils, "NiftiProcessor", Recorder)
    monkeypatch.setattr(api_utils, "viewer_labelmap_path", lambda path: "CONVERTED:" + str(path))
    api_utils.get_mask_data_internal(CASE)
    assert seen[-1].startswith("CONVERTED:")  # the original goes through the source-to-viewer conversion
    api_utils.get_pdac_staging(CASE)
    assert "mask_only" in seen[-1]

    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    api_utils.get_mask_data_internal(CASE)
    assert seen[-1] == routes._pants_shared_edit_path(CASE)  # already viewer ids: no conversion
    api_utils.get_pdac_staging(CASE)
    assert seen[-1] == routes._pants_shared_edit_path(CASE)


def test_cached_statistics_are_measured_again_after_an_override_and_after_a_revert(env):
    client, original, who, _ = env
    before = routes._mask_data_stamp(CASE)
    metrics_before = routes._ai_metrics_stamp(str(CASE))
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    after = routes._mask_data_stamp(CASE)
    assert after != before and after[1][0] == routes._pants_shared_edit_path(CASE)
    assert routes._ai_metrics_stamp(str(CASE)) != metrics_before
    revision = _shared_status(client)["revision"]
    assert client.delete(f"/api/shared-annotation/{CASE}", headers={"If-Match": revision}).status_code == 200
    assert routes._mask_data_stamp(CASE) == before
    assert routes._ai_metrics_stamp(str(CASE)) == metrics_before


def test_a_second_override_changes_the_statistics_stamp_again(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    first = routes._mask_data_stamp(CASE)
    second = original.copy()
    second[7, 7, 7] = 9
    assert _save_shared(client, second, if_match=_shared_status(client)["revision"]).status_code == 200
    assert routes._mask_data_stamp(CASE) != first


# ---- end to end: the 3D meshes everyone is shown -----------------------------------------------------

@pytest.fixture
def mesh_env(tmp_path, monkeypatch):
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    root = tmp_path / "pants"
    label_path = root / "mask_only" / PANTS / "combined_labels.nii.gz"
    label_path.parent.mkdir(parents=True)
    labels = np.zeros((8, 8, 8), dtype=np.uint8)
    labels[1:3, 1:3, 1:3] = 1
    labels[4:6, 4:6, 4:6] = 14
    nib.save(nib.Nifti1Image(labels, np.eye(4)), label_path)
    monkeypatch.setattr(Constants, "PANTS_PATH", str(root))
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    monkeypatch.setattr(routes, "_run_in_background", lambda work: None)  # lazy by default; see the prewarm tests
    who = Who()
    for module in (routes, auth_module):
        monkeypatch.setattr(module, "current_user", lambda: who.user)
        monkeypatch.setattr(module, "current_roles", lambda: who.roles)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), labels, who, tmp_path


def _manifest(client):
    response = client.get(f"/api/cases/{CASE}/mesh-manifest")
    assert response.status_code == 200, response.get_data()[:300]
    return response.get_json()


def _organ_ids(manifest):
    return [organ["id"] for organ in manifest["organs"]]


def test_everyone_gets_new_meshes_after_an_override_and_the_originals_again_after_a_revert(mesh_env):
    client, labels, who, tmp_path = mesh_env
    original_manifest_path = tmp_path / "meshes" / PANTS / "manifest.json"
    who.sign_in("reader")
    assert _organ_ids(_manifest(client)) == [1, 14]
    original_mtime = original_manifest_path.stat().st_mtime_ns

    corrected = np.zeros_like(labels)  # the fix: structure 1 was wrong, structure 3 was missing
    corrected[4:6, 4:6, 4:6] = 14
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, corrected).status_code == 200

    who.sign_in("someone-else")
    manifest = _manifest(client)
    assert _organ_ids(manifest) == [3, 14]
    assert (tmp_path / "meshes" / "shared" / PANTS / "manifest.json").is_file()
    new_organ = next(organ for organ in manifest["organs"] if organ["id"] == 3)
    mesh = client.get(new_organ["url"])
    assert mesh.status_code == 200 and mesh.get_data()[:4] == b"glTF"
    who.sign_out()
    assert _organ_ids(_manifest(client)) == [3, 14]  # signed-out viewers (showcase scans) too
    assert original_manifest_path.stat().st_mtime_ns == original_mtime  # the original bake is untouched

    who.sign_in("approved", ["annotator"])
    revision = _shared_status(client)["revision"]
    assert client.delete(f"/api/shared-annotation/{CASE}", headers={"If-Match": revision}).status_code == 200
    who.sign_in("someone-else")
    assert _organ_ids(_manifest(client)) == [1, 14]
    assert original_manifest_path.stat().st_mtime_ns == original_mtime  # reverting needed no rebake


def test_a_second_override_rebakes_the_shared_meshes(mesh_env):
    client, labels, who, tmp_path = mesh_env
    first = np.zeros_like(labels)
    first[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, first).status_code == 200
    who.sign_in("reader")
    assert _organ_ids(_manifest(client)) == [3]
    second = np.zeros_like(labels)
    second[2:5, 2:5, 2:5] = 14
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, second, if_match=_shared_status(client)["revision"]).status_code == 200
    who.sign_in("reader")
    assert _organ_ids(_manifest(client)) == [14]




# ---- one version for everyone: no private copies --------------------------------------------------

@pytest.mark.parametrize("roles", [[], ["annotator"], ["admin"]])
def test_a_personal_save_of_a_dataset_scan_is_refused_for_everyone(env, roles):
    client, original, who, tmp_path = env
    who.sign_in("someone", roles)
    _, baseline = _served(client)
    response = client.post(f"/api/save-segmentation/{CASE}?res=full", data=_payload(_corrected(original)))
    assert response.status_code == 403, response.get_json()
    assert not os.path.exists(routes._pants_shared_edit_path(CASE))
    assert not (tmp_path / "viewer-labels" / "edits" / "accounts").exists()  # no per-account copy either
    who.sign_in("another")
    _, seen = _served(client)
    assert np.array_equal(seen, baseline)


def test_an_old_per_account_edit_on_disk_is_no_longer_shown(env):
    client, original, who, tmp_path = env
    who.sign_in("reader")
    _, baseline = _served(client)
    import hashlib
    scope = hashlib.sha256(b"reader").hexdigest()
    stale = tmp_path / "viewer-labels" / "edits" / "accounts" / scope / PANTS / "combined_labels.nii.gz"
    stale.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(_corrected(original), np.eye(4)), stale)
    _, seen = _served(client)
    assert np.array_equal(seen, baseline)


def test_the_save_response_names_the_new_shared_revision(env):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    body = _save_shared(client, _corrected(original)).get_json()
    assert body["revision"] == body["shared_revision"] == _shared_status(client)["revision"]


# ---- CancerVerse and AbdomenAtlas behave the same ---------------------------------------------------

CATALOGS = [("CV_00000001", "CANCERVERSE_OVERLAY_PATH"), ("BDMAP_00000001", "ABDOMENATLAS_OVERLAY_PATH")]


@pytest.fixture(params=CATALOGS, ids=["cancerverse", "abdomenatlas"])
def catalog_env(request, tmp_path, monkeypatch):
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    case, constant = request.param
    overlay = tmp_path / "overlay"
    original = np.zeros((8, 8, 8), dtype=np.uint8)
    original[1:3, 1:3, 1:3] = 1
    original[4:6, 4:6, 4:6] = 14
    mask = overlay / "mask_only" / case / "combined_labels.nii.gz"
    mask.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(original, np.diag([0.75, 0.75, 5, 1])), mask)
    monkeypatch.setattr(Constants, constant, str(overlay), raising=False)
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"), raising=False)
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    monkeypatch.setattr(routes, "_run_in_background", lambda work: None)  # lazy by default; see the prewarm tests
    who = Who()
    for module in (routes, auth_module):
        monkeypatch.setattr(module, "current_user", lambda: who.user)
        monkeypatch.setattr(module, "current_roles", lambda: who.roles)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    return app.test_client(), original, who, tmp_path, case, mask


def _catalog_served(client, case):
    response = client.get(f"/api/get-segmentations/{case}.nii.gz")
    assert response.status_code == 200, response.get_data()[:200]
    return np.asarray(nib.Nifti1Image.from_bytes(gzip.decompress(response.get_data())).dataobj)


def _catalog_manifest(client, case):
    response = client.get(f"/api/cases/{case}/mesh-manifest")
    assert response.status_code == 200, response.get_data()[:300]
    return response.get_json()


def test_a_catalog_scan_can_be_overridden_for_everyone_and_reverted(catalog_env):
    client, original, who, tmp_path, case, mask = catalog_env
    source_bytes = mask.read_bytes()
    who.sign_in("reader")
    assert np.array_equal(_catalog_served(client, case), original)
    assert client.get(f"/api/shared-annotation/{case}").get_json()["can_override"] is False

    corrected = np.zeros_like(original)
    corrected[4:6, 4:6, 4:6] = 14
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("plain")
    assert _save_shared(client, corrected, case=case).status_code == 403
    who.sign_in("approved", ["annotator"])
    status = client.get(f"/api/shared-annotation/{case}").get_json()
    assert status["supported"] is True and status["exists"] is False and status["can_override"] is True
    assert _save_shared(client, corrected, case=case).status_code == 200

    for viewer in ("reader", "someone-else"):
        who.sign_in(viewer)
        assert np.array_equal(_catalog_served(client, case), corrected)
    who.sign_out()
    assert np.array_equal(_catalog_served(client, case), corrected)
    assert mask.read_bytes() == source_bytes  # the dataset's own mask is never modified

    who.sign_in("approved", ["annotator"])
    revision = client.get(f"/api/shared-annotation/{case}").get_json()["revision"]
    assert client.delete(f"/api/shared-annotation/{case}", headers={"If-Match": revision}).status_code == 200
    who.sign_in("reader")
    assert np.array_equal(_catalog_served(client, case), original)


def test_catalog_mesh_manifests_are_always_revalidated(catalog_env):
    client, original, who, tmp_path, case, _ = catalog_env
    who.sign_in("reader")
    response = client.get(f"/api/cases/{case}/mesh-manifest")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-cache"


def test_a_catalog_scan_personal_save_is_refused(catalog_env):
    client, original, who, tmp_path, case, _ = catalog_env
    who.sign_in("approved", ["annotator"])
    response = client.post(f"/api/save-segmentation/{case}?res=full", data=_payload(original))
    assert response.status_code == 403
    assert not os.path.exists(routes._pants_shared_edit_path(case))


def test_a_catalog_scan_gets_new_meshes_after_an_override_and_the_originals_after_a_revert(catalog_env):
    client, original, who, tmp_path, case, _ = catalog_env
    who.sign_in("reader")
    assert _organ_ids(_catalog_manifest(client, case)) == [1, 14]
    original_manifest = tmp_path / "meshes" / case / "manifest.json"
    original_mtime = original_manifest.stat().st_mtime_ns

    corrected = np.zeros_like(original)
    corrected[4:6, 4:6, 4:6] = 14
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, corrected, case=case).status_code == 200
    who.sign_in("someone-else")
    manifest = _catalog_manifest(client, case)
    assert _organ_ids(manifest) == [3, 14]
    assert (tmp_path / "meshes" / "shared" / case / "manifest.json").is_file()
    new_organ = next(organ for organ in manifest["organs"] if organ["id"] == 3)
    mesh = client.get(new_organ["url"])
    assert mesh.status_code == 200 and mesh.get_data()[:4] == b"glTF"
    assert original_manifest.stat().st_mtime_ns == original_mtime

    second = np.zeros_like(original)
    second[2:5, 2:5, 2:5] = 14
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, second, if_match=client.get(f"/api/shared-annotation/{case}").get_json()["revision"], case=case).status_code == 200
    who.sign_in("reader")
    assert _organ_ids(_catalog_manifest(client, case)) == [14]

    who.sign_in("approved", ["annotator"])
    revision = client.get(f"/api/shared-annotation/{case}").get_json()["revision"]
    assert client.delete(f"/api/shared-annotation/{case}", headers={"If-Match": revision}).status_code == 200
    who.sign_in("reader")
    assert _organ_ids(_catalog_manifest(client, case)) == [1, 14]
    assert original_manifest.stat().st_mtime_ns == original_mtime


def test_a_scan_with_no_mask_yet_can_get_its_first_one(catalog_env, monkeypatch):
    client, original, who, tmp_path, case, mask = catalog_env
    mask.unlink()  # a scan nobody has segmented
    ct = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((8, 8, 8), dtype=np.int16), np.diag([0.75, 0.75, 5, 1])), ct)
    monkeypatch.setattr(routes, "get_case_nifti_paths", lambda _id: {"image": str(ct)})
    who.sign_in("reader")
    assert client.get(f"/api/get-segmentations/{case}.nii.gz").get_json() == {"masks_available": False}
    first = np.zeros_like(original)
    first[2:5, 2:5, 2:5] = 14
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, first, case=case).status_code == 200
    who.sign_in("reader")
    assert np.array_equal(_catalog_served(client, case), first)
    assert _organ_ids(_catalog_manifest(client, case)) == [14]


def test_a_catalog_scan_with_neither_a_mask_nor_a_ct_cannot_be_saved(catalog_env, monkeypatch):
    client, original, who, tmp_path, case, mask = catalog_env
    mask.unlink()
    monkeypatch.setattr(routes, "get_case_nifti_paths", lambda _id: {"image": str(tmp_path / "missing.nii.gz")})
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, original, case=case).status_code == 404
    assert not os.path.exists(routes._pants_shared_edit_path(case))


# ---- the first visitor does not wait for the 3D meshes ----------------------------------------------------

def test_saving_builds_the_new_meshes_before_anyone_asks_for_them(mesh_env, monkeypatch):
    client, labels, who, tmp_path = mesh_env
    monkeypatch.setattr(routes, "_run_in_background", lambda work: work())  # the thread, run inline
    corrected = np.zeros_like(labels)
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, corrected).status_code == 200
    manifest_path = tmp_path / "meshes" / "shared" / PANTS / "manifest.json"
    assert manifest_path.is_file()  # built by the save, not by a visitor
    assert [organ["id"] for organ in json.loads(manifest_path.read_text())["organs"]] == [3]
    built = manifest_path.stat().st_mtime_ns
    who.sign_in("reader")
    assert _organ_ids(_manifest(client)) == [3]
    assert manifest_path.stat().st_mtime_ns == built  # the visitor reused it instead of baking again


def test_a_failed_prewarm_costs_the_first_visitor_a_wait_and_nothing_else(mesh_env, monkeypatch):
    client, labels, who, tmp_path = mesh_env
    monkeypatch.setattr(routes, "_run_in_background", lambda work: work())
    real_bake, calls = routes.bake_case_meshes, []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("disk full")
        return real_bake(*args, **kwargs)

    monkeypatch.setattr(routes, "bake_case_meshes", flaky)
    corrected = np.zeros_like(labels)
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, corrected).status_code == 200  # the save itself is not affected
    assert not (tmp_path / "meshes" / "shared" / PANTS / "manifest.json").exists()
    who.sign_in("reader")
    assert _organ_ids(_manifest(client)) == [3]  # the first visitor builds it, as before this feature existed
    assert len(calls) == 2


@pytest.mark.parametrize("case,constant", [("CV_00000001", "CANCERVERSE_OVERLAY_PATH"), ("BDMAP_00000001", "ABDOMENATLAS_OVERLAY_PATH")])
def test_catalog_scans_are_prewarmed_too(tmp_path, monkeypatch, case, constant):
    monkeypatch.setenv("BODYMAPS_ANNOTATION_PROJECTS", "0")
    overlay = tmp_path / "overlay"
    original = np.zeros((8, 8, 8), dtype=np.uint8)
    original[4:6, 4:6, 4:6] = 14
    mask = overlay / "mask_only" / case / "combined_labels.nii.gz"
    mask.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(original, np.diag([0.75, 0.75, 5, 1])), mask)
    monkeypatch.setattr(Constants, constant, str(overlay), raising=False)
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"), raising=False)
    monkeypatch.setenv("PANTS_VIEWER_LABEL_CACHE_PATH", str(tmp_path / "viewer-labels"))
    monkeypatch.setattr(routes, "mount_down_response", lambda: None)
    monkeypatch.setattr(routes, "_run_in_background", lambda work: work())
    who = Who()
    for module in (routes, auth_module):
        monkeypatch.setattr(module, "current_user", lambda: who.user)
        monkeypatch.setattr(module, "current_roles", lambda: who.roles)
    app = Flask(__name__)
    app.register_blueprint(routes.api_blueprint, url_prefix="/api")
    client = app.test_client()
    corrected = np.zeros_like(original)
    corrected[1:4, 1:4, 1:4] = 3
    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, corrected, case=case).status_code == 200
    manifest = tmp_path / "meshes" / "shared" / case / "manifest.json"
    assert [organ["id"] for organ in json.loads(manifest.read_text())["organs"]] == [3]


def test_a_scan_with_no_mask_can_be_saved_from_the_low_resolution_ct_the_viewer_opened(catalog_env, monkeypatch):
    client, original, who, tmp_path, case, mask = catalog_env
    mask.unlink()
    full = tmp_path / "ct.nii.gz"
    low = tmp_path / "ct_lowres.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((8, 8, 8), dtype=np.int16), np.diag([0.75, 0.75, 5, 1])), full)
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.int16), np.diag([1.5, 1.5, 10, 1])), low)
    monkeypatch.setattr(routes, "get_case_nifti_paths", lambda _id: {"image": str(full), "lowres_image": str(low)})
    first = np.zeros((4, 4, 4), dtype=np.uint8)
    first[1, 1, 1] = 14
    who.sign_in("approved", ["annotator"])
    response = client.post(f"/api/save-segmentation-shared/{case}?res=low", data=_payload(first), headers={"If-Match": "none"})
    assert response.status_code == 200, response.get_json()
    who.sign_in("reader")
    served = _catalog_served(client, case)
    assert served.shape == (8, 8, 8)  # stored on the full grid
    assert int(np.count_nonzero(served == 14)) == 8  # the one preview voxel covers 2x2x2 full-resolution voxels


# ---- review fixes: one key per scan, and nothing in a browser outlives a correction ------------------------

@pytest.mark.parametrize("spelling", ["35", "0035", "000000035", "PanTS_00000035", "pants_35"])
def test_every_spelling_of_a_scan_id_is_the_same_scan(env, spelling):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert routes._shared_case_key(spelling) == PANTS
    assert _save_shared(client, _corrected(original), case=spelling).status_code == 200
    assert os.path.isfile(routes._pants_shared_edit_path(CASE))
    assert _shared_status(client)["exists"] is True  # status by the plain id sees what the odd spelling saved


@pytest.mark.parametrize("bad", ["abc", "9" * 13, "9" * 5000, "35.5", "../35", "PanTS_", "CV_", ""])
def test_ids_that_are_not_scans_have_no_shared_version(env, bad):
    client, original, who, _ = env
    who.sign_in("approved", ["annotator"])
    assert routes._shared_case_key(bad) is None


def test_a_browser_that_already_has_the_original_gets_the_correction_on_its_next_visit(env):
    client, original, who, _ = env
    who.sign_in("reader")
    first, _ = _served(client)
    assert "immutable" not in first.headers["Cache-Control"] and "no-cache" in first.headers["Cache-Control"]
    etag = first.headers.get("ETag")
    assert etag
    again = client.get(f"/api/get-segmentations/{CASE}.nii.gz", headers={"If-None-Match": etag})
    assert again.status_code == 304  # unchanged: a cheap check, not a download

    who.sign_in("approved", ["annotator"])
    assert _save_shared(client, _corrected(original)).status_code == 200
    who.sign_in("reader")
    after = client.get(f"/api/get-segmentations/{CASE}.nii.gz", headers={"If-None-Match": etag})
    assert after.status_code == 200  # the cached original is no longer accepted
    seen = np.asarray(nib.Nifti1Image.from_bytes(gzip.decompress(after.get_data())).dataobj)
    assert np.array_equal(seen, _corrected(original))
    assert "no-cache" in after.headers["Cache-Control"]
