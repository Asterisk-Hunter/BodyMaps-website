"""Validate saved labelmaps against their real grid before allocating or writing."""
from itertools import product
import gzip
import io
import zlib

import numpy as np


def decode_labelmap_payload(body: bytes, shape) -> np.ndarray:
    """Decode X-fastest uint8 data without permitting unbounded gzip expansion."""
    expected = int(np.prod(shape))
    if body.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(body), mode="rb") as compressed:
                raw = compressed.read(expected + 1)
        except (OSError, EOFError, ValueError, zlib.error) as error:
            raise ValueError("Invalid or truncated compressed segmentation") from error
    else:
        raw = body
    if len(raw) != expected:
        raise ValueError("Scalar count does not match the labelmap dimensions")
    return np.frombuffer(raw, dtype=np.uint8).reshape(shape, order="F")


def matches_labelmap_grid(shape, affine, reference_shape, reference_affine) -> bool:
    """Allow stack flips/permutations, never silently attach a foreign grid."""
    transform = np.linalg.solve(reference_affine, affine)
    axes = transform[:3, :3]
    rounded = np.rint(axes)
    if (not np.allclose(axes, rounded, atol=1e-4, rtol=0)
            or not np.all(np.sum(np.abs(rounded), axis=0) == 1)
            or not np.all(np.sum(np.abs(rounded), axis=1) == 1)):
        return False
    corners = np.asarray(list(product(*[(0, int(size) - 1) for size in shape])), dtype=float)
    mapped = corners @ axes.T + transform[:3, 3]
    return bool(np.allclose(mapped.min(axis=0), 0, atol=1e-3, rtol=0)
                and np.allclose(mapped.max(axis=0), np.asarray(reference_shape) - 1,
                                atol=1e-3, rtol=0))
