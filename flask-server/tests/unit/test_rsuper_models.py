"""The R-Super releases served on the site: how their masks become viewer labels and what command each runs.

Pancreas + Kidney (huggingface.co/AbdomenAtlas/R-SuperPancreasKidney) and Merlin (huggingface.co/AbdomenAtlas/Merlin-Cancer-Super)
are both MedFormer + report supervision and run through predict_abdomenatlas.py, which writes one
``<class name>.nii.gz`` per class under ``.../BDMAP_00000001/predictions``.
"""

from __future__ import annotations

import os

import nibabel as nib
import numpy as np
import pytest

from services import auto_segmentor
from services.auto_segmentor import _VIEWER_LABELS, RSUPER_VARIANTS, _combine_medformer_masks
from services.label_scheme import VIEWER_IDS

# The class lists of the two model cards (labels_rsuper_mask.yaml and label_names.yaml).
PANCREAS_KIDNEY_CLASSES = [
    "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder", "celiac_trunk", "colon", "common_bile_duct",
    "duodenum", "esophagus", "femur_left", "femur_right", "gall_bladder", "hepatic_vessel", "intestine",
    "kidney_left", "kidney_lesion", "kidney_right", "liver", "liver_lesion", "liver_segment_1", "liver_segment_2",
    "liver_segment_3", "liver_segment_4", "liver_segment_5", "liver_segment_6", "liver_segment_7", "liver_segment_8",
    "lung_left", "lung_right", "pancreas", "pancreas_body", "pancreas_head", "pancreas_tail", "pancreatic_lesion",
    "portal_vein_and_splenic_vein", "postcava", "prostate", "rectum", "spleen", "stomach",
    "superior_mesenteric_artery", "veins",
]
MERLIN_CLASSES = [
    "adrenal_gland_left", "adrenal_gland_right", "adrenal_lesion", "aorta", "bladder", "bladder_lesion", "colon",
    "common_bile_duct", "duodenum", "duodenum_lesion", "esophagus", "esophagus_lesion", "femur_left", "femur_right",
    "gall_bladder", "gallbladder_lesion", "hepatic_vessel", "intestine", "kidney_left", "kidney_right", "liver",
    "lung_left", "lung_right", "pancreas", "portal_vein_and_splenic_vein", "postcava", "prostate", "prostate_lesion",
    "spleen", "spleen_lesion", "stomach", "stomach_lesion", "superior_mesenteric_artery", "uterus_lesion", "veins",
]
# Classes with no single viewer slot: left as background, as the other models do (painting the eight
# liver segments or the hepatic vessel would replace the liver in the 2D overlay).
UNMAPPED = {"hepatic_vessel", *(f"liver_segment_{n}" for n in range(1, 9))}


def _viewer_id(name: str):
    return _VIEWER_LABELS.get(auto_segmentor._RSUPER_NAME_ALIASES.get(name, name))


def test_every_class_of_both_releases_is_mapped_or_deliberately_left_out():
    for classes in (PANCREAS_KIDNEY_CLASSES, MERLIN_CLASSES):
        missing = [name for name in classes if _viewer_id(name) is None and name not in UNMAPPED]
        assert missing == [], f"no viewer label for: {missing}"
        assert all(_viewer_id(name) is None for name in classes if name in UNMAPPED)


def test_the_backend_label_dictionary_agrees_with_the_canonical_table():
    # services/label_scheme.VIEWER_LABELS is the one numbering; the runner dictionary only mirrors it.
    for name, label_id in _VIEWER_LABELS.items():
        assert VIEWER_IDS[name] == label_id, name


@pytest.mark.parametrize("raw, viewer", [
    ("celiac_trunk", "celiac_artery"), ("adrenal_lesion", "adrenal_gland_lesion"),
    ("gallbladder_lesion", "gallbladder_lesion"), ("uterus_lesion", "uterus_lesion"),
    ("rectum", "rectum"), ("esophagus", "esophagus"),
    ("portal_vein_and_splenic_vein", "portal_vein_and_splenic_vein"),
])
def test_names_that_differ_from_the_viewer_land_on_the_right_label(raw, viewer):
    assert _viewer_id(raw) == VIEWER_IDS[viewer]


