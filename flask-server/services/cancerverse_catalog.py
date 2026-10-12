"""CancerVerse catalog helpers.

Search treats PanTS and CancerVerse as one collection, so this module turns the
CancerVerse metadata CSV into the same columns the PanTS spreadsheet has (``ct phase``,
``study year``, ``tumor?`` ...) and adds one thing PanTS does not need: the tumor type.

PanTS is a pancreatic-tumor dataset, so every PanTS tumor is pancreatic. CancerVerse
annotates 13 organs, so its tumor types come from the released per-lesion masks, not
from ICD codes (ICD codes are per patient and also cover cancers that were never
segmented). ``scripts/build_cancerverse_index.py`` reads the masks once and writes the
small case index this module consumes.

No Flask or database imports here: everything is a pure function over pandas/dicts.
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, Iterable, Optional, Tuple

import numpy as np
import pandas as pd

CT_FILENAME = "ct.nii.gz"
METADATA_CSV = "CancerVerse_dataset_metadata.csv"
INDEX_JSON = "cancerverse_case_index.json"

# Released mask file stem -> tumor type key. The key is what the API filters on.
LESION_TYPES: Dict[str, str] = {
    "pancreatic_lesion": "pancreas",
    "liver_lesion": "liver",
    "kidney_lesion": "kidney",
    "stomach_lesion": "stomach",
    "adrenal_gland_lesion": "adrenal gland",
    "colon_lesion": "colon",
    "bladder_lesion": "bladder",
    "prostate_lesion": "prostate",
    "esophagus_lesion": "esophagus",
    "spleen_lesion": "spleen",
    "uterus_lesion": "uterus",
    "duodenum_lesion": "duodenum",
    "gallbladder_lesion": "gallbladder",
}
PANTS_TUMOR_TYPE = "pancreas"

# Tumor masks shown in the viewer. CancerVerse has tumor masks only (no organ masks), so a case's
# viewer mask is one label map holding its tumors. Each tumor type gets the viewer label id the
# frontend uses (src/helpers/constants.ts, segmentation_categories order): the first four already
# exist for PanTS' lesion types, the rest continue the list. Never renumber: ids are baked into the
# mask files and into the frontend.
MASK_FILENAME = "combined_labels.nii.gz"
LESION_LABEL_IDS: Dict[str, int] = {
    "pancreatic_lesion": 22,
    "liver_lesion": 33,
    "kidney_lesion": 34,
    "colon_lesion": 35,
    "stomach_lesion": 36,
    "adrenal_gland_lesion": 37,
    "bladder_lesion": 38,
    "prostate_lesion": 39,
    "esophagus_lesion": 40,
    "spleen_lesion": 41,
    "uterus_lesion": 42,
    "duodenum_lesion": 43,
    "gallbladder_lesion": 44,
}
# ICD-10 chapter II (neoplasms): C00-C97 malignant, D00-D49 in situ / benign / uncertain.
_NEOPLASM_ICD = re.compile(r"^\s*(C\d\d|D[0-4]\d)", re.IGNORECASE)


def has_neoplasm_code(value) -> bool:
    """True for an ICD-10 neoplasm code ('C22.0', 'D35'); blank/NaN/other chapters are False."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return False
    return bool(_NEOPLASM_ICD.match(str(value)))


def tumor_type_label(key: str) -> str:
    """Display name for a tumor type key ('adrenal gland' -> 'Adrenal gland')."""
    key = (key or "").strip()
    return key[:1].upper() + key[1:] if key else ""


