"""AbdomenAtlas catalog helpers.

AbdomenAtlas 3.0 Mini (the data the AtlasNet model is trained on) is the library's third dataset.
Search treats it as one collection with PanTS and CancerVerse, so this module turns its metadata CSV
into the same columns the PanTS spreadsheet has (``ct phase``, ``tumor?`` ...), says which of its
per-organ masks the viewer can show and in what order they are painted, and finds its files.

The dataset is laid out like PanTS: ``image_only/BDMAP_########/ct.nii.gz`` and
``mask_only/BDMAP_########/segmentations/<organ>.nii.gz`` (one binary file per structure). The viewer
wants ONE label map per case in its own numbering, so ``scripts/build_abdomenatlas_masks.py`` folds the
per-organ files into ``<overlay>/mask_only/<id>/combined_labels.nii.gz`` using ``VIEWER_MASK_FILES``.

No Flask or database imports here: everything is a pure function over pandas/dicts.
"""
from __future__ import annotations

import os
import re
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

from services import cancerverse_catalog as cv_catalog
from services.label_scheme import VIEWER_IDS

DATASET = "AbdomenAtlas"
ID_PREFIX = "BDMAP"
CT_FILENAME = "ct.nii.gz"
MASK_FILENAME = "combined_labels.nii.gz"
METADATA_CSV = "AbdomenAtlas3.0MiniWithMeta.csv"
PROFILE_FILENAME = "profile.jpg"

# Metadata column -> tumor type key. The key is what the API filters on; the spelling matches the
# CancerVerse / PanTS tumor types so the one filter works across all three datasets.
LESION_COUNT_COLUMNS: Dict[str, str] = {
    "number of liver lesion instances": "liver",
    "number of pancreatic lesion instances": "pancreas",
    "number of kidney lesion instances": "kidney",
    "number of colon lesion instances": "colon",
}

# The per-organ mask files the viewer shows, in PAINT ORDER (later wins where two overlap): big
# organs first, then their parts, then vessels, and the lesions last so a lesion is never hidden by
# the organ it sits in. The value is the viewer label id (services/label_scheme.py), the same numbering
# PanTS and the AI models use, so the viewer, the meshes and the organ list need nothing new.
#
# Files the dataset has but the viewer has no label for are NOT drawn: celiac_aa, celiac_trunk,
# esophagus, hepatic_vessel, liver_segment_1..8, portal_vein_and_splenic_vein, rectum. They are
# listed in UNMAPPED_MASK_FILES so a test notices if the viewer ever gains a label for one of them.
_PAINT_ORDER = (
    "liver", "lung_left", "lung_right", "colon", "intestine", "stomach", "duodenum",
    "kidney_left", "kidney_right", "spleen", "bladder", "prostate",
    "femur_left", "femur_right", "adrenal_gland_left", "adrenal_gland_right",
    "pancreas", "gall_bladder", "common_bile_duct",
    "aorta", "postcava", "veins", "superior_mesenteric_artery",
    "pancreas_head", "pancreas_body", "pancreas_tail",
    "pancreatic_lesion", "liver_lesion", "kidney_lesion",
)
VIEWER_MASK_FILES: Tuple[Tuple[str, int], ...] = tuple((stem, VIEWER_IDS[stem]) for stem in _PAINT_ORDER)
UNMAPPED_MASK_FILES: Tuple[str, ...] = (
    "celiac_aa", "celiac_trunk", "esophagus", "hepatic_vessel",
    "liver_segment_1", "liver_segment_2", "liver_segment_3", "liver_segment_4",
    "liver_segment_5", "liver_segment_6", "liver_segment_7", "liver_segment_8",
    "portal_vein_and_splenic_vein", "rectum",
)


def abdomenatlas_id(index) -> str:
    """BDMAP_%08d id from a numeric index (accepts an optional 'BDMAP_' prefix)."""
    digits = re.sub(r"^BDMAP_?", "", str(index).strip(), flags=re.IGNORECASE)
    if not re.fullmatch(r"\d+", digits):
        raise ValueError("Invalid case id: numeric value expected")
    return "BDMAP_" + digits.zfill(8)


def canonical_phase(raw) -> str:
    """Map the dataset's contrast column onto the PanTS vocabulary.

    The column holds Venous, Arterial, Delay and Plain (a scan without contrast). Blank stays blank
    and is shown as Unknown; a value nobody expected is kept (title-cased) instead of dropped.
    """
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    s = str(raw).strip().lower()
    if s in {"plain", "non-contrast", "non contrast", "noncontrast", "native"}:
        return "Non-contrast"
    return cv_catalog.canonical_phase(s)


