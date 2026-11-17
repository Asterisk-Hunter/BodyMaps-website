"""Safe target-label merge for reviewed annotation submissions."""

import numpy as np
import json


PUBLISH_MARKER = "bodymaps_annotation_publish_v1"


def publish_marker(image):
    for extension in image.header.extensions:
        try:
            data = json.loads(extension.get_content().decode("utf-8")) if extension.get_code() == 6 else None
            if isinstance(data, dict) and isinstance(data.get(PUBLISH_MARKER), dict):
                return data[PUBLISH_MARKER]
        except (ValueError, UnicodeError, AttributeError):
            continue
    return None


def set_publish_marker(image, metadata):
    import nibabel as nib
    kept = []
    for extension in image.header.extensions:
        try:
            data = json.loads(extension.get_content().decode("utf-8")) if extension.get_code() == 6 else None
        except (ValueError, UnicodeError, AttributeError):
            data = None
        if not isinstance(data, dict) or PUBLISH_MARKER not in data:
            kept.append(extension)
    image.header.extensions.clear()
    image.header.extensions.extend(kept)
    image.header.extensions.append(nib.nifti1.Nifti1Extension(6, json.dumps({PUBLISH_MARKER: metadata}).encode()))


def ensure_target_metadata(image, target_names, targets):
    """Preserve existing metadata and pin names for new custom labels."""
    from services.label_scheme import VIEWER_LABELS
    from services.segmentation_metadata import read_structures, write_structures
    structures = read_structures(image)
    changed = False
    for label in targets:
        if label in VIEWER_LABELS:
            continue
        key = str(label)
        name = target_names[key].strip()
        existing = structures.get(key)
        if existing and existing["name"].casefold() != name.casefold():
            raise ValueError(f"Custom structure {label} was renamed; reconcile before continuing")
        if not existing:
            structures[key] = {"name": name, "color": [56, 189, 248, 255]}
            changed = True
    if changed:
        write_structures(image, structures)


def merge_target_labels(canonical, submission, targets):
    """Return a new labelmap, refusing changes to non-target structures.

    Both arrays must already be aligned on the same grid. Callers must hold
    the canonical save lock and validate image geometry before invoking this.
    """
    base = np.asarray(canonical)
    proposed = np.asarray(submission)
    labels = tuple(targets)
    if base.shape != proposed.shape:
        raise ValueError("Canonical and submission grids must match")
    if not labels or any(isinstance(v, bool) or not isinstance(v, (int, np.integer)) or v < 1 or v > 255 for v in labels):
        raise ValueError("Target labels must be integers between 1 and 255")
    target_base = np.isin(base, labels)
    target_proposed = np.isin(proposed, labels)
    if np.any(target_proposed & (base != 0) & ~target_base):
        raise ValueError("Submission overlaps an existing non-target label")
    result = base.copy()
    result[target_base] = 0
    result[target_proposed] = proposed[target_proposed]
    return result