def split_tumor_types(value) -> Tuple[str, ...]:
    """'liver;kidney' -> ('liver', 'kidney'). Tolerates NaN/None/blank."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return ()
    return tuple(t for t in (p.strip().lower() for p in str(value).split(";")) if t)


def canonical_phase(raw) -> str:
    """Map CancerVerse phase names onto the PanTS vocabulary.

    portal_venous / venous -> Venous; arterial / arterial_early / arterial_late ->
    Arterial; non-contrast -> Non-contrast. Blank stays blank (shown as Unknown).
    Unrecognized values are kept (title-cased) rather than silently dropped.
    """
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    s = str(raw).strip().lower().replace("_", " ")
    if not s or s in {"nan", "none", "unknown", "n/a", "na"}:
        return ""
    if "non" in s and "contrast" in s:
        return "Non-contrast"
    if "arter" in s:
        return "Arterial"
    if "venous" in s or "portal" in s:
        return "Venous"
    if "delay" in s:
        return "Delay"
    return s.title()


def parse_age(value) -> float:
    """Numeric age; CancerVerse writes 'above 89' for de-identification -> 90 (the 90+ bin)."""
    if value is None:
        return float("nan")
    s = str(value).strip().lower()
    if not s or s == "nan":
        return float("nan")
    m = re.search(r"above\s*(\d+)", s)
    if m:
        return float(int(m.group(1)) + 1)
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _tuple_str(values: Optional[Iterable], digits: int) -> str:
    """'(512, 512, 300)' / '(0.78, 0.78, 1.25)', the same shape the PanTS sheet uses."""
    if not values:
        return ""
    try:
        vals = [float(v) for v in values]
    except (TypeError, ValueError):
        return ""
    if len(vals) != 3 or not all(np.isfinite(vals)):
        return ""
    if digits == 0:
        return "(" + ", ".join(str(int(round(v))) for v in vals) + ")"
    return "(" + ", ".join(str(round(v, digits)) for v in vals) + ")"


# ---------------------------------------------------------------- case index

def load_case_index(path: Optional[str]) -> Optional[Dict[str, dict]]:
    """Read the index written by build_cancerverse_index.py: {case_id: {tumors, shape, spacing}}.

    Returns None (not an error) when the file is missing or unreadable: search then
    reports CancerVerse tumor status as unknown instead of failing to start.
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as error:
        print(f"[WARN] Could not read CancerVerse case index {path}: {error}")
        return None
    cases = data.get("cases") if isinstance(data, dict) else None
    return cases if isinstance(cases, dict) else None


def tumor_types_for_case(entry: Optional[dict]) -> Tuple[str, ...]:
    """Tumor type keys of one index entry, largest first.

    ``tumors`` is either a list already ordered by size (what build_cancerverse_index.py
    writes) or a ``{organ: mL}`` mapping; both are read.
    """
    tumors = (entry or {}).get("tumors")
    if isinstance(tumors, (list, tuple)):
        return tuple(dict.fromkeys(str(t) for t in tumors if t))
    if isinstance(tumors, dict):
        ranked = sorted(((float(ml or 0.0), key) for key, ml in tumors.items() if float(ml or 0.0) > 0),
                        key=lambda t: (-t[0], t[1]))
        return tuple(key for _, key in ranked)
    return ()


# ------------------------------------------------------------ normalization

def normalize_metadata(raw: pd.DataFrame, case_index: Optional[Dict[str, dict]] = None) -> pd.DataFrame:
    """CancerVerse CSV -> PanTS-like columns, ready for ``_norm_cols``.

    Tumor status (``tumor?``) comes from the annotated masks:
      1    the scan has at least one annotated lesion
      0    the scan is indexed, has none, none of that patient's scans has one, and the
           patient has no ICD-10 neoplasm code on any scan
      NaN  unknown: no index available, scan not indexed, a scan with no lesion of a
           patient whose other scans have one (an earlier or unannotated scan), or a
           patient diagnosed with a neoplasm that was never segmented (ICD C00-D49 but no
           annotated lesion, e.g. an organ outside the 13). None of these is "no tumor".
    Patient identifiers, accession numbers and report text are dropped here: search never
    exposes them.
    """
    df = raw.copy()
    if "CancerVerse ID" not in df.columns:
        raise ValueError("CancerVerse metadata needs a 'CancerVerse ID' column")
    ids = df["CancerVerse ID"].astype(str).str.strip()
    patients = (df["Patient ID"].fillna("").astype(str).str.strip() if "Patient ID" in df.columns
                else pd.Series([""] * len(df), index=df.index))
    patients = patients.where(~patients.str.lower().isin({"", "nan", "none", "null"}), ids)   # no patient id: its own patient

    out = pd.DataFrame({"CancerVerse ID": ids, "dataset": "CancerVerse"}, index=df.index)
    out["sex"] = df["sex"].fillna("").astype(str).str.strip() if "sex" in df.columns else ""
    out["age"] = df["age"].map(parse_age) if "age" in df.columns else np.nan
    out["ct phase"] = df["phase"].map(canonical_phase) if "phase" in df.columns else ""
    out["study year"] = (
        pd.to_datetime(df["exam_date"], format="%m-%d-%Y", errors="coerce").dt.year
        if "exam_date" in df.columns else np.nan
    )
    out["manufacturer"] = df["scanner"].fillna("").astype(str).str.strip() if "scanner" in df.columns else ""

    if case_index is None:
        out["tumor?"] = np.nan
        out["tumor type"] = ""
        out["shape"] = ""
        out["spacing"] = ""
        return out

    types = ids.map(lambda cid: tumor_types_for_case(case_index.get(cid)))
    has_tumor = types.map(len) > 0
    tumor_patients = set(patients[has_tumor])
    indexed = ids.map(lambda cid: cid in case_index)

    tumor = pd.Series(np.nan, index=df.index, dtype=float)
    tumor[has_tumor] = 1.0
    if "icd10_code" in df.columns:
        diagnosed = set(patients[df["icd10_code"].map(has_neoplasm_code)])
    else:
        diagnosed = set()
    healthy = indexed & ~has_tumor & ~patients.isin(tumor_patients) & ~patients.isin(diagnosed)
    tumor[healthy] = 0.0
    out["tumor?"] = tumor
    out["tumor type"] = types.map(";".join)
    out["shape"] = ids.map(lambda cid: _tuple_str((case_index.get(cid) or {}).get("shape"), 0))
    out["spacing"] = ids.map(lambda cid: _tuple_str((case_index.get(cid) or {}).get("spacing"), 4))
    return out


