# R-Super releases (install and update)

The site serves three R-Super checkpoints through one runner (`RSUPER_VARIANTS` in `services/auto_segmentor.py`, which
runs `predict_abdomenatlas.py` from the `rsuper` conda environment and the repo in `RSUPER_SRC_PATH`).

| Model id (picker name) | Hugging Face release | Detects | Checkpoint (default path) |
|---|---|---|---|
| `R-Super-Pancreas-Kidney` | `AbdomenAtlas/R-SuperPancreasKidney` (CC BY-NC 4.0) | pancreatic, kidney and liver lesions, 40+ organs | `~/rsuper/R-SuperPancreasKidney/R_Super_Kidney_Pancreas_UCSF_Atlas3/fold_0_latest.pth` (607 MB) |
| `R-Super-Merlin` | `AbdomenAtlas/Merlin-Cancer-Super` (CC BY-NC-ND 4.0) | tumors of the bladder, gallbladder, spleen, esophagus, stomach, duodenum, prostate, uterus and adrenal glands, plus 26 organs | `~/rsuper/Merlin-Cancer-Super/checkpoint/fold_0_latest.pth` (303 MB) |
| `R-Super` (not in the picker) | `AbdomenAtlas/R-SuperPanTSMerlin` | pancreatic lesion | `~/rsuper/R-SuperPanTSMerlin/merlin_pancreas_pants_release/fold_0_latest.pth` |

All three are research-only (non-commercial) licenses; Merlin-Cancer-Super is also no-derivatives.

## Download (on bdmap1, then sync to the workers)

```
R=/home/visitor/rsuper; HF=https://huggingface.co
mkdir -p $R/R-SuperPancreasKidney/R_Super_Kidney_Pancreas_UCSF_Atlas3 $R/Merlin-Cancer-Super/checkpoint
curl -L --fail -o $R/R-SuperPancreasKidney/labels_rsuper_mask.yaml $HF/AbdomenAtlas/R-SuperPancreasKidney/resolve/main/labels_rsuper_mask.yaml
curl -L --fail -o $R/R-SuperPancreasKidney/R_Super_Kidney_Pancreas_UCSF_Atlas3/fold_0_latest.pth $HF/AbdomenAtlas/R-SuperPancreasKidney/resolve/main/R_Super_Kidney_Pancreas_UCSF_Atlas3/fold_0_latest.pth
curl -L --fail -o $R/Merlin-Cancer-Super/checkpoint/label_names.yaml $HF/AbdomenAtlas/Merlin-Cancer-Super/resolve/main/checkpoint/label_names.yaml
curl -L --fail -o $R/Merlin-Cancer-Super/checkpoint/fold_0_latest.pth $HF/AbdomenAtlas/Merlin-Cancer-Super/resolve/main/checkpoint/fold_0_latest.pth
flask-server/scripts/sync_gpu_workers.sh
```

A worker that lacks a file fails its preflight (`[gpu_workers] ... missing model files`) and the job goes to the next worker or to
bdmap1, so a missing copy on one worker is not an outage. `/home/visitor` on a worker with a full disk quota cannot receive them.

## Settings (`flask-server/.env`, all optional)

`RSUPER_PANKID_CHECKPOINT_PATH`, `RSUPER_PANKID_CLASS_LIST`, `RSUPER_MERLIN_CHECKPOINT_PATH`, `RSUPER_MERLIN_CLASS_LIST` override the
paths above; `RSUPER_SRC_PATH` and `CONDA_ENV_MEDFORMER` are shared with the other R-Super models. The `RSUPER_` prefix is already
forwarded to GPU workers.

## What the viewer shows

`predict_abdomenatlas.py` writes one `<class>.nii.gz` per class. They are combined into `combined_labels.nii.gz` in the viewer's
numbering (`services/label_scheme.py`): organs first, then sub-regions, then lesions, so a lesion stays visible inside its organ.
`celiac_trunk` is shown as the celiac artery and Merlin's `adrenal_lesion` as the adrenal gland lesion. The eight liver segments and the
hepatic vessel have no 2D slot and are left out, as for the other models.
