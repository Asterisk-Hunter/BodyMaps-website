# Synthetic mechanism probes

Executed on 2026-10-04 with `python artifacts/nninteractive-research/mechanism_probe.py`. CPU only; PyTorch `2.8.0+cu128`, detector uint8 and morphology float16. All 29 cases passed their assertions. The script extracts the unchanged source function ASTs from the audited checkout, compiles them, and calls them directly; JSON records file/function SHA-256 hashes, source lines, package versions, arguments and case results. No checkpoint, model inference, GPU, new dependency, or application change was involved.

## Border stopping

For a single occupied crop face with empty previous segmentation, 1, 25, and 100 changed face voxels returned `False`; 101 and 900 returned `True`. All five corresponding unchanged occupied-face controls returned `False`, including 900 occupied voxels. This establishes the strict `>100` condition in the relative-change branch of `_detect_change_at_border`, and shows that border contact alone does not force continuation. It does not establish that continuation was anatomically necessary in any real case.

| Changed face pixels from empty | AutoZoom trigger |
|---:|---|
| 1 | False |
| 25 | False |
| 100 | False |
| 101 | True |
| 900 | True |

## Difference-map opening

The actual upstream pooling function, called as kernel-size-5 erosion then dilation, eliminated all voxels of straight difference-map tubes with square cross-section widths 1–4, and preserved tubes of widths 5–6. This held in all three axis orientations using a 32 x 32 x 32 array; tubes traversed the entire array and the upstream replicate-padding behavior was retained. A 4 x 4 x 32 tube lost all 512 change-map voxels, whereas an 8 x 8 x 8 cube with the same 512 voxels retained all of them. This directly shows dependence on geometric thickness rather than total changed volume.

| Tube cross-section width | Before voxels | After voxels, each orientation |
|---:|---:|---:|
| 1 | 32 | 0 |
| 2 | 128 | 0 |
| 3 | 288 | 0 |
| 4 | 512 | 0 |
| 5 | 800 | 800 |
| 6 | 1152 | 1152 |

The missing `nnunetv2` dependency was avoided by AST extraction. Its cache-management helper `empty_cache` was replaced with a CPU-only no-op; all numerical tensor operations and the temporary cuDNN benchmark flag changes were unchanged. This substitution is explicitly recorded in the results and cannot be used for GPU runtime claims.

These are limited synthetic tests of predicates and operators. The opening acts on the refinement difference map, not the output segmentation itself. Other changed regions, margins, fallback patch selection and native-resolution refinement can compensate. Real-case impact, frequency, clinical significance, novel-method effectiveness and superiority remain untested. Treat these probes as mechanism evidence supporting a focused falsification study, not a segmentation benchmark.

## Reproducing from this repository

Clone the audited nnInteractive revision into a workspace alongside BodyMaps and run `python reports/nninteractive-research/mechanism_probe.py --workspace-root /path/to/workspace` from the BodyMaps repository. The environment needs PyTorch and NumPy; output is written beside the script.
