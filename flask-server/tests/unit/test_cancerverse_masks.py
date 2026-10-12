"""The CancerVerse mask builder: tumor masks from the label archive -> one viewer label map per scan."""
import gzip
import io
import json
import os
import sys
import tarfile

import nibabel as nib
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))
import build_cancerverse_masks as bcm  # noqa: E402
from services.cancerverse_catalog import LESION_LABEL_IDS, LESION_TYPES, resolve_mask_path  # noqa: E402

SHAPE = (40, 36, 30)
AFFINE = np.array([[-0.8, 0, 0, 120.0], [0, -0.8, 0, 90.0], [0, 0, 2.0, -300.0], [0, 0, 0, 1.0]])


def nifti_gz(array, affine=AFFINE, dtype=None):
    img = nib.Nifti1Image(array, affine)
    if dtype is not None:
        img.set_data_dtype(dtype)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(img.to_bytes())
    return buf.getvalue()


def block(x0, x1, y0=5, y1=15, z0=5, z1=15):
    a = np.zeros(SHAPE, dtype=np.uint8)
    a[x0:x1, y0:y1, z0:z1] = 1
    return a


def case_members(**tumors):
    """All 13 mask files of a scan: empty except the given {stem: array}."""
    members = {stem: nifti_gz(np.zeros(SHAPE, dtype=np.uint8)) for stem in LESION_TYPES}
    for stem, arr in tumors.items():
        members[stem] = nifti_gz(arr)
    return members


def write_tar(path, cases):
    with tarfile.open(path, "w:gz") as tf:
        for case, members in cases.items():
            for stem, raw in members.items():
                info = tarfile.TarInfo(f"CancerVerse/{case}/segmentations/{stem}.nii.gz")
                info.size = len(raw)
                tf.addfile(info, io.BytesIO(raw))


def write_index(path, tumors_by_case):
    cases = {c: {"tumors": t, "volumes_ml": {o: 1.0 for o in t}, "shape": list(SHAPE), "spacing": [0.8, 0.8, 2.0]}
             for c, t in tumors_by_case.items()}
    path.write_text(json.dumps({"version": 1, "cases": cases}))


def load(out, case):
    img = nib.load(str(out / "mask_only" / case / "combined_labels.nii.gz"))
    return img, np.asarray(img.dataobj)


@pytest.fixture()
def rig(tmp_path):
    cases = {
        "CV_00000001": case_members(liver_lesion=block(5, 12)),
        "CV_00000002": case_members(),                                         # no tumor at all
        "CV_00000003": case_members(kidney_lesion=block(3, 8), stomach_lesion=block(20, 28),
                                    pancreatic_lesion=block(30, 35)),
        "CV_00000004": case_members(liver_lesion=block(2, 30), colon_lesion=block(10, 14)),   # overlap
    }
    tar = tmp_path / "labels.tar.gz"
    write_tar(tar, cases)
    index = tmp_path / "index.json"
    write_index(index, {
        "CV_00000001": ["liver"], "CV_00000002": [],
        "CV_00000003": ["kidney", "stomach", "pancreas"], "CV_00000004": ["liver", "colon"],
    })
    out = tmp_path / "overlay"
    out.mkdir()
    return tmp_path, tar, index, out


def build(rig, *extra):
    _, tar, index, out = rig
    return bcm.main(["--labels", str(tar), "--index", str(index), "--out", str(out), *extra])


# ------------------------------------------------------------------ what gets built
def test_only_scans_with_a_tumor_get_a_mask(rig):
    _, _, _, out = rig
    assert build(rig) == 0
    built = sorted(p.name for p in (out / "mask_only").iterdir())
    assert built == ["CV_00000001", "CV_00000003", "CV_00000004"]
    assert resolve_mask_path("CV_00000002", str(out)) is None
    assert resolve_mask_path("CV_00000001", str(out)).endswith("combined_labels.nii.gz")


def test_each_tumor_type_gets_its_viewer_label_id(rig):
    _, _, _, out = rig
    build(rig)
    _, data = load(out, "CV_00000003")
    assert set(np.unique(data).tolist()) == {0, LESION_LABEL_IDS["kidney_lesion"],
                                             LESION_LABEL_IDS["stomach_lesion"],
                                             LESION_LABEL_IDS["pancreatic_lesion"]}
    assert (data[3:8, 5:15, 5:15] == 34).all() and (data[20:28, 5:15, 5:15] == 36).all()
    assert (data[30:35, 5:15, 5:15] == 22).all()
    assert (data[0:3] == 0).all()


def test_the_mask_is_a_uint8_volume_on_the_scans_own_grid(rig):
    _, _, _, out = rig
    build(rig)
    img, data = load(out, "CV_00000001")
    assert data.dtype == np.uint8 and data.shape == SHAPE
    assert np.allclose(img.affine, AFFINE), "the mask must sit on the CT's grid"
    assert img.get_data_dtype() == np.uint8


def test_a_smaller_tumor_stays_visible_where_it_overlaps_a_larger_one(rig):
    _, _, _, out = rig
    build(rig)
    _, data = load(out, "CV_00000004")
    assert (data[10:14, 5:15, 5:15] == LESION_LABEL_IDS["colon_lesion"]).all()       # the small one, on top
    assert data[2, 10, 10] == LESION_LABEL_IDS["liver_lesion"]                       # the big one around it
    assert (data[20:30, 5:15, 5:15] == LESION_LABEL_IDS["liver_lesion"]).all()