def _spacing_str(raw) -> str:
    """'[0.8222656 0.8222656 2.5      ]' -> '(0.8223, 0.8223, 2.5)', the form the PanTS sheet uses."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    parts = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", str(raw))
    if len(parts) != 3:
        return ""
    return cv_catalog._tuple_str([float(p) for p in parts], 4)


def _shape_str(raw) -> str:
    """'(512, 512, 339)' stays as it is; anything that is not three whole numbers becomes ''."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    parts = re.findall(r"\d+", str(raw))
    return "(" + ", ".join(parts) + ")" if len(parts) == 3 else ""


def _lesion_count(value) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return n if np.isfinite(n) else float("nan")


def normalize_metadata(raw: pd.DataFrame) -> pd.DataFrame:
    """AbdomenAtlas CSV -> PanTS-like columns, ready for ``_norm_cols``.

    Tumor status (``tumor?``) comes from the per-organ lesion counts in the CSV (liver, pancreas,
    kidney, colon): 1 when any count is above zero, 0 when every count is zero, unknown (NaN) when
    none of the four counts can be read. ``tumor type`` lists the organs with a lesion, largest
    count first. The radiologist note and the report texts are dropped here: search never exposes them.
    """
    if "BDMAP ID" not in raw.columns:
        raise ValueError("AbdomenAtlas metadata needs a 'BDMAP ID' column")
    df = raw.copy()
    ids = df["BDMAP ID"].astype(str).str.strip()

    out = pd.DataFrame({"BDMAP ID": ids, "dataset": DATASET}, index=df.index)
    out["sex"] = df["sex"].fillna("").astype(str).str.strip() if "sex" in df.columns else ""
    out["age"] = df["age"].map(cv_catalog.parse_age) if "age" in df.columns else np.nan
    out["ct phase"] = df["contrast"].map(canonical_phase) if "contrast" in df.columns else ""
    out["manufacturer"] = df["scanner"].fillna("").astype(str).str.strip() if "scanner" in df.columns else ""
    out["shape"] = df["shape"].map(_shape_str) if "shape" in df.columns else ""
    out["spacing"] = df["spacing"].map(_spacing_str) if "spacing" in df.columns else ""
    out["study year"] = np.nan          # the dataset carries no scan date

    counts = pd.DataFrame(
        {key: df[col].map(_lesion_count) for col, key in LESION_COUNT_COLUMNS.items() if col in df.columns},
        index=df.index,
    )
    if counts.empty:
        out["tumor?"] = np.nan
        out["tumor type"] = ""
        return out
    known = counts.notna().any(axis=1)
    has_lesion = (counts.fillna(0) > 0).any(axis=1)
    tumor = pd.Series(np.nan, index=df.index, dtype=float)
    tumor[known & has_lesion] = 1.0
    tumor[known & ~has_lesion] = 0.0
    out["tumor?"] = tumor
    out["tumor type"] = [
        ";".join(k for k, _ in sorted(((k, c) for k, c in row.items() if c and c > 0), key=lambda t: (-t[1], t[0])))
        for row in counts.to_dict("records")
    ]
    return out


# --------------------------------------------------------- file resolution

def resolve_metadata_file(explicit: Optional[str], root: Optional[str]) -> Optional[str]:
    """First existing metadata CSV: the explicit env path, then ``<root>/<csv>``."""
    candidates = [explicit] if explicit else []
    if root:
        candidates.append(os.path.join(os.path.normpath(root), METADATA_CSV))
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def resolve_ct_path(folder: str, root: Optional[str]) -> str:
    """Where one AbdomenAtlas CT lives: ``<root>/image_only/<id>/ct.nii.gz`` (even if it is not there)."""
    return os.path.join(root, "image_only", folder, CT_FILENAME) if root else ""


def resolve_profile_path(folder: str, root: Optional[str], overlay: Optional[str] = None) -> str:
    """Where one card thumbnail lives: the overlay first, then the dataset root."""
    candidates = [os.path.join(base, "profile_only", folder, PROFILE_FILENAME) for base in (overlay, root) if base]
    for path in candidates:
        if os.path.exists(path):
            return path
    return candidates[-1] if candidates else ""


def resolve_mask_path(folder: str, overlay: Optional[str]) -> Optional[str]:
    """The viewer mask (one label map in viewer ids) of one case, or None when it is not built yet.

    Built by scripts/build_abdomenatlas_masks.py into ``<overlay>/mask_only/<id>/combined_labels.nii.gz``.
    It lives in the writable overlay on local disk, never in the read-only dataset.
    """
    if not overlay:
        return None
    path = os.path.join(overlay, "mask_only", folder, MASK_FILENAME)
    return path if os.path.isfile(path) else None


def is_under(path: Optional[str], base: Optional[str]) -> bool:
    """True when ``path`` is inside directory ``base`` (symlinks resolved; False if either is unset)."""
    return cv_catalog.is_under(path, base)
