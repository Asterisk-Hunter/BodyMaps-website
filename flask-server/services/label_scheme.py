"""The one organ numbering the app uses, and the conversion of PanTS masks into it.

Two numberings exist side by side:

  * the viewer catalog (PanTS-Demo/src/helpers/constants.ts segmentation_categories,
    1-based): pancreatic_lesion is 22 and postcava..veins are 23-28. Meshes, organ
    metrics, lesion grounding, CancerVerse tumor masks (22 and 33-44) and every AI
    model's remapped output use it;
  * the PanTS dataset masks (PANTS_PATH/mask_only, the low-res copies under
    PANTS_LOWRES_PATH and the HuggingFace mirror): 1-21 match the catalog, then
    22 postcava, 23 prostate, 24 spleen, 25 stomach, 26 superior_mesenteric_artery,
    27 veins and 28 pancreatic_lesion.

Read raw, a dataset mask shows the spleen as "Prostate", the IVC as a pancreatic
lesion and the real lesion as "Veins". So the backend converts every dataset mask
to viewer ids exactly once, where it reads it, and nothing else ever converts.
Session, AI-model, uploaded, CancerVerse and quiz-reveal masks are never converted:
the first four are already in viewer ids and the quiz reads the raw lesion label on
purpose. Converting a mask twice would rotate 22-28 again, so the decision is made by where
a mask comes from, never by its content.
"""

from __future__ import annotations

import os

import numpy as np


# Marks data written in the viewer numbering: mesh manifests carry it as
# "labelScheme", and the /mask-data cache stamps include it.
SCHEME = "viewer-v1"

VIEWER_LABELS = {
    1: {"key": "adrenal_gland_left", "name": "Left Adrenal Gland"},
    2: {"key": "adrenal_gland_right", "name": "Right Adrenal Gland"},
    3: {"key": "aorta", "name": "Aorta"},
    4: {"key": "bladder", "name": "Bladder"},
    5: {"key": "celiac_artery", "name": "Celiac Artery"},
    6: {"key": "colon", "name": "Colon"},
    7: {"key": "common_bile_duct", "name": "Common Bile Duct"},
    8: {"key": "duodenum", "name": "Duodenum"},
    9: {"key": "femur_left", "name": "Left Femur"},
    10: {"key": "femur_right", "name": "Right Femur"},
    11: {"key": "gall_bladder", "name": "Gall Bladder"},
    12: {"key": "kidney_left", "name": "Left Kidney"},
    13: {"key": "kidney_right", "name": "Right Kidney"},
    14: {"key": "liver", "name": "Liver"},
    15: {"key": "lung_left", "name": "Left Lung"},
    16: {"key": "lung_right", "name": "Right Lung"},
    17: {"key": "pancreas", "name": "Pancreas"},
    18: {"key": "pancreas_body", "name": "Pancreas Body"},
    19: {"key": "pancreas_head", "name": "Pancreas Head"},
    20: {"key": "pancreas_tail", "name": "Pancreas Tail"},
    21: {"key": "pancreatic_duct", "name": "Pancreatic Duct"},
    22: {"key": "pancreatic_lesion", "name": "Pancreatic Lesion"},
    23: {"key": "postcava", "name": "Postcava"},
    24: {"key": "prostate", "name": "Prostate"},
    25: {"key": "spleen", "name": "Spleen"},
    26: {"key": "stomach", "name": "Stomach"},
    27: {"key": "superior_mesenteric_artery", "name": "Superior Mesenteric Artery"},
    28: {"key": "veins", "name": "Veins"},
    29: {"key": "intestine", "name": "Intestine"},
    30: {"key": "renal_vein_left", "name": "Left Renal Vein"},
    31: {"key": "renal_vein_right", "name": "Right Renal Vein"},
    32: {"key": "cbd_stent", "name": "Common Bile Duct Stent"},
    33: {"key": "liver_lesion", "name": "Liver Lesion"},
    34: {"key": "kidney_lesion", "name": "Kidney Lesion"},
    35: {"key": "colon_lesion", "name": "Colon Lesion"},
    # CancerVerse tumor types (it has tumor masks only). Same ids as the viewer's label list and as
    # cancerverse_catalog.LESION_LABEL_IDS. Absent from every PanTS mask, so PanTS meshes are unchanged.
    36: {"key": "stomach_lesion", "name": "Stomach Lesion"},
    37: {"key": "adrenal_gland_lesion", "name": "Adrenal Gland Lesion"},
    38: {"key": "bladder_lesion", "name": "Bladder Lesion"},
    39: {"key": "prostate_lesion", "name": "Prostate Lesion"},
    40: {"key": "esophagus_lesion", "name": "Esophagus Lesion"},
    41: {"key": "spleen_lesion", "name": "Spleen Lesion"},
    42: {"key": "uterus_lesion", "name": "Uterus Lesion"},
    43: {"key": "duodenum_lesion", "name": "Duodenum Lesion"},
    44: {"key": "gallbladder_lesion", "name": "Gallbladder Lesion"},
}
VIEWER_IDS = {meta["key"]: label_id for label_id, meta in VIEWER_LABELS.items()}

# Values in a PanTS dataset mask. Measured on the local cases: 24 matches the
# RadGPT spleen volume in every case, 22 is a right-paraspinal tube beside the
# aorta in every case, and 28 appears only in the tumour case, in the pancreas head.
PANTS_LABELS = {
    **{label_id: VIEWER_LABELS[label_id]["key"] for label_id in range(1, 22)},
    22: "postcava",
    23: "prostate",
    24: "spleen",
    25: "stomach",
    26: "superior_mesenteric_artery",
    27: "veins",
    28: "pancreatic_lesion",
}
PANTS_IDS = {key: label_id for label_id, key in PANTS_LABELS.items()}

# Dataset value -> viewer id. Values PanTS never uses (29 and up) become
# background rather than passing through as an unrelated viewer class.
PANTS_TO_VIEWER = np.zeros(256, dtype=np.uint8)
for _value, _key in PANTS_LABELS.items():
    PANTS_TO_VIEWER[_value] = VIEWER_IDS[_key]
del _value, _key


def to_viewer(raw) -> np.ndarray:
    """Convert a PanTS dataset label array to viewer ids, as uint8."""
    data = np.asanyarray(raw)
    if not np.issubdtype(data.dtype, np.integer):
        data = np.nan_to_num(np.rint(data), nan=0.0)
    return PANTS_TO_VIEWER[np.clip(data, 0, 255).astype(np.uint8)]


def viewer_labelmap_path(raw_path) -> str:
    """Resolve a PanTS source mask through the canonical source-to-viewer boundary.

    Only call this for raw dataset masks. Session, model, and edited masks already
    carry viewer IDs and must pass through unchanged.
    """
    from constants import Constants
    from services.pants_labelmap import viewer_labelmap_path as convert_source

    cache_root = os.environ.get("PANTS_VIEWER_LABEL_CACHE_PATH") or os.path.join(
        Constants.PERMISSIONS_DIR, "pants_viewer_labels"
    )
    return str(convert_source(raw_path, cache_root, Constants.PANTS_LABEL_SCHEMA))
