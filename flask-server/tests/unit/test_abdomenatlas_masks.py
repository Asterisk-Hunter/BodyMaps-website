"""The AbdomenAtlas mask builder: per-organ files -> one viewer label map per scan."""
import json
import os
import sys

import nibabel as nib
import numpy as np
import pytest

from services.label_scheme import VIEWER_IDS

# scripts/ is not a package. Put it on sys.path so the worker processes of --workers can import the
# module by name too (they are spawned, not forked, on some platforms).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
import build_abdomenatlas_masks as builder  # noqa: E402

SHAPE = (20, 18, 16)
AFFINE = np.array([[-0.8, 0, 0, 100.0], [0, -0.8, 0, 80.0], [0, 0, 2.5, -200.0], [0, 0, 0, 1.0]])


def write_mask(seg_dir, stem, box, shape=SHAPE, dtype=np.uint8):
    data = np.zeros(shape, dtype=dtype)
    if box is not None:
        (x0, x1), (y0, y1), (z0, z1) = box
        data[x0:x1, y0:y1, z0:z1] = 1
    img = nib.Nifti1Image(data, AFFINE)
    img.set_data_dtype(dtype)
    seg_dir.mkdir(parents=True, exist_ok=True)
    nib.save(img, str(seg_dir / f"{stem}.nii.gz"))


def write_ct(data, case, shape=SHAPE, affine=AFFINE):
    path = data / "image_only" / case / "ct.nii.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    img = nib.Nifti1Image(np.zeros(shape, dtype=np.int16), affine)
    img.set_data_dtype(np.int16)
    nib.save(img, str(path))


def make_case(data, case, files, ct=True):
    """A scan's per-organ masks, and (unless ``ct`` is False) a CT on the same grid, which the builder checks."""
    seg_dir = data / "mask_only" / case / "segmentations"
    for stem, box in files.items():
        write_mask(seg_dir, stem, box)
    if ct:
        write_ct(data, case)
    return seg_dir


def read(out, case):
    img = nib.load(str(out / "mask_only" / case / "combined_labels.nii.gz"))
    return np.asanyarray(img.dataobj), img


@pytest.fixture()
def dirs(tmp_path):
    data, out = tmp_path / "data", tmp_path / "overlay"
    data.mkdir()
    return data, out


def test_each_structure_gets_its_viewer_label_and_the_grid_is_kept(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000001", {
        "liver": ((0, 8), (0, 8), (0, 8)),
        "spleen": ((10, 16), (10, 16), (4, 12)),
    })
    res = builder.build_case("BDMAP_00000001", str(data), str(out), False)
    assert res["status"] == "built" and res["shape"] == list(SHAPE)
    labels, img = read(out, "BDMAP_00000001")
    assert labels.dtype == np.uint8
    assert np.allclose(img.affine, AFFINE), "the mask must sit on the scan's grid"
    assert set(np.unique(labels)) == {0, VIEWER_IDS["liver"], VIEWER_IDS["spleen"]}
    assert labels[2, 2, 2] == VIEWER_IDS["liver"] and labels[12, 12, 6] == VIEWER_IDS["spleen"]
    assert res["labels"] == {VIEWER_IDS["liver"]: 512, VIEWER_IDS["spleen"]: 6 * 6 * 8}


def test_a_lesion_is_drawn_over_its_organ_and_a_part_over_the_whole(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000002", {
        "liver": ((0, 10), (0, 10), (0, 10)),
        "liver_lesion": ((2, 4), (2, 4), (2, 4)),
        "pancreas": ((12, 18), (0, 8), (0, 8)),
        "pancreas_head": ((12, 15), (0, 8), (0, 8)),
        "veins": ((0, 10), (0, 1), (0, 10)),
    })
    builder.build_case("BDMAP_00000002", str(data), str(out), False)
    labels, _ = read(out, "BDMAP_00000002")
    assert labels[3, 3, 3] == VIEWER_IDS["liver_lesion"], "lesion over liver"
    assert labels[5, 5, 5] == VIEWER_IDS["liver"]
    assert labels[13, 4, 4] == VIEWER_IDS["pancreas_head"], "part over the whole pancreas"
    assert labels[16, 4, 4] == VIEWER_IDS["pancreas"]
    assert labels[5, 0, 5] == VIEWER_IDS["veins"], "vessel over the organ it runs through"


def test_files_the_viewer_has_no_label_for_are_not_drawn(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000003", {
        "liver": ((0, 8), (0, 8), (0, 8)),
        "rectum": ((10, 14), (10, 14), (10, 14)),
        "liver_segment_4": ((0, 4), (0, 4), (0, 4)),
        "celiac_trunk": ((15, 17), (15, 17), (1, 3)),
    })
    builder.build_case("BDMAP_00000003", str(data), str(out), False)
    labels, _ = read(out, "BDMAP_00000003")
    assert set(np.unique(labels)) == {0, VIEWER_IDS["liver"]}


