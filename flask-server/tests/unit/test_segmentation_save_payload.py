import gzip

import numpy as np
import pytest

from services.segmentation_save_payload import decode_labelmap_payload, matches_labelmap_grid


def test_x_fastest_payload_keeps_every_voxel():
    expected = np.arange(24, dtype=np.uint8).reshape((2, 3, 4))
    actual = decode_labelmap_payload(gzip.compress(expected.tobytes(order="F")), expected.shape)
    np.testing.assert_array_equal(actual, expected)


def test_expansion_beyond_the_expected_grid_is_rejected():
    with pytest.raises(ValueError, match="Scalar count"):
        decode_labelmap_payload(gzip.compress(bytes(1_000_000)), (2, 3, 4))


@pytest.mark.parametrize("body", [b"\x1f\x8bnot-gzip", gzip.compress(bytes(24))[:-4], bytes(23),
                                 b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03\x07" + bytes(8)])
def test_invalid_or_truncated_payload_is_rejected(body):
    with pytest.raises(ValueError):
        decode_labelmap_payload(body, (2, 3, 4))


def test_grid_matches_a_reversed_slice_stack_but_not_an_outside_or_scaled_volume():
    reference = np.diag([0.75, 0.75, 5, 1])
    reversed_affine = reference.copy()
    reversed_affine[:3, 3] += reference[:3, 2] * 3
    reversed_affine[:3, 2] *= -1
    assert matches_labelmap_grid((2, 3, 4), reversed_affine, (2, 3, 4), reference)
    outside = reference.copy()
    outside[0, 3] = 1000
    assert not matches_labelmap_grid((2, 3, 4), outside, (2, 3, 4), reference)
    scaled = reference.copy()
    scaled[0, 0] *= 2
    assert not matches_labelmap_grid((2, 3, 4), scaled, (2, 3, 4), reference)


def test_grid_matches_a_permutation_with_the_same_physical_voxels():
    reference = np.diag([0.75, 0.75, 5, 1])
    permuted = reference.copy()
    permuted[:3, :3] = reference[:3, [2, 1, 0]]
    assert matches_labelmap_grid((4, 3, 2), permuted, (2, 3, 4), reference)