def test_ids_match_the_names_the_frontend_and_meshes_use():
    """The ids are baked into the files: renumbering would silently relabel every mask."""
    assert LESION_LABEL_IDS == {
        "pancreatic_lesion": 22, "liver_lesion": 33, "kidney_lesion": 34, "colon_lesion": 35,
        "stomach_lesion": 36, "adrenal_gland_lesion": 37, "bladder_lesion": 38, "prostate_lesion": 39,
        "esophagus_lesion": 40, "spleen_lesion": 41, "uterus_lesion": 42, "duodenum_lesion": 43,
        "gallbladder_lesion": 44,
    }
    assert set(LESION_LABEL_IDS) == set(LESION_TYPES), "every released tumor type needs a viewer label"
    from services.mesh_generation import LABELS
    for stem, label_id in LESION_LABEL_IDS.items():
        assert LABELS[label_id]["key"] == stem


# --------------------------------------------------------------- resume, force, trial runs, summary
def test_a_second_run_skips_finished_scans_and_force_rebuilds(rig):
    _, _, _, out = rig
    build(rig)
    path = out / "mask_only" / "CV_00000001" / "combined_labels.nii.gz"
    first = path.stat().st_mtime_ns
    summary = json.loads((out / "cancerverse_masks.json").read_text())
    assert summary["built"] == 3
    assert build(rig) == 0
    assert path.stat().st_mtime_ns == first
    assert json.loads((out / "cancerverse_masks.json").read_text())["skipped"] == 3
    build(rig, "--force")
    assert path.stat().st_mtime_ns > first


def test_only_and_limit_for_trial_runs(rig):
    _, _, _, out = rig
    build(rig, "--only", "CV_00000003")
    assert [p.name for p in (out / "mask_only").iterdir()] == ["CV_00000003"]
    assert not (out / "cancerverse_masks.json").exists(), "a partial run must not write the full-run summary"


def test_the_summary_counts_scans_per_label(rig):
    _, _, _, out = rig
    build(rig)
    s = json.loads((out / "cancerverse_masks.json").read_text())
    assert s["scans_per_label"] == {"22": 1, "33": 2, "34": 1, "35": 1, "36": 1}
    assert s["errors"] == {} and s["not_in_archive"] == [] and s["empty"] == []


# ------------------------------------------------------------------------------- bad input
def test_one_corrupt_mask_is_reported_and_does_not_stop_the_run(rig):
    tmp, tar, index, out = rig
    cases = {
        "CV_00000001": case_members(liver_lesion=block(5, 12)),
        "CV_00000003": {**case_members(), "kidney_lesion": b"this is not a gzip file"},
        "CV_00000004": case_members(liver_lesion=block(2, 30)),
    }
    write_tar(tar, cases)
    write_index(index, {"CV_00000001": ["liver"], "CV_00000003": ["kidney"], "CV_00000004": ["liver"]})
    assert build(rig) == 1, "an error must make the exit code non-zero"
    assert sorted(p.name for p in (out / "mask_only").iterdir()) == ["CV_00000001", "CV_00000004"]
    errors = json.loads((out / "cancerverse_masks.json").read_text())["errors"]
    assert list(errors) == ["CV_00000003"]


def test_an_indexed_tumor_whose_masks_are_empty_is_reported_not_built(rig):
    tmp, tar, index, out = rig
    write_tar(tar, {"CV_00000001": case_members()})
    write_index(index, {"CV_00000001": ["liver"]})
    build(rig)
    assert not (out / "mask_only" / "CV_00000001").exists()
    assert json.loads((out / "cancerverse_masks.json").read_text())["empty"] == ["CV_00000001"]


def test_a_scan_the_index_lists_but_the_archive_lacks_is_reported(rig):
    tmp, tar, index, out = rig
    write_index(index, {"CV_00000001": ["liver"], "CV_00000099": ["liver"]})
    build(rig)
    assert json.loads((out / "cancerverse_masks.json").read_text())["not_in_archive"] == ["CV_00000099"]


def test_masks_of_different_grids_are_refused(rig):
    other = np.zeros((20, 20, 20), dtype=np.uint8)
    other[2:5, 2:5, 2:5] = 1
    members = case_members(liver_lesion=block(5, 12))
    members["kidney_lesion"] = nifti_gz(other)
    with pytest.raises(ValueError, match="differs"):
        bcm.combine_case(members, ["liver_lesion", "kidney_lesion"])


def test_no_partial_files_are_left_behind(rig):
    _, _, _, out = rig
    build(rig)
    leftovers = [p for p in (out / "mask_only").rglob("*") if p.is_file() and p.name != "combined_labels.nii.gz"]
    assert leftovers == []


def test_masks_stored_as_float_or_with_a_scale_are_read_by_value(rig):
    """The released masks come in assorted datatypes; 'above 0.5' must hold for all of them."""
    members = {stem: nifti_gz(np.zeros(SHAPE, dtype=np.float32), dtype=np.float32) for stem in LESION_TYPES}
    members["liver_lesion"] = nifti_gz(block(5, 12).astype(np.float32), dtype=np.float32)
    labels, _, counts = bcm.combine_case(members, ["liver_lesion"])
    assert counts == {33: 10 * 7 * 10}
    assert int((labels == 33).sum()) == 700


def test_parallel_workers_build_the_same_masks(rig, tmp_path):
    _, _, _, out = rig
    build(rig, "--workers", "2")
    parallel = {c: load(out, c)[1].copy() for c in ("CV_00000001", "CV_00000003", "CV_00000004")}
    out2 = tmp_path / "serial"
    out2.mkdir()
    _, tar, index, _ = rig
    bcm.main(["--labels", str(tar), "--index", str(index), "--out", str(out2)])
    for case, data in parallel.items():
        assert np.array_equal(data, load(out2, case)[1])
