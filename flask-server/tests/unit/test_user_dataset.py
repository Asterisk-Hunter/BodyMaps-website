"""Unit tests for the user-dataset admission gatekeeper (services/user_dataset.py).

Pure-logic gates (quota, dedup, registry, case-id, rejection audit) run always.
The CT/mask-loading gates need nibabel and are guarded with importorskip.
"""
import importlib
import json
import os

import pytest


@pytest.fixture()
def ud(tmp_path, monkeypatch):
    """Fresh module bound to a temp dataset root."""
    monkeypatch.setenv("USER_DATASET_PATH", str(tmp_path / "UserData"))
    # small quotas so the tests can trip them
    monkeypatch.setenv("USER_DATASET_DAILY_PER_USER", "2")
    monkeypatch.setenv("USER_DATASET_DAILY_PER_IP", "3")
    monkeypatch.setenv("USER_DATASET_DAILY_GLOBAL", "5")
    monkeypatch.setenv("USER_DATASET_MIN_ORGAN_VOXELS", "100")
    monkeypatch.setenv("USER_DATASET_MIN_DISTINCT_ORGANS", "2")
    import services.user_dataset as m
    importlib.reload(m)
    return m


# --------------------------- pure logic ---------------------------
def test_quota_per_user_ip_global(ud):
    now = 1000.0
    reg = {"events": []}
    # per-user cap = 2
    reg["events"] = [{"ts": now, "user_id": "u1", "ip": "a"} for _ in range(2)]
    ok, reason = ud.check_quota(reg, "u1", "a", now)
    assert not ok and reason == "user_quota"
    # a different user is fine (but ip cap = 3 not yet hit)
    ok, _ = ud.check_quota(reg, "u2", "b", now)
    assert ok
    # per-ip cap = 3
    reg["events"] = [{"ts": now, "user_id": f"u{i}", "ip": "x"} for i in range(3)]
    ok, reason = ud.check_quota(reg, "u9", "x", now)
    assert not ok and reason == "ip_quota"
    # global cap = 5
    reg["events"] = [{"ts": now, "user_id": f"u{i}", "ip": f"ip{i}"} for i in range(5)]
    ok, reason = ud.check_quota(reg, "new", "new", now)
    assert not ok and reason == "global_quota"


def test_quota_prunes_old_events(ud):
    now = 1_000_000.0
    reg = {"events": [{"ts": now - 48 * 3600, "user_id": "u1", "ip": "a"} for _ in range(9)]}
    ud._prune_events(reg, now)
    assert reg["events"] == []
    ok, _ = ud.check_quota(reg, "u1", "a", now)
    assert ok  # stale events don't count


def test_registry_roundtrip_atomic(ud, tmp_path):
    root = ud._root()
    os.makedirs(root, exist_ok=True)
    reg = ud._load_registry(root)
    assert reg["next_id"] == 1 and reg["sha256"] == {}
    reg["next_id"] = 7
    ud._save_registry(root, reg)
    assert ud._load_registry(root)["next_id"] == 7


def test_evaluate_dedup_and_admit_flow(ud, monkeypatch):
    """Drive the full admit flow with the NIfTI-dependent gates stubbed, so the
    quota/dedup/promotion/registry bookkeeping is exercised without nibabel."""
    monkeypatch.setattr(ud, "validate_ct", lambda p: (True, "ok"))
    monkeypatch.setattr(ud, "segmentation_quality_ok",
                        lambda p: (True, "ok", {"organ_voxels": 999, "distinct_organs": 5}))
    monkeypatch.setattr(ud, "fingerprints", lambda p: ("SHA", "PH"))
    monkeypatch.setattr(ud, "_promote", lambda *a, **k: None)  # skip file copies

    root = ud._root(); os.makedirs(root, exist_ok=True)
    now = 2000.0
    reg = ud._load_registry(root)
    accepted, reason, extra = ud.evaluate("ct", "mask", reg, "u1", "1.2.3.4", now)
    assert accepted and extra["sha256"] == "SHA"
    # simulate the commit
    reg["sha256"]["SHA"] = "USER_00000001"; reg["phash"]["PH"] = "USER_00000001"
    # a re-upload of the same content is now an exact duplicate
    accepted, reason, _ = ud.evaluate("ct", "mask", reg, "u1", "1.2.3.4", now)
    assert not accepted and reason == "duplicate_exact"


