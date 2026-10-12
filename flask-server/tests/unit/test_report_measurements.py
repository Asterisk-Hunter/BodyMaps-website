"""Synthetic quantitative and memory regressions for the report hot path."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

SPEC = importlib.util.spec_from_file_location(
    "report_measurements", Path(__file__).resolve().parents[2] / "services/report_measurements.py"
)
measurements = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(measurements)


def baseline(ct, mask_values, affine, ct_scaling=(1, 0), mask_scaling=(1, 0)):
    ct = ct.astype(np.float64) * ct_scaling[0] + ct_scaling[1]
    mask_values = mask_values.astype(np.float64) * mask_scaling[0] + mask_scaling[1]
    foreground = np.unique(mask_values[mask_values != 0])
    if len(foreground) > 1 or (len(foreground) and (not np.isfinite(foreground[0]) or foreground[0] < 0)):
        raise ValueError("not binary")
    mask = mask_values > 0
    if not np.any(mask):
        return None
    coordinates = np.argwhere(mask)
    center = nib.affines.apply_affine(affine, coordinates.mean(axis=0))
    dimensions = (coordinates.max(axis=0) - coordinates.min(axis=0) + 1) * np.linalg.norm(affine[:3, :3], axis=0)
    voxels = int(np.count_nonzero(mask))
    mean_hu = float(np.mean(ct[mask]))
    return {
        "voxels": voxels,
        "volume": round(voxels * abs(float(np.linalg.det(affine[:3, :3]))) / 1000, 2),
        "mean_hu": round(mean_hu, 1) if np.isfinite(mean_hu) else None,
        "centroid_mm": [round(float(value), 2) for value in center],
        "dimensions": [round(float(value) / 10, 1) for value in dimensions],
    }


@pytest.mark.parametrize("density", [0, 0.02, 0.6, 1])
@pytest.mark.parametrize("mask_scaling,values", [((1, 0), (0, 1)), ((1, 4), (-4, 0)), ((-2, 0), (-4, 0))])
def test_block_measurements_match_original_quantities(density, mask_scaling, values):
    rng = np.random.default_rng(518)
    ct = rng.integers(-1200, 2500, (17, 19, 23), dtype=np.int16)
    mask = np.where(rng.random(ct.shape) < density, values[1], values[0]).astype(np.int16)
    # Rotation/shear, anisotropic spacing, translation, and a reflected axis.
    affine = np.array([[0, -0.8, 0.1, 31], [0.7, 0, 0.2, -12], [0, 0, -2.5, 44], [0, 0, 0, 1]])
    ct_scaling = (0.5, -1024)
    expected = baseline(ct, mask, affine, ct_scaling, mask_scaling)
    result = measurements.measure_binary_structure(ct, mask, affine, ct_scaling=ct_scaling,
                                                  mask_scaling=mask_scaling, slab_voxels=17 * 19 * 3)
    assert result == expected


@pytest.mark.parametrize("values", [(0, 1, 2), (1, 2, 2), (0, -1, 0), (0, np.nan, 0),
                                    (0, np.inf, 0), (0, 1, 1 + 1e-12)])
def test_invalid_binary_mask_is_rejected_without_weakening_precision(values):
    mask = np.array(values, dtype=np.float64).reshape(1, 1, 3)
    with pytest.raises(ValueError, match="binary structure mask"):
        measurements.measure_binary_structure(np.ones(mask.shape, dtype=np.int16), mask, np.eye(4), slab_voxels=1)


def test_nonfinite_ct_is_only_considered_inside_foreground():
    ct = np.array([np.nan, 10, 20], dtype=np.float32).reshape(1, 1, 3)
    mask = np.array([0, 1, 1], dtype=np.uint8).reshape(1, 1, 3)
    assert measurements.measure_binary_structure(ct, mask, np.eye(4))["mean_hu"] == 15
    ct[0, 0, 1] = np.inf
    assert measurements.measure_binary_structure(ct, mask, np.eye(4))["mean_hu"] is None


def test_native_nifti_reads_preserve_storage_dtype_and_scaling(tmp_path, monkeypatch):
    raw = np.arange(105, dtype=np.int16).reshape(3, 5, 7)
    path = tmp_path / "synthetic-ct.nii.gz"
    image = nib.Nifti1Image(raw, np.eye(4))
    image.header.set_slope_inter(0.5, -1000)
    nib.save(image, path)
    loaded = nib.load(path)
    def forbidden(*args, **kwargs):
        pytest.fail("Native reads must not materialize/cache a full float64 volume")
    monkeypatch.setattr(loaded, "get_fdata", forbidden)
    values, scaling = measurements.read_native_volume(loaded)
    assert values.dtype == np.int16
    assert values.nbytes == raw.nbytes
    np.testing.assert_array_equal(values, raw)
    assert scaling == (0.5, -1000.0)


def test_reductions_are_block_bounded_and_never_allocate_voxel_coordinate_list(monkeypatch):
    shape = (13, 17, 29)
    ct = np.arange(np.prod(shape), dtype=np.int16).reshape(shape)
    mask = np.zeros(shape, dtype=np.uint8)
    mask[1:12, 2:16, 1:28] = 1
    expected = baseline(ct, mask, np.eye(4))
    def forbidden(*args, **kwargs):
        pytest.fail("No foreground sorting or N-by-3 coordinate allocation is permitted")
    monkeypatch.setattr(np, "argwhere", forbidden)
    monkeypatch.setattr(np, "unique", forbidden)
    original_count = np.count_nonzero
    examined = []
    def count(values, *args, **kwargs):
        examined.append(values.size)
        return original_count(values, *args, **kwargs)
    monkeypatch.setattr(np, "count_nonzero", count)
    result = measurements.measure_binary_structure(ct, mask, np.eye(4), slab_voxels=13 * 17 * 4)
    assert result == expected
    assert examined and max(examined) <= 13 * 17 * 4


def test_native_in_memory_image_and_geometry_contract():
    image = nib.Nifti1Image(np.ones((2, 3, 4), dtype=np.uint8), np.eye(4))
    values, scaling = measurements.read_native_volume(image)
    assert values is image.dataobj
    assert scaling == (1, 0)
    with pytest.raises(ValueError, match="geometry"):
        measurements.measure_binary_structure(np.ones((3, 3, 4)), values, np.eye(4))