def test_a_scan_with_nothing_the_viewer_can_show_writes_no_file(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000004", {"liver": None, "rectum": ((0, 4), (0, 4), (0, 4))})
    make_case(data, "BDMAP_00000005", {})
    for case in ("BDMAP_00000004", "BDMAP_00000005"):
        assert builder.build_case(case, str(data), str(out), False)["status"] == "empty"
        assert not (out / "mask_only" / case).exists()


def test_a_mask_on_another_grid_is_an_error_not_a_wrong_mask(dirs):
    data, out = dirs
    seg = make_case(data, "BDMAP_00000006", {"liver": ((0, 4), (0, 4), (0, 4))})
    write_mask(seg, "spleen", ((0, 2), (0, 2), (0, 2)), shape=(10, 10, 10))
    res = builder.build_case("BDMAP_00000006", str(data), str(out), False)
    assert res["status"] == "error" and "grid" in res["error"]
    assert not (out / "mask_only" / "BDMAP_00000006").exists()


def test_a_unreadable_mask_is_reported_and_does_not_stop_the_run(dirs):
    data, out = dirs
    seg = make_case(data, "BDMAP_00000007", {"liver": ((0, 4), (0, 4), (0, 4))})
    (seg / "spleen.nii.gz").write_bytes(b"not a nifti")
    make_case(data, "BDMAP_00000008", {"liver": ((0, 4), (0, 4), (0, 4))})
    summary = builder.run(["BDMAP_00000007", "BDMAP_00000008"], str(data), str(out))
    assert summary["built"] == 1 and list(summary["errors"]) == ["BDMAP_00000007"]
    assert summary["scans_per_label"] == {str(VIEWER_IDS["liver"]): 1}


def _shifted(affine, voxels):
    """``affine`` for a grid whose voxel (0, 0, 0) is voxel ``voxels`` of the grid ``affine`` describes."""
    out = affine.copy()
    out[:3, 3] = (affine @ np.array([*voxels, 1.0]))[:3]
    return out


def test_a_mask_cropped_out_of_its_ct_is_placed_on_the_cts_grid(dirs):
    """The Atlas masks are stored as boxes of the CT: they must land where they belong, not at the corner."""
    data, out = dirs
    case = "BDMAP_00000020"
    ct_shape = (30, 28, 16)
    write_ct(data, case, shape=ct_shape)
    seg = data / "mask_only" / case / "segmentations"
    cropped = _shifted(AFFINE, (5, 4, 0))
    for stem, box in (("liver", ((0, 8), (0, 8), (0, 8))), ("spleen", ((10, 16), (10, 16), (4, 12)))):
        arr = np.zeros(SHAPE, dtype=np.uint8)
        (x0, x1), (y0, y1), (z0, z1) = box
        arr[x0:x1, y0:y1, z0:z1] = 1
        seg.mkdir(parents=True, exist_ok=True)
        nib.save(nib.Nifti1Image(arr, cropped), str(seg / f"{stem}.nii.gz"))
    res = builder.build_case(case, str(data), str(out), False)
    assert res["status"] == "built" and res["shape"] == list(ct_shape)
    labels, img = read(out, case)
    assert labels.shape == ct_shape and np.allclose(img.affine, AFFINE), "the CT's own grid"
    assert labels[5, 4, 0] == VIEWER_IDS["liver"] and labels[12, 11, 7] == VIEWER_IDS["liver"]
    assert labels[4, 4, 0] == 0 and labels[5, 3, 0] == 0, "nothing is drawn outside the box"
    assert labels[15, 14, 4] == VIEWER_IDS["spleen"] and labels[20, 19, 11] == VIEWER_IDS["spleen"]
    assert int(np.count_nonzero(labels == VIEWER_IDS["liver"])) == 512


def test_a_mask_that_cannot_be_matched_to_its_ct_is_an_error_and_writes_nothing(dirs):
    data, out = dirs
    liver = {"liver": ((0, 4), (0, 4), (0, 4))}
    cases = {}
    cases["BDMAP_00000021"] = ("the CT cannot be read", lambda c: make_case(data, c, liver, ct=False))   # no CT at all
    cases["BDMAP_00000022"] = ("voxel size or orientation", lambda c: (
        make_case(data, c, liver, ct=False), write_ct(data, c, affine=AFFINE * np.array([[2], [2], [1], [1]]))))
    cases["BDMAP_00000023"] = ("voxel grid", lambda c: (
        make_case(data, c, liver, ct=False), write_ct(data, c, shape=(30, 28, 16), affine=_shifted(AFFINE, (-0.4, 0, 0)))))
    cases["BDMAP_00000024"] = ("outside the CT", lambda c: (
        make_case(data, c, liver, ct=False), write_ct(data, c, shape=(3, 3, 3))))
    for case, (message, lay_out) in cases.items():
        lay_out(case)
        res = builder.build_case(case, str(data), str(out), False)
        assert res["status"] == "error" and message in res["error"], (case, res)
        if message == "the CT cannot be read":
            assert "FileNotFoundError: " in res["error"], "the OS's own reason follows the exception class"
        assert not (out / "mask_only" / case).exists(), "no half-checked mask may be published"


def test_a_corrupt_ct_is_an_error_not_a_crash(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000025", {"liver": ((0, 4), (0, 4), (0, 4))}, ct=False)
    ct = data / "image_only" / "BDMAP_00000025" / "ct.nii.gz"
    ct.parent.mkdir(parents=True)
    ct.write_bytes(b"not a nifti")
    res = builder.build_case("BDMAP_00000025", str(data), str(out), False)
    assert res["status"] == "error" and "the CT cannot be read" in res["error"]


def test_it_resumes_and_force_rebuilds(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000009", {"liver": ((0, 4), (0, 4), (0, 4))})
    assert builder.build_case("BDMAP_00000009", str(data), str(out), False)["status"] == "built"
    assert builder.build_case("BDMAP_00000009", str(data), str(out), False)["status"] == "skipped"
    write_mask(data / "mask_only" / "BDMAP_00000009" / "segmentations", "liver", ((0, 8), (0, 8), (0, 8)))
    assert builder.build_case("BDMAP_00000009", str(data), str(out), True)["status"] == "built"
    labels, _ = read(out, "BDMAP_00000009")
    assert int(np.count_nonzero(labels)) == 512


def test_no_partial_file_is_left_behind(dirs):
    data, out = dirs
    make_case(data, "BDMAP_00000010", {"liver": ((0, 4), (0, 4), (0, 4))})
    builder.build_case("BDMAP_00000010", str(data), str(out), False)
    assert os.listdir(out / "mask_only" / "BDMAP_00000010") == ["combined_labels.nii.gz"]


def test_the_dataset_is_only_read(dirs):
    data, out = dirs
    seg = make_case(data, "BDMAP_00000011", {"liver": ((0, 4), (0, 4), (0, 4))})
    before = {p: p.stat().st_mtime_ns for p in seg.iterdir()}
    builder.build_case("BDMAP_00000011", str(data), str(out), False)
    assert {p: p.stat().st_mtime_ns for p in seg.iterdir()} == before
    assert sorted(os.listdir(data / "mask_only" / "BDMAP_00000011")) == ["segmentations"]


def test_list_cases_takes_only_case_folders_and_honours_only(dirs):
    data, _out = dirs
    for case in ("BDMAP_00000012", "BDMAP_00000013", "BDMAP_0000014", "notes", "BDMAP_00000015.tar"):
        (data / "mask_only" / case).mkdir(parents=True)
    assert builder.list_cases(str(data)) == ["BDMAP_00000012", "BDMAP_00000013"]
    assert builder.list_cases(str(data), ["BDMAP_00000013", "BDMAP_00000099"]) == ["BDMAP_00000013"]


def test_the_command_line_builds_everything_and_writes_a_summary(dirs, monkeypatch, capsys):
    data, out = dirs
    for i in (16, 17, 18):
        make_case(data, f"BDMAP_{i:08d}", {"liver": ((0, 4), (0, 4), (0, 4))})
    assert builder.main(["--data", str(data), "--out", str(out), "--workers", "2"]) == 0
    summary = json.loads((out / "abdomenatlas_masks.json").read_text())
    assert summary["built"] == 3 and summary["errors"] == {}
    assert "MASKS_DONE built=3" in capsys.readouterr().out
    # a trial run (--limit) or a single scan never rewrites the summary
    (out / "abdomenatlas_masks.json").unlink()
    assert builder.main(["--data", str(data), "--out", str(out), "--limit", "1", "--force"]) == 0
    assert builder.main(["--data", str(data), "--out", str(out), "--only", "BDMAP_00000016", "--force"]) == 0
    assert not (out / "abdomenatlas_masks.json").exists()


def test_the_exit_code_says_a_scan_failed(dirs):
    data, out = dirs
    seg = make_case(data, "BDMAP_00000019", {"liver": ((0, 4), (0, 4), (0, 4))})
    (seg / "spleen.nii.gz").write_bytes(b"garbage")
    assert builder.main(["--data", str(data), "--out", str(out)]) == 1