# --------------------------------------------------------- file resolution

def resolve_metadata_file(explicit: Optional[str], overlay: Optional[str], root: Optional[str]) -> Optional[str]:
    """First existing metadata CSV: explicit env path, the overlay, then beside/inside the dataset."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    if overlay:
        candidates.append(os.path.join(overlay, METADATA_CSV))
    if root:
        norm = os.path.normpath(root)
        candidates.append(os.path.join(os.path.dirname(norm), METADATA_CSV))
        candidates.append(os.path.join(norm, METADATA_CSV))
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def resolve_index_file(explicit: Optional[str], overlay: Optional[str]) -> Optional[str]:
    candidates = [explicit] if explicit else []
    if overlay:
        candidates.append(os.path.join(overlay, INDEX_JSON))
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def resolve_ct_path(folder: str, root: Optional[str], overlay: Optional[str] = None) -> str:
    """Where one CancerVerse CT lives.

    The dataset has been stored two ways (flat ``<root>/<id>/ct.nii.gz`` and
    ``<root>/image_only/<id>/ct.nii.gz``), and updated scans are staged in a writable
    overlay because the dataset mount is read-only. Preference: overlay (newer) first,
    then the dataset; if nothing exists the ``image_only`` path under the dataset root is
    returned so callers see the same 'file not found' they always did.
    """
    candidates = []
    for base in (overlay, root):
        if base:
            candidates.append(os.path.join(base, "image_only", folder, CT_FILENAME))
            candidates.append(os.path.join(base, folder, CT_FILENAME))
    for path in candidates:
        if os.path.exists(path):
            return path
    return os.path.join(root, "image_only", folder, CT_FILENAME) if root else ""


def resolve_profile_path(folder: str, root: Optional[str], overlay: Optional[str] = None) -> str:
    """Where one CancerVerse card thumbnail lives: overlay first, then the dataset root."""
    candidates = [os.path.join(base, "profile_only", folder, "profile.jpg") for base in (overlay, root) if base]
    for path in candidates:
        if os.path.exists(path):
            return path
    return candidates[-1] if candidates else ""


def resolve_mask_path(folder: str, overlay: Optional[str]) -> Optional[str]:
    """The viewer mask (tumor label map) of one CancerVerse case, or None when it has none.

    Built by scripts/build_cancerverse_masks.py into ``<overlay>/mask_only/<id>/combined_labels.nii.gz``
    for the scans with an annotated tumor. It lives next to the other overlay files, on local disk.
    """
    if not overlay:
        return None
    path = os.path.join(overlay, "mask_only", folder, MASK_FILENAME)
    return path if os.path.isfile(path) else None


def is_under(path: Optional[str], base: Optional[str]) -> bool:
    """True when ``path`` is inside directory ``base`` (symlinks resolved; False if either is unset)."""
    if not path or not base:
        return False
    try:
        real_base = os.path.realpath(base)
        return os.path.commonpath((os.path.realpath(path), real_base)) == real_base
    except ValueError:
        return False
