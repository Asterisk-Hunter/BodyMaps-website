"""Combining uploaded label files into one mask (NiftiProcessor.combine_labels)."""
import gzip
import io

import nibabel as nib
import numpy as np
import pytest
from werkzeug.datastructures import FileStorage, MultiDict

from services.label_scheme import VIEWER_IDS
from services.nifti_processor import NiftiProcessor

SHAPE = (12, 10, 8)


def upload(name, box, value=1):
    data = np.zeros(SHAPE, dtype=np.uint8)
    (x0, x1), (y0, y1), (z0, z1) = box
    data[x0:x1, y0:y1, z0:z1] = value
    raw = gzip.compress(nib.Nifti1Image(data, np.eye(4)).to_bytes())
    return FileStorage(stream=io.BytesIO(raw), filename=name)


@pytest.fixture()
def processor(tmp_path):
    return NiftiProcessor(main_nifti_path=None, clabel_path=str(tmp_path / "combined_labels.nii.gz"))


def test_the_organ_name_is_the_file_name_without_its_extension(processor):
    clean = NiftiProcessor.clean_organ_name
    assert clean("liver.nii.gz") == "liver"
    assert clean("segmentations/kidney_left.nii") == "kidney_left"
    assert clean("/tmp/x/spleen.nii.gz") == "spleen"
    assert clean("pancreas.txt") == "pancreas"
    assert processor.clean_organ_name("aorta.nii.gz") == "aorta", "callable on an instance too"


def test_several_label_files_are_merged_and_named_by_their_file(processor):
    files = MultiDict([
        ("liver.nii.gz", upload("liver.nii.gz", ((0, 4), (0, 4), (0, 4)))),
        ("spleen.nii.gz", upload("spleen.nii.gz", ((6, 10), (4, 8), (2, 6)))),
        ("aorta.nii.gz", upload("aorta.nii.gz", ((0, 2), (8, 10), (0, 2)))),
    ])
    combined, organs = processor.combine_labels(["liver.nii.gz", "spleen.nii.gz", "aorta.nii.gz"], files, save=False)
    assert organs == {name: VIEWER_IDS[name] for name in ("liver", "spleen", "aorta")}
    data = np.asanyarray(combined.dataobj)
    assert data[1, 1, 1] == VIEWER_IDS["liver"] and data[7, 5, 3] == VIEWER_IDS["spleen"] and data[0, 8, 0] == VIEWER_IDS["aorta"] and data[11, 9, 7] == 0


def test_overlapping_files_keep_the_later_one(processor):
    files = MultiDict([
        ("liver.nii.gz", upload("liver.nii.gz", ((0, 6), (0, 6), (0, 6)))),
        ("liver_lesion.nii.gz", upload("liver_lesion.nii.gz", ((2, 4), (2, 4), (2, 4)))),
    ])
    combined, _organs = processor.combine_labels(["liver.nii.gz", "liver_lesion.nii.gz"], files, save=False)
    data = np.asanyarray(combined.dataobj)
    assert data[3, 3, 3] == VIEWER_IDS["liver_lesion"] and data[0, 0, 0] == VIEWER_IDS["liver"]


def test_files_on_different_grids_are_refused(processor):
    small = np.zeros((4, 4, 4), dtype=np.uint8)
    raw = gzip.compress(nib.Nifti1Image(small, np.eye(4)).to_bytes())
    files = MultiDict([
        ("liver.nii.gz", upload("liver.nii.gz", ((0, 4), (0, 4), (0, 4)))),
        ("spleen.nii.gz", FileStorage(stream=io.BytesIO(raw), filename="spleen.nii.gz")),
    ])
    with pytest.raises(ValueError, match="Shape mismatch"):
        processor.combine_labels(["liver.nii.gz", "spleen.nii.gz"], files, save=False)


def test_one_labelmap_is_reindexed_by_viewer_organ_names(processor):
    files = MultiDict([("labels.nii.gz", upload("labels.nii.gz", ((0, 4), (0, 4), (0, 4)), value=VIEWER_IDS["spleen"]))])
    _combined, organs = processor.combine_labels(["labels.nii.gz"], files, save=False)
    assert organs == {"spleen": VIEWER_IDS["spleen"]}