def _write(path, box, shape=(12, 12, 12)):
    data = np.zeros(shape, dtype=np.uint8)
    (x0, x1), (y0, y1), (z0, z1) = box
    data[x0:x1, y0:y1, z0:z1] = 1
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))


def _predictions(tmp_path, masks):
    folder = tmp_path / "raw" / "abdomenatlas" / "checkpoint" / "BDMAP_00000001" / "predictions"
    folder.mkdir(parents=True)
    for name, box in masks.items():
        _write(folder / f"{name}.nii.gz", box)
    return str(tmp_path / "raw")


def _combined(tmp_path, masks):
    out = tmp_path / "combined_labels.nii.gz"
    _combine_medformer_masks(_predictions(tmp_path, masks), "BDMAP_00000001", str(out))
    return np.asanyarray(nib.load(str(out)).dataobj)


BIG, INSIDE = ((0, 8), (0, 8), (0, 8)), ((2, 4), (2, 4), (2, 4))


def test_a_lesion_stays_visible_inside_its_organ_even_when_the_organ_sorts_after_it(tmp_path):
    # kidney_right sorts after kidney_lesion, so painting in file-name order alone would let the kidney
    # overwrite its own lesion. Lesions are painted last whatever the names sort like.
    labels = _combined(tmp_path, {"kidney_right": BIG, "kidney_lesion": INSIDE})
    assert labels[3, 3, 3] == VIEWER_IDS["kidney_lesion"]
    assert labels[0, 0, 0] == VIEWER_IDS["kidney_right"]


def test_each_lesion_stays_visible_inside_its_own_organ(tmp_path):
    labels = _combined(tmp_path, {"liver": BIG, "liver_lesion": INSIDE, "pancreas": ((8, 11), (8, 11), (8, 11)),
                                  "pancreatic_lesion": ((9, 10), (9, 10), (9, 10))})
    assert labels[3, 3, 3] == VIEWER_IDS["liver_lesion"]
    assert labels[0, 0, 0] == VIEWER_IDS["liver"]
    assert labels[9, 9, 9] == VIEWER_IDS["pancreatic_lesion"]
    assert labels[8, 8, 8] == VIEWER_IDS["pancreas"]


def test_a_pancreas_part_is_painted_over_the_pancreas_and_a_lesion_over_both(tmp_path):
    labels = _combined(tmp_path, {"pancreas": BIG, "pancreas_head": ((0, 4), (0, 8), (0, 8)), "pancreatic_lesion": INSIDE})
    assert labels[6, 6, 6] == VIEWER_IDS["pancreas"]
    assert labels[1, 6, 6] == VIEWER_IDS["pancreas_head"]
    assert labels[3, 3, 3] == VIEWER_IDS["pancreatic_lesion"]


def test_aliased_classes_and_the_new_tumor_types_are_painted_with_their_viewer_ids(tmp_path):
    labels = _combined(tmp_path, {
        "celiac_trunk": ((0, 2), (0, 2), (0, 2)), "adrenal_lesion": ((2, 4), (2, 4), (2, 4)),
        "uterus_lesion": ((4, 6), (4, 6), (4, 6)), "gallbladder_lesion": ((6, 8), (6, 8), (6, 8)),
        "rectum": ((8, 10), (8, 10), (8, 10)),
    })
    assert labels[0, 0, 0] == VIEWER_IDS["celiac_artery"]
    assert labels[2, 2, 2] == VIEWER_IDS["adrenal_gland_lesion"]
    assert labels[4, 4, 4] == VIEWER_IDS["uterus_lesion"]
    assert labels[6, 6, 6] == VIEWER_IDS["gallbladder_lesion"]
    assert labels[8, 8, 8] == VIEWER_IDS["rectum"]


def test_liver_segments_and_the_hepatic_vessel_never_replace_the_liver(tmp_path):
    labels = _combined(tmp_path, {"liver": BIG, "liver_segment_3": INSIDE, "hepatic_vessel": ((5, 7), (5, 7), (5, 7))})
    assert set(np.unique(labels)) == {0, VIEWER_IDS["liver"]}


def test_output_with_no_viewer_label_is_an_error_not_an_empty_mask(tmp_path):
    with pytest.raises(RuntimeError, match="viewer label"):
        _combined(tmp_path, {"liver_segment_2": BIG})


