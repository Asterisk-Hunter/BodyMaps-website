"""Memory-bounded measurements of explicit binary structure masks.

Read native NIfTI storage types and apply intensity scaling to scalar statistics.
Coordinate reductions avoid allocating an N-by-3 array for every foreground voxel.
"""
from __future__ import annotations

import numpy as np


def read_native_volume(image):
    """Return (native array, (slope, intercept)) without a float64 image copy.

    Loaded NIfTI ArrayProxy objects expose their original storage and scaling.
    In-memory images already contain their effective values, as in get_fdata().
    """
    proxy = image.dataobj
    if hasattr(proxy, "get_unscaled"):
        return np.asanyarray(proxy.get_unscaled()), (float(proxy.slope), float(proxy.inter))
    return np.asanyarray(proxy), (1.0, 0.0)


def measure_binary_structure(ct_values, mask_values, affine, *, ct_scaling=(1.0, 0.0),
                             mask_scaling=(1.0, 0.0), slab_voxels=4 * 1024 * 1024):
    """Return measurements or None for an empty mask, preserving binary validation.

    A positive foreground may have any single value. Native endpoint validation
    is equivalent to validating scaled voxels but requires no full-size scaled
    mask or sorted foreground copy. Temporary boolean arrays are slab-bounded.
    """
    if ct_values.shape != mask_values.shape or mask_values.ndim != 3:
        raise ValueError("CT and segmentation geometry do not match")
    if not mask_values.size:
        return None
    raw_min, raw_max = mask_values.min(), mask_values.max()
    mask_slope, mask_intercept = mask_scaling
    scaled_endpoints = np.asarray([raw_min, raw_max], dtype=np.float64) * mask_slope + mask_intercept
    if not np.all(np.isfinite(scaled_endpoints)) or np.any(scaled_endpoints < 0):
        raise ValueError("Named segmentation is not a binary structure mask")
    if np.all(scaled_endpoints == 0):
        return None
    if raw_min != raw_max and np.all(scaled_endpoints > 0):
        raise ValueError("Named segmentation is not a binary structure mask")
    foreground_value = raw_min if scaled_endpoints[0] > 0 else raw_max
    background_value = raw_max if scaled_endpoints[0] > 0 else raw_min

    shape = mask_values.shape
    depth = max(1, min(shape[2], int(slab_voxels) // max(1, shape[0] * shape[1])))
    axis_counts = [np.zeros(length, dtype=np.int64) for length in shape]
    voxel_count = 0
    ct_sum = np.float64(0)
    for start in range(0, shape[2], depth):
        stop = min(shape[2], start + depth)
        values = mask_values[:, :, start:stop]
        mask = values == foreground_value
        if raw_min != raw_max and np.any((values != background_value) & ~mask):
            raise ValueError("Named segmentation is not a binary structure mask")
        count = int(np.count_nonzero(mask))
        if not count:
            continue
        voxel_count += count
        axis_counts[0] += np.count_nonzero(mask, axis=(1, 2))
        axis_counts[1] += np.count_nonzero(mask, axis=(0, 2))
        axis_counts[2][start:stop] = np.count_nonzero(mask, axis=(0, 1))
        # Float64 accumulation preserves quantitative HU without making the CT
        # itself float64 or allocating a foreground-sized selection of it.
        ct_sum += np.sum(ct_values[:, :, start:stop], where=mask, dtype=np.float64)

    if not voxel_count:
        return None
    centroid_voxel, extents = [], []
    for counts in axis_counts:
        positions = np.flatnonzero(counts)
        centroid_voxel.append(float(np.dot(np.arange(len(counts), dtype=np.float64), counts)) / voxel_count)
        extents.append(int(positions[-1] - positions[0] + 1))
    affine = np.asarray(affine)
    centroid_world = affine[:3, :3] @ np.asarray(centroid_voxel) + affine[:3, 3]
    dims_mm = np.asarray(extents) * np.linalg.norm(affine[:3, :3], axis=0)
    voxel_volume = abs(float(np.linalg.det(affine[:3, :3]))) / 1000
    mean_hu = float(ct_sum / voxel_count * ct_scaling[0] + ct_scaling[1])
    return {
        "voxels": voxel_count,
        "volume": round(voxel_count * voxel_volume, 2),
        "mean_hu": round(mean_hu, 1) if np.isfinite(mean_hu) else None,
        "centroid_mm": [round(float(value), 2) for value in centroid_world],
        "dimensions": [round(float(value) / 10, 1) for value in dims_mm],
    }
