"""Normalize iPanTSMini label IDs for the 3D viewer."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np


_SCHEMA_REVISION = 1
_NORMALIZED_MARKER = f"BodyMaps viewer labelmap ipantsmini-v1->viewer-v1 r{_SCHEMA_REVISION}"
_IPANTSMINI_TO_VIEWER = np.arange(29, dtype=np.uint8)
_IPANTSMINI_TO_VIEWER[[22, 23, 24, 25, 26, 27, 28]] = [23, 24, 25, 26, 27, 28, 22]


def _source_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_normalized(image: nib.spatialimages.SpatialImage) -> bool:
    description = image.header["descrip"].tobytes().split(b"\0", 1)[0]
    return description.decode("ascii", errors="ignore").startswith(_NORMALIZED_MARKER)


def _validated_labels(image: nib.spatialimages.SpatialImage) -> np.ndarray:
    labels = np.asanyarray(image.dataobj)
    if not np.issubdtype(labels.dtype, np.number) or np.issubdtype(labels.dtype, np.complexfloating):
        raise ValueError("Labelmap labels must be finite integers in the supported range 0..28")
    if not np.all(np.isfinite(labels)):
        raise ValueError("Labelmap labels must be finite integers in the supported range 0..28")
    if not np.all(labels == np.floor(labels)):
        raise ValueError("Labelmap labels must be integers in the supported range 0..28")
    if labels.size and (np.min(labels) < 0 or np.max(labels) > 28):
        raise ValueError("Labelmap labels must be in the supported range 0..28")
    return labels.astype(np.uint8, copy=False)


def _write_normalized(source_image: nib.spatialimages.SpatialImage, labels: np.ndarray, destination: Path) -> None:
    header = source_image.header.copy()
    qform, qform_code = header.get_qform(coded=True)
    sform, sform_code = header.get_sform(coded=True)
    output = nib.Nifti1Image(labels, source_image.affine, header=header)
    output.set_data_dtype(np.uint8)
    output.set_qform(qform, int(qform_code))
    output.set_sform(sform, int(sform_code))
    output.header["descrip"] = _NORMALIZED_MARKER.encode("ascii")
    nib.save(output, str(destination))


def viewer_labelmap_path(
    source_path: str | os.PathLike[str],
    cache_root: str | os.PathLike[str],
    schema: str = "ipantsmini-v1",
) -> Path:
    """Return a viewer-ready labelmap path for an explicitly named schema.

    ``viewer-v1`` inputs pass through untouched. ``ipantsmini-v1`` inputs are
    remapped to viewer IDs and cached by source bytes and mapping revision.
    """
    if schema == "viewer-v1":
        return Path(source_path)
    if schema != "ipantsmini-v1":
        raise ValueError(f"Unsupported labelmap schema: {schema}")

    source = Path(source_path)
    source_image = nib.load(str(source))
    if _is_normalized(source_image):
        return source

    digest = _source_digest(source)
    output_dir = Path(cache_root) / f"ipantsmini-v1-to-viewer-v1-r{_SCHEMA_REVISION}"
    output_path = output_dir / f"{digest}.nii.gz"
    if output_path.exists():
        return output_path

    labels = _validated_labels(source_image)
    output_dir.mkdir(parents=True, exist_ok=True)
    mapped_labels = _IPANTSMINI_TO_VIEWER[labels]
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".labelmap-", suffix=".nii.gz", dir=output_dir, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
        _write_normalized(source_image, mapped_labels, temporary_path)
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return output_path