@pytest.fixture()
def commands(monkeypatch, tmp_path):
    """Run _run_rsuper_inference with the process and the combiner stubbed; collect what it would run."""
    seen = []
    monkeypatch.setattr(auto_segmentor, "_tracked_run", lambda cmd, **kw: seen.append((cmd, kw)))
    monkeypatch.setattr(auto_segmentor, "_combine_medformer_masks",
                        lambda raw, bdmap, out: open(out, "wb").close())
    monkeypatch.setattr(auto_segmentor, "get_least_used_gpu", lambda default_gpu=None: "0")
    monkeypatch.setattr(auto_segmentor, "_resolve_conda_exe", lambda: "conda")
    monkeypatch.setattr(auto_segmentor, "_env_command", lambda env, binary="python": f"ENV[{env}]")
    for name in ("RSUPER_CHECKPOINT_PATH", "MEDFORMER_CLASS_LIST", "RSUPER_PANKID_CHECKPOINT_PATH",
                 "RSUPER_PANKID_CLASS_LIST", "RSUPER_MERLIN_CHECKPOINT_PATH", "RSUPER_MERLIN_CLASS_LIST"):
        monkeypatch.delenv(name, raising=False)
    ct = tmp_path / "ct.nii.gz"
    ct.write_bytes(b"x")

    def run(model):
        out = auto_segmentor._run_rsuper_inference(str(ct), str(tmp_path / "session"), model=model)
        return seen[-1][0], out
    return run


def test_pancreas_kidney_runs_its_own_checkpoint_and_masks_lesions_by_organ(commands):
    cmd, out = commands("R-Super-Pancreas-Kidney")
    assert os.path.basename(out) == "rsuper_pancreas_kidney"
    assert "/R-SuperPancreasKidney/R_Super_Kidney_Pancreas_UCSF_Atlas3/fold_0_latest.pth" in cmd
    assert "/R-SuperPancreasKidney/labels_rsuper_mask.yaml" in cmd
    assert cmd.endswith("--organ_mask_on_lesion")


def test_merlin_runs_its_own_checkpoint_without_the_organ_mask_flag(commands):
    cmd, out = commands("R-Super-Merlin")
    assert os.path.basename(out) == "rsuper_merlin"
    assert "/Merlin-Cancer-Super/checkpoint/fold_0_latest.pth" in cmd
    assert "/Merlin-Cancer-Super/checkpoint/label_names.yaml" in cmd
    assert "--organ_mask_on_lesion" not in cmd


def test_the_original_r_super_model_is_unchanged(commands):
    cmd, out = commands("R-Super")
    assert os.path.basename(out) == "rsuper"
    assert "/R-SuperPanTSMerlin/merlin_pancreas_pants_release/fold_0_latest.pth" in cmd
    assert "/MedFormerPanTS/labels_pants.yaml" in cmd
    assert cmd.endswith("--organ_mask_on_lesion")


def test_each_release_takes_its_checkpoint_and_class_list_from_its_own_env_vars(commands, monkeypatch):
    monkeypatch.setenv("RSUPER_PANKID_CHECKPOINT_PATH", "/elsewhere/pk.pth")
    monkeypatch.setenv("RSUPER_MERLIN_CLASS_LIST", "/elsewhere/merlin.yaml")
    assert "--load /elsewhere/pk.pth" in commands("R-Super-Pancreas-Kidney")[0]
    assert "--class_list /elsewhere/merlin.yaml" in commands("R-Super-Merlin")[0]
    assert "/elsewhere" not in commands("R-Super")[0]


def test_every_release_is_dispatched_to_the_runner_by_its_model_id(monkeypatch, tmp_path):
    called = []
    monkeypatch.setattr(auto_segmentor, "_run_rsuper_inference",
                        lambda input_path, session_dir, model="R-Super": called.append(model) or str(tmp_path))
    for model in RSUPER_VARIANTS:
        auto_segmentor._run_auto_segmentation("in.nii.gz", str(tmp_path), model)
    assert called == list(RSUPER_VARIANTS)
    assert set(RSUPER_VARIANTS) == {"R-Super", "R-Super-Pancreas-Kidney", "R-Super-Merlin"}