# --------------------------- NIfTI-dependent ---------------------------
def _write_nifti(path, arr, affine=None):
    import numpy as np
    import nibabel as nib
    if affine is None:
        affine = np.eye(4)
    nib.save(nib.Nifti1Image(arr, affine), path)


def test_validate_ct_accepts_real_ct_and_rejects_garbage(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    # a plausible CT: air background (-1000) with a tissue/bone blob
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    vol[30:34, 30:34, 30:34] = 400.0
    ct = str(tmp_path / "ct.nii.gz"); _write_nifti(ct, vol)
    ok, reason = ud.validate_ct(ct)
    assert ok, reason

    # constant volume -> rejected (a constant volume compresses tiny, so it trips
    # too_small before the constant/intensity checks -- all are valid rejections).
    flat = str(tmp_path / "flat.nii.gz"); _write_nifti(flat, np.zeros((64, 64, 64), "float32"))
    ok, reason = ud.validate_ct(flat)
    assert not ok and reason in ("constant_volume", "too_small", "non_ct_intensity:[0,0]")

    # non-CT intensities (all positive, no air) -> rejected
    pos = np.full((64, 64, 64), 50.0, dtype="float32"); pos[0, 0, 0] = 90.0
    posf = str(tmp_path / "pos.nii.gz"); _write_nifti(posf, pos)
    ok, reason = ud.validate_ct(posf)
    assert not ok

    # 2D image -> rejected as not_3d (random data so it clears the size floor and
    # reaches the dimensionality check rather than tripping too_small first)
    twod_arr = np.random.RandomState(1).uniform(-1000, 500, (256, 256, 1)).astype("float32")
    twod = str(tmp_path / "2d.nii.gz"); _write_nifti(twod, twod_arr)
    ok, reason = ud.validate_ct(twod)
    assert not ok and reason.startswith("not_3d")


def test_segmentation_quality_gate(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    # a mask with several organs, plenty of voxels
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 10:30] = 14   # liver
    mask[35:45, 35:45, 35:45] = 17   # pancreas
    good = str(tmp_path / "m.nii.gz"); _write_nifti(good, mask)
    ok, reason, stats = ud.segmentation_quality_ok(good)
    assert ok and stats["distinct_organs"] == 2

    empty = str(tmp_path / "e.nii.gz"); _write_nifti(empty, np.zeros((64, 64, 64), "uint8"))
    ok, reason, _ = ud.segmentation_quality_ok(empty)
    assert not ok


def test_fingerprints_deterministic(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    vol = np.random.RandomState(0).uniform(-1000, 500, (48, 48, 48)).astype("float32")
    ct = str(tmp_path / "ct.nii.gz"); _write_nifti(ct, vol)
    a = ud.fingerprints(ct)
    b = ud.fingerprints(ct)
    assert a == b and len(a[0]) == 64


def test_admit_and_store_end_to_end(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    vol[30:34, 30:34, 30:34] = 400.0
    ct = str(tmp_path / "ct.nii.gz"); _write_nifti(ct, vol)

    out = tmp_path / "out"; out.mkdir()
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 10:30] = 14
    mask[35:45, 35:45, 35:45] = 17
    _write_nifti(str(out / "combined_labels.nii.gz"), mask)

    ud._admit_and_store(ct, str(out), "ePAI", "u1", "1.2.3.4", "sess1")

    root = ud._root()
    assert os.path.exists(os.path.join(root, "image_only", "USER_00000001", "ct.nii.gz"))
    md = os.path.join(root, "mask_only", "USER_00000001", "metadata.json")
    assert os.path.exists(md)
    meta = json.load(open(md))
    assert meta["model"] == "ePAI" and "liver" in meta["organs"]
    # per-organ sublabels written
    assert os.path.exists(os.path.join(root, "mask_only", "USER_00000001", "segmentations", "liver.nii.gz"))

    # a second identical scan is rejected as a duplicate (logged, not stored)
    ud._admit_and_store(ct, str(out), "ePAI", "u1", "1.2.3.4", "sess2")
    assert not os.path.exists(os.path.join(root, "image_only", "USER_00000002"))
    rej = os.path.join(root, "rejections.jsonl")
    assert os.path.exists(rej)
    reasons = [json.loads(l)["reason"] for l in open(rej)]
    assert "duplicate_exact" in reasons


def test_noop_when_unset(tmp_path, monkeypatch):
    """With USER_DATASET_PATH unset the feature is fully inert: no root, and the
    async entry spawns nothing."""
    monkeypatch.delenv("USER_DATASET_PATH", raising=False)
    import services.user_dataset as m
    importlib.reload(m)
    assert m._root() is None
    before = __import__("threading").active_count()
    m.collect_user_scan_async("ct", "out", "ePAI", "u1", "ip", "s")
    assert __import__("threading").active_count() == before  # no thread started


def test_voxel_guard_blocks_oom(ud, tmp_path, monkeypatch):
    """A volume whose decoded voxel count exceeds MAX_VOXELS is rejected BEFORE
    np.asarray, so a decompression bomb can't allocate/OOM the worker."""
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    monkeypatch.setattr(ud, "MAX_VOXELS", 1000)  # tiny cap
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    ct = str(tmp_path / "big.nii.gz"); _write_nifti(ct, vol)
    ok, reason = ud.validate_ct(ct)
    assert not ok and reason.startswith("too_many_voxels")


def test_uncompressed_upload_stored_as_gzip(ud, tmp_path):
    """A raw .nii upload must be gzipped on store, not copied under a .nii.gz name
    (which would be uncompressed and unloadable)."""
    np = pytest.importorskip("numpy")
    nib = pytest.importorskip("nibabel")
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    vol[30:34, 30:34, 30:34] = 400.0
    ct = str(tmp_path / "scan.nii")            # RAW, uncompressed upload
    nib.save(nib.Nifti1Image(vol, np.eye(4)), ct)
    with open(ct, "rb") as f:
        assert f.read(2) != b"\x1f\x8b"        # confirm the source really is raw

    out = tmp_path / "out"; out.mkdir()
    mask = np.zeros((64, 64, 64), "uint8"); mask[10:30, 10:30, 10:30] = 14; mask[35:45, 35:45, 35:45] = 17
    _write_nifti(str(out / "combined_labels.nii.gz"), mask)

    ud._admit_and_store(ct, str(out), "ePAI", "u1", "1.2.3.4", "s")
    stored = os.path.join(ud._root(), "image_only", "USER_00000001", "ct.nii.gz")
    assert os.path.exists(stored)
    with open(stored, "rb") as f:
        assert f.read(2) == b"\x1f\x8b"        # stored file is genuinely gzip
    assert np.asarray(nib.load(stored).dataobj).shape == (64, 64, 64)  # and loads back


def test_rejects_non_finite(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    vol = np.random.RandomState(2).uniform(-1000, 500, (64, 64, 64)).astype("float32")
    vol[0, 0, 0] = np.inf
    ct = str(tmp_path / "inf.nii.gz"); _write_nifti(ct, vol)
    ok, reason = ud.validate_ct(ct)
    assert not ok and reason == "non_finite_values"


# ----------------- duplicates are recognised cheaply and across users -----------------
def _scan_and_mask(tmp_path, np, name="ct.nii.gz"):
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    vol[30:34, 30:34, 30:34] = 400.0
    ct = str(tmp_path / name); _write_nifti(ct, vol)
    out = tmp_path / ("out_" + name.replace(".", "_")); out.mkdir()
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 10:30] = 14
    mask[35:45, 35:45, 35:45] = 17
    _write_nifti(str(out / "combined_labels.nii.gz"), mask)
    return ct, str(out)


def _reasons(ud):
    path = os.path.join(ud._root(), "rejections.jsonl")
    return [json.loads(l)["reason"] for l in open(path)] if os.path.exists(path) else []


def test_a_repeat_upload_is_recognised_before_any_decoding(ud, tmp_path, monkeypatch):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    ct, out = _scan_and_mask(tmp_path, np)
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")

    def must_not_run(*a, **k):
        raise AssertionError("decoded a scan that is already in the dataset")

    monkeypatch.setattr(ud, "validate_ct", must_not_run)
    monkeypatch.setattr(ud, "fingerprints", must_not_run)
    ud._admit_and_store(ct, out, "LesionSegmenter", "someone-else", "9.9.9.9", "s2")  # another user, another place
    assert _reasons(ud) == ["duplicate_exact"]
    assert not os.path.exists(os.path.join(ud._root(), "image_only", "USER_00000002"))


def test_the_same_scan_saved_uncompressed_is_still_a_duplicate(ud, tmp_path):
    # Different bytes (so a different file hash), identical voxels.
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    ct_gz, out = _scan_and_mask(tmp_path, np, "a.nii.gz")
    ct_raw, out2 = _scan_and_mask(tmp_path, np, "b.nii")
    ud._admit_and_store(ct_gz, out, "ePAI", "u1", "1.1.1.1", "s1")
    ud._admit_and_store(ct_raw, out2, "ePAI", "u2", "2.2.2.2", "s2")
    assert _reasons(ud) == ["duplicate_near"]
    assert not os.path.exists(os.path.join(ud._root(), "image_only", "USER_00000002"))


def test_case_metadata_records_geometry_and_not_the_uploaders_address(ud, tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("nibabel")
    ct, out = _scan_and_mask(tmp_path, np)
    ud._admit_and_store(ct, out, "ePAI", "u1", "203.0.113.7", "s1")
    meta = json.load(open(os.path.join(ud._root(), "mask_only", "USER_00000001", "metadata.json")))
    assert meta["shape"] == [64, 64, 64] and len(meta["spacing_mm"]) == 3
    assert "source_ip" not in meta and "203.0.113.7" not in json.dumps(meta)


def test_large_clinical_scans_are_within_the_default_limits(ud):
    assert ud.MAX_VOXELS >= 1_000_000_000      # 512 x 512 x 1394 is 365M
    assert ud.MAX_CT_BYTES >= 2 * 1024 ** 3


# ----------------- quality selection and the disk floor -----------------
def _scan_with_spacing(tmp_path, np, nib, name, zooms):
    vol = np.full((64, 64, 64), -1000.0, dtype="float32")
    vol[20:40, 20:40, 20:40] = 60.0
    vol[30:34, 30:34, 30:34] = 400.0
    ct = str(tmp_path / name)
    nib.save(nib.Nifti1Image(vol, np.diag([*zooms, 1.0])), ct)
    out = tmp_path / ("o_" + name.replace(".", "_")); out.mkdir()
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 10:30] = 14          # liver, away from the slice edges
    mask[35:45, 35:45, 35:45] = 17
    _write_nifti(str(out / "combined_labels.nii.gz"), mask)
    return ct, str(out)


def _meta(ud, case="USER_00000001"):
    return json.load(open(os.path.join(ud._root(), "mask_only", case, "metadata.json")))


def test_resolution_gate_turns_poor_scans_away_before_decoding(ud, tmp_path, monkeypatch):
    np = pytest.importorskip("numpy"); nib = pytest.importorskip("nibabel")
    assert ud.resolution_gate({"spacing_mm": [0.8, 0.8, 1.0]}) == (True, "ok")
    assert ud.resolution_gate({"spacing_mm": [1.0, 1.0, 5.0]})[0] is True       # PanTS-grade limit
    assert ud.resolution_gate({"spacing_mm": [0.8, 0.8, 7.5]})[1].startswith("slices_too_thick")
    assert ud.resolution_gate({"spacing_mm": [2.0, 2.0, 1.0]})[1].startswith("in_plane_too_coarse")
    assert ud.resolution_gate({"spacing_mm": [1.0, 6.0, 1.0]})[1].startswith("slices_too_thick")      # axis order does not matter
    assert ud.resolution_gate({"spacing_mm": [1.0, 5.0, 1.0]}) == (True, "ok")
    assert ud.resolution_gate({})[1] == "no_voxel_spacing"

    def must_not_run(*a, **k):
        raise AssertionError("decoded a scan that failed the resolution gate")
    monkeypatch.setattr(ud, "validate_ct", must_not_run)
    ct, out = _scan_with_spacing(tmp_path, np, nib, "thick.nii.gz", (0.8, 0.8, 7.5))
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")
    assert _reasons(ud) == ["slices_too_thick:7.50mm"]


def test_cases_are_tiered_high_or_standard(ud, tmp_path):
    np = pytest.importorskip("numpy"); nib = pytest.importorskip("nibabel")
    ct, out = _scan_with_spacing(tmp_path, np, nib, "fine.nii.gz", (0.8, 0.8, 1.0))
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")
    assert _meta(ud)["quality_tier"] == "high"
    ct, out = _scan_with_spacing(tmp_path, np, nib, "ok.nii.gz", (0.8, 0.8, 4.0))
    vol = np.full((64, 64, 64), -1000.0, dtype="float32"); vol[10:50, 10:50, 10:50] = 80.0; vol[30:34, 30:34, 30:34] = 500.0
    nib.save(nib.Nifti1Image(vol, np.diag([0.8, 0.8, 4.0, 1.0])), ct)      # different voxels: not a duplicate
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s2")
    assert _meta(ud, "USER_00000002")["quality_tier"] == "standard"        # thick slices


def test_an_organ_cut_off_by_the_scan_edge_downgrades_the_tier(ud, tmp_path):
    np = pytest.importorskip("numpy"); nib = pytest.importorskip("nibabel")
    ct, out = _scan_with_spacing(tmp_path, np, nib, "clip.nii.gz", (0.8, 0.8, 1.0))
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 0:20] = 14           # liver runs off the first slice
    mask[35:45, 35:45, 35:45] = 17
    _write_nifti(os.path.join(out, "combined_labels.nii.gz"), mask)
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")
    meta = _meta(ud)
    assert meta["segmentation_stats"]["edge_clipped_organs"] == 1 and meta["quality_tier"] == "standard"


def test_collection_pauses_when_the_disk_is_nearly_full(ud, tmp_path, monkeypatch):
    np = pytest.importorskip("numpy"); nib = pytest.importorskip("nibabel")
    ct, out = _scan_with_spacing(tmp_path, np, nib, "a.nii.gz", (0.8, 0.8, 1.0))
    monkeypatch.setattr(ud, "MIN_FREE_BYTES", 10 ** 18)        # more than any disk has
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s2")
    assert not os.path.exists(os.path.join(ud._root(), "image_only", "USER_00000001"))
    assert _reasons(ud) == ["disk_floor"]                      # noted once, not once per upload
    assert ud._load_registry(ud._root())["events"] == []       # and the attempts were not counted against quotas
    monkeypatch.setattr(ud, "MIN_FREE_BYTES", 0)
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s3")
    assert os.path.exists(os.path.join(ud._root(), "image_only", "USER_00000001"))


def test_unreadable_disk_means_do_not_collect(ud, tmp_path, monkeypatch):
    def boom(_):
        raise OSError("no such device")
    monkeypatch.setattr(ud.shutil, "disk_usage", boom)
    f = tmp_path / "x.nii.gz"; f.write_bytes(b"0" * 10)
    assert ud.has_room_for(str(tmp_path), str(f)) is False


def test_case_summary_marks_flagged_lesions_and_gives_organ_volumes(ud):
    geometry = {"spacing_mm": [1.0, 1.0, 2.0]}                      # 2 mm^3 per voxel
    stats = {"label_voxels": {14: 500_000, 17: 20_000, 22: 400, 33: 10}}
    s = ud.case_summary(geometry, stats)
    assert s["organ_volumes_ml"]["liver"] == 1000.0                  # 500k voxels * 2 mm^3 = 1 L
    assert s["lesion_flagged"] is True and s["lesions_flagged"] == {"pancreatic_lesion": 400}  # 10-voxel speck ignored
    assert ud.case_summary(geometry, {"label_voxels": {14: 5, 33: 10}})["lesion_flagged"] is False
    assert "organ_volumes_ml" not in ud.case_summary({}, stats)       # no spacing, no invented volumes


def test_admitted_case_records_what_is_in_it(ud, tmp_path):
    np = pytest.importorskip("numpy"); nib = pytest.importorskip("nibabel")
    ct, out = _scan_with_spacing(tmp_path, np, nib, "c.nii.gz", (1.0, 1.0, 1.0))
    mask = np.zeros((64, 64, 64), "uint8")
    mask[10:30, 10:30, 10:30] = 14            # liver
    mask[35:45, 35:45, 35:45] = 17            # pancreas
    mask[40:43, 40:43, 40:43] = 22            # a small 27-voxel lesion label (counted together with the one below)
    mask[50:56, 50:56, 20:26] = 22            # and 216 more voxels, so the label total clears the 50-voxel floor
    _write_nifti(os.path.join(out, "combined_labels.nii.gz"), mask)
    ud._admit_and_store(ct, out, "ePAI", "u1", "1.1.1.1", "s1")
    meta = _meta(ud)
    assert meta["lesion_flagged"] is True and "pancreatic_lesion" in meta["lesions_flagged"]
    assert meta["organ_volumes_ml"]["liver"] == 8.0
