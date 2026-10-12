"""The label-archive indexer: touched vs untouched masks, erased annotations, QC, archive input."""
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
import build_cancerverse_index as bci  # noqa: E402
from services.cancerverse_catalog import LESION_TYPES  # noqa: E402

SHAPE = (48, 40, 30)
SPACING = (0.5, 0.5, 2.0)          # 1 voxel = 0.5 mm^3 = 0.0005 mL


def nifti_gz(array, slope=None, inter=None, level=9):
    img = nib.Nifti1Image(array, np.diag(list(SPACING) + [1.0]))
    if slope is not None:
        img.header.set_slope_inter(slope, inter)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=level) as gz:
        gz.write(img.to_bytes())
    return buf.getvalue()


def mask(voxels):
    a = np.zeros(SHAPE, dtype=np.uint8)
    for k in range(voxels):
        a[10 + k % 20, 12, 5 + k // 20] = 1
    return a


def case_masks(tumors=None):
    """13 masks, all empty except {stem: voxel count}."""
    tumors = tumors or {}
    return {stem: nifti_gz(mask(tumors.get(stem, 0))) for stem in LESION_TYPES}


def erased_annotation():
    """An EMPTY mask saved by a different writer: all zeros, but a larger file than a never-touched one."""
    raw = nifti_gz(mask(0), level=1)
    assert len(raw) > len(nifti_gz(mask(0)))
    return raw


def test_counts_voxels_exactly_and_reports_geometry():
    voxels, info = bci.count_foreground(nifti_gz(mask(37)))
    assert voxels == 37
    assert info["shape"] == list(SHAPE)
    assert info["spacing"] == pytest.approx(list(SPACING))
    assert bci.count_foreground(nifti_gz(mask(0)))[0] == 0


def test_scaled_masks_decode_before_thresholding():
    # raw 1 decodes to 1*2 - 1 = 1 (foreground); raw 0 decodes to -1 (background)
    a = mask(11)
    assert bci.count_foreground(nifti_gz(a, slope=2.0, inter=-1.0))[0] == 11
    # PanTS-style int8 masks store background as raw -128 (decoded 0.0)
    b = np.full(SHAPE, -128, dtype=np.int8)
    b[3:5, 3, 3] = 127
    assert bci.count_foreground(nifti_gz(b, slope=1 / 255, inter=0.5019608))[0] == 2


def test_a_tiny_tumor_is_found_with_its_volume():
    members = case_masks({"pancreatic_lesion": 3})
    assert len(members["pancreatic_lesion"]) > len(members["liver_lesion"])
    res = bci.process_case("CV_00000001", members)
    assert res["tumors"] == ["pancreas"]
    assert res["volumes_ml"]["pancreas"] == pytest.approx(3 * 0.5 * 0.5 * 2.0 / 1000, abs=1e-3)


def test_empty_scan_has_no_tumors_and_several_organs_are_reported_largest_first():
    for exact in (False, True):
        assert bci.process_case("CV_00000002", case_masks(), exact=exact)["tumors"] == []
        res = bci.process_case("CV_00000003", case_masks({"liver_lesion": 40, "kidney_lesion": 5}), exact=exact)
        assert res["tumors"] == ["liver", "kidney"]
        assert list(res["volumes_ml"]) == ["liver", "kidney"]


def test_an_erased_annotation_is_not_reported_as_a_tumor():
    """Real data: annotators saved all-zero masks with a different (larger) file size. Size alone
    would call these tumors (about 4% of touched masks in CancerVerse); content decides."""
    members = case_masks({"colon_lesion": 9})
    members["pancreatic_lesion"] = erased_annotation()
    assert len(members["pancreatic_lesion"]) > len(members["bladder_lesion"])      # looks touched by size
    res = bci.process_case("CV_00000005", members)
    assert res["tumors"] == ["colon"]
    assert res["touched_without_tumor"] == 1


def test_default_and_exact_modes_agree_on_which_organs_have_tumors():
    members = case_masks({"colon_lesion": 9, "spleen_lesion": 120, "uterus_lesion": 1})
    members["liver_lesion"] = erased_annotation()
    assert bci.process_case("c", members)["tumors"] == bci.process_case("c", members, exact=True)["tumors"]


def test_qc_verifies_every_untouched_mask_without_finding_a_tumor():
    res = bci.process_case("CV_00000004", case_masks({"colon_lesion": 9}), qc=True)
    assert (res["qc_checked"], res["qc_untouched_with_tumor"]) == (12, 0)


def test_qc_catches_a_tumor_hiding_in_an_untouched_looking_mask(monkeypatch):
    members = case_masks()
    real = bci.count_foreground
    monkeypatch.setattr(bci, "count_foreground", lambda raw: (7, real(raw)[1]))   # pretend the data held voxels
    res = bci.process_case("CV_00000006", members, qc=True)
    assert res["qc_untouched_with_tumor"] == 13
    assert len(res["tumors"]) == 13


def test_too_few_masks_are_always_decompressed():
    members = {"liver_lesion": nifti_gz(mask(7)), "kidney_lesion": nifti_gz(mask(0))}
    res = bci.process_case("CV_00000007", members)
    assert res["tumors"] == ["liver"] and res["volumes_ml"]["liver"] > 0


def write_tar(path, cases):
    with tarfile.open(path, "w:gz") as tf:
        for case, members in cases.items():
            for stem, raw in members.items():
                info = tarfile.TarInfo(f"CancerVerse/CancerVerse/{case}/segmentations/{stem}.nii.gz")
                info.size = len(raw)
                tf.addfile(info, io.BytesIO(raw))


@pytest.mark.parametrize("workers", [1, 2])
def test_index_from_archive_matches_directory_input(tmp_path, workers):
    erased = case_masks({"colon_lesion": 80, "stomach_lesion": 4})
    erased["uterus_lesion"] = erased_annotation()
    cases = {"CV_00000001": case_masks({"liver_lesion": 30}), "CV_00000002": case_masks(), "CV_00000003": erased}
    tar_path = tmp_path / "labels.tar.gz"
    write_tar(tar_path, cases)
    from_tar = bci.build_index(bci.iter_cases_from_tar(str(tar_path)), workers=workers, qc_every=1, progress_every=0)

    root = tmp_path / "extracted"
    for case, members in cases.items():
        seg = root / case / "segmentations"
        seg.mkdir(parents=True)
        for stem, raw in members.items():
            (seg / f"{stem}.nii.gz").write_bytes(raw)
    from_dir = bci.build_index(bci.iter_cases_from_dir(str(root)), workers=1, qc_every=1, progress_every=0)

    assert from_tar["cases"] == from_dir["cases"]
    assert from_tar["scans"] == 3 and from_tar["scans_with_tumor"] == 2 and from_tar["mode"] == "checked"
    assert from_tar["cases"]["CV_00000002"]["tumors"] == []
    assert from_tar["cases"]["CV_00000003"]["tumors"] == ["colon", "stomach"]       # larger first; erased uterus absent
    assert from_tar["touched_masks_without_tumor"] == 1
    # untouched masks per scan: 12 (one tumor) + 13 (none) + 10 (two tumors and one erased annotation)
    assert from_tar["qc"] == {"untouched_masks_verified": 12 + 13 + 10, "untouched_masks_with_tumor": 0}


def test_exact_mode_decides_by_content_everywhere(tmp_path):
    tar_path = tmp_path / "labels.tar.gz"
    write_tar(tar_path, {"CV_00000001": case_masks({"liver_lesion": 30})})
    index = bci.build_index(bci.iter_cases_from_tar(str(tar_path)), exact=True, progress_every=0)
    assert index["mode"] == "exact"
    assert index["cases"]["CV_00000001"]["volumes_ml"]["liver"] == pytest.approx(30 * 0.5 * 0.5 * 2.0 / 1000, abs=1e-3)


def test_main_writes_atomically_and_the_catalog_can_read_it(tmp_path):
    from services import cancerverse_catalog as cv
    tar_path, out = tmp_path / "labels.tar.gz", tmp_path / "idx.json"
    write_tar(tar_path, {"CV_00000001": case_masks({"pancreatic_lesion": 12})})
    assert bci.main(["--labels", str(tar_path), "--out", str(out), "--qc-every", "1"]) == 0
    assert not (tmp_path / "idx.json.tmp").exists()
    loaded = cv.load_case_index(str(out))
    assert cv.tumor_types_for_case(loaded["CV_00000001"]) == ("pancreas",)
    assert loaded["CV_00000001"]["shape"] == list(SHAPE)
    assert json.loads(out.read_text())["version"] == 1


def test_main_exits_non_zero_when_qc_finds_a_tumor_in_an_untouched_mask(tmp_path, monkeypatch):
    tar_path = tmp_path / "labels.tar.gz"
    write_tar(tar_path, {"CV_00000001": case_masks()})
    real = bci.count_foreground
    monkeypatch.setattr(bci, "count_foreground", lambda raw: (3, real(raw)[1]))
    assert bci.main(["--labels", str(tar_path), "--out", str(tmp_path / "idx.json"), "--qc-every", "1"]) == 1


def _metadata(path, ids):
    path.write_text("CancerVerse ID,sex\n" + "".join(f"{i},M\n" for i in ids))
    return str(path)


def test_a_truncated_archive_is_refused_when_checked_against_the_metadata(tmp_path, capsys):
    """tarfile ends quietly at a cut, so a half-downloaded archive used to give a 'valid' partial index."""
    tar_path, out = tmp_path / "labels.tar.gz", tmp_path / "idx.json"
    write_tar(tar_path, {"CV_00000001": case_masks({"liver_lesion": 9}), "CV_00000002": case_masks()})
    csv_path = _metadata(tmp_path / "meta.csv", ["CV_00000001", "CV_00000002", "CV_00000003", "CV_00000004"])
    assert bci.main(["--labels", str(tar_path), "--out", str(out), "--metadata", csv_path]) == 2
    assert not out.exists() and not (tmp_path / "idx.json.tmp").exists()
    assert "Index NOT written" in capsys.readouterr().err


def test_a_few_unlabelled_scans_are_tolerated(tmp_path):
    """The real release has 24,422 scans in the CSV and 24,420 label folders."""
    tar_path, out = tmp_path / "labels.tar.gz", tmp_path / "idx.json"
    write_tar(tar_path, {f"CV_{i:08d}": case_masks() for i in range(1, 11)})
    csv_path = _metadata(tmp_path / "meta.csv", [f"CV_{i:08d}" for i in range(1, 11)] + ["CV_00000099"])
    assert bci.main(["--labels", str(tar_path), "--out", str(out), "--metadata", csv_path, "--max-missing", "0.2"]) == 0
    assert out.exists()
    assert bci.main(["--labels", str(tar_path), "--out", str(tmp_path / "strict.json"), "--metadata", csv_path]) == 2


def test_an_empty_archive_is_never_a_valid_index(tmp_path):
    tar_path, out = tmp_path / "labels.tar.gz", tmp_path / "idx.json"
    write_tar(tar_path, {})
    csv_path = _metadata(tmp_path / "meta.csv", [])
    assert bci.main(["--labels", str(tar_path), "--out", str(out), "--metadata", csv_path]) == 2
    assert not out.exists()
