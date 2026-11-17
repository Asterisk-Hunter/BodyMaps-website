import numpy as np
import pytest

from services.annotation_merge import ensure_target_metadata, merge_target_labels


def test_merge_preserves_other_structures_and_can_clear_target():
    original = np.array([0, 1, 1, 2, 0], dtype=np.uint8)
    submission = np.array([1, 0, 0, 0, 0], dtype=np.uint8)
    merged = merge_target_labels(original, submission, [1])
    np.testing.assert_array_equal(merged, [1, 0, 0, 2, 0])
    np.testing.assert_array_equal(original, [0, 1, 1, 2, 0])


def test_merge_rejects_collision_with_non_target():
    with pytest.raises(ValueError, match="non-target"):
        merge_target_labels(np.array([2]), np.array([1]), [1])


def test_merge_rejects_different_grids():
    with pytest.raises(ValueError, match="grids"):
        merge_target_labels(np.zeros((2, 2)), np.zeros((3, 2)), [1])


def test_custom_target_name_is_pinned_and_mismatch_is_rejected():
    import nibabel as nib
    from services.segmentation_metadata import read_structures

    image = nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), np.eye(4))
    ensure_target_metadata(image, {"100": "Portal vein"}, [100])
    assert read_structures(image)["100"]["name"] == "Portal vein"
    with pytest.raises(ValueError, match="renamed"):
        ensure_target_metadata(image, {"100": "Different vessel"}, [100])
