"""Private, immutable mask objects used by the annotation workflow.

The database points at a content revision only after an object has been
installed. A crash before commit can leave an orphan but never a partial draft.
"""
import hashlib
import json
import os
import uuid

import nibabel as nib
import numpy as np
from nibabel.processing import resample_from_to

from services.segmentation_save_payload import decode_labelmap_payload, matches_labelmap_grid
from services.shared_annotations import viewer_cache_root


def _uuid(value):
    parsed = uuid.UUID(str(value))
    if str(parsed) != str(value):
        raise ValueError("Invalid storage identifier")
    return str(parsed)


def case_directory(project_id, assignment_id, case_row_id):
    return os.path.join(viewer_cache_root(), "edits", "assignments", _uuid(project_id),
                        _uuid(assignment_id), _uuid(case_row_id))


def seed_path(project_id, case_key):
    import re
    if not re.fullmatch(r"(?:PanTS|CV|BDMAP)_[0-9]{8}", case_key):
        raise ValueError("Invalid case identifier")
    return os.path.join(viewer_cache_root(), "edits", "assignments", _uuid(project_id), "seed", case_key + ".nii.gz")


def draft_path(project_id, assignment_id, case_row_id, revision):
    if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Invalid draft revision")
    return os.path.join(case_directory(project_id, assignment_id, case_row_id), "drafts", revision + ".nii.gz")


def decode_full_mask(body, geometry_header, reference):
    """Decode viewer scalars and put them on the verified full-resolution grid."""
    if not geometry_header or len(geometry_header) > 8192:
        raise ValueError("Full-resolution labelmap geometry is required")
    try:
        geometry = json.loads(geometry_header)
        dimensions = np.asarray(geometry["dimensions"], dtype=float)
        spacing = np.asarray(geometry["spacing"], dtype=float)
        origin = np.asarray(geometry["origin"], dtype=float)
        direction = np.asarray(geometry["direction"], dtype=float)
        if (dimensions.shape != (3,) or spacing.shape != (3,) or origin.shape != (3,) or direction.shape != (9,)
                or not all(np.isfinite(x).all() for x in (dimensions, spacing, origin, direction))
                or np.any(dimensions <= 0) or np.any(dimensions != np.floor(dimensions)) or np.any(spacing <= 0)):
            raise ValueError("Invalid labelmap geometry")
        shape = tuple(int(x) for x in dimensions)
        affine = np.eye(4)
        affine[:3, :3] = direction.reshape((3, 3), order="F") @ np.diag(spacing)
        affine[:3, 3] = origin
        affine = np.diag([-1., -1., 1., 1.]) @ affine
        if abs(np.linalg.det(affine[:3, :3])) < 1e-8 or not matches_labelmap_grid(shape, affine, reference.shape, reference.affine):
            raise ValueError("Labelmap geometry does not match the full-resolution case grid")
    except (KeyError, TypeError, OverflowError, np.linalg.LinAlgError, json.JSONDecodeError) as error:
        raise ValueError("Invalid labelmap geometry") from error
    image = nib.Nifti1Image(decode_labelmap_payload(body, shape), affine)
    if image.shape != reference.shape or not np.allclose(image.affine, reference.affine):
        image = resample_from_to(image, reference, order=0)
    return np.asarray(image.dataobj, dtype=np.uint8)


def write_draft(project_id, assignment_id, case_row_id, scalars, reference):
    """Write a content-addressed NIfTI and return its immutable revision."""
    directory = os.path.join(case_directory(project_id, assignment_id, case_row_id), "drafts")
    os.makedirs(directory, exist_ok=True)
    temp = os.path.join(directory, "." + uuid.uuid4().hex + ".nii.gz")
    try:
        image = nib.Nifti1Image(scalars, reference.affine, reference.header.copy())
        image.set_data_dtype(np.uint8)
        nib.save(image, temp)
        digest = hashlib.sha256()
        with open(temp, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        revision = digest.hexdigest()
        os.replace(temp, draft_path(project_id, assignment_id, case_row_id, revision))
        return revision
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
