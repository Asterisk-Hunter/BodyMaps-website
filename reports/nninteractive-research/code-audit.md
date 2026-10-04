# Code evidence for prompt-conditioned crop continuation

Audit date: 2026-10-04. The selected paper studies whether learning that the prompted target continues beyond an artificial crop improves native-resolution segmentation and reduces corrective effort. Static inspection and CPU synthetic probes establish the engine mechanisms below. Real-case causality and model superiority remain to be measured.

## Baseline provenance

The audited nnInteractive checkout is commit `bbe12fdccc876cb2d4e0a47133811e362608e000`, dated 2026-07-10, with a clean working tree and source package version `2.5.1` (`nnInteractive/pyproject.toml:3`). The BodyMaps checkout is `30916b30241cdad4d5c1ed284c86f08817265827`, dated 2026-10-03; its reports directory was untracked. Neither package revision identifies the trained checkpoint. The active Docker image, checkpoint hash and capability metadata remain unverified.

The engine reconstructs its architecture from checkpoint trainer/configuration and `plans.json`, then loads weights (`nnInteractive/nnInteractive/inference/inference_session.py:1967`, `:1979`, `:1987`, `:1992`). Local workspace searches found no checkpoint or model plans. The bundled `nnInteractiveTrainer_stub` provides network construction (`nnInteractive/nnInteractive/trainer/nnInteractiveTrainer.py:6`, `:21`); a reproducible training pipeline must supply its own data, prompt simulation, augmentation and optimization.

## Verified mechanism chain

Pointers below refer to `nnInteractive/nnInteractive/inference/inference_session.py` unless a full path is given.

| Engine behavior | Source | Relevance to the selected paper |
|---|---|---|
| Volumetric image and prompt inputs | Image contract `[c,x,y,z]` at `:728`; image/prompt concatenation at `:1606` | The baseline already uses local 3D context. The new learning target is continuation across a crop boundary. |
| Border-change stopping | `:1743`–`:1777` | Expansion triggers on changed face area >1500, or >100 with relative area change >0.2. This tests mask changes rather than target continuation. |
| Scalar AutoZoom | Maximum factor 4 at `:47`; growth factor 1.5 at `:1475`; crop scaling at `:1540` | Enlarging every axis increases context while reducing sampled detail. |
| Fixed-patch resampling | Interaction area interpolation at `:1580`; image trilinear interpolation at `:1590` | Thin evidence can be diluted during the coarse pass; real-case effect needs isolation. |
| Native-resolution refinement | `:1507`–`:1523`, `:1706`, `:1724`–`:1729` | Refinement already exists. The contribution concerns learned continuation decisions and where further native-resolution evidence is gathered. |
| Difference-map opening and fallback | Kernel-5 min/max pooling at `:1812`–`:1819`; last-prompt fallback at `:1833`, `:1863` | Thin change regions can disappear from refinement planning, while fallback and patch margins may compensate. |
| Voxel-space geometry | Spacing accepted but unused at `:731`–`:732` | Thickness, spacing and orientation should be recorded and stratified when assessing continuation. |

The [CPU probe results](mechanism-probe-results.json) contain 29 passing cases using actual source functions extracted by AST, with source hashes and versions. Empty-to-border changes of 1, 25 and 100 voxels did not trigger AutoZoom; 101 and 900 did. Unchanged occupied-border controls did not trigger it. Kernel-5 opening removed width-1–4 straight difference-map tubes in every axis, preserving widths 5–6. An equal-volume 512-voxel cube survived while a width-4 tube disappeared. These measurements establish predicate/operator behavior; they do not measure segmentation failure frequency or downstream harm. The [probe explanation](mechanism-probes.md) records the CPU-only cache-helper substitution and other limits.

## BodyMaps controls for valid attribution

BodyMaps applies largest-component filtering after prediction (`BodyMaps-website/flask-server/api/api_blueprint.py:7982`–`:7993`, `:8203`–`:8209`), while the predictor returns a copy of the unfiltered target (`BodyMaps-website/flask-server/services/nninteractive_predictor.py:301`). Benchmark the direct engine and an explicitly documented wrapper configuration so filtering cannot explain apparent target incompleteness.

The API selects low/full CT at `api_blueprint.py:7850`–`:7854` and can resample output onto the mask grid at `:7998`. Record served image hash, shape, spacing, affine, padding and output grid for each case. Compare the automatic initializer and reference annotation separately.

The existing 16-row interaction log records timestamp, case, target label, polarity, requested resolution and prompt type (`api_blueprint.py:7828`–`:7846`). Complete experimental records require actual prompt payloads, pre/post masks, crop/zoom/refinement decisions, accepted-quality assessments and separated model/transport/human timings. The earlier manual report supplies pilot observations; the prospective study must establish their frequency and cause.

## Evidence needed next

Reproduce pinned baseline trajectories on independently annotated development cases. Identify crop boundaries where the intended target continues in observed neighboring image; distinguish natural endpoints, distractor leakage and scan field-of-view truncation. Trace stopping/refinement decisions and run intervention controls, including lower thresholds, changed opening and exhaustive native-resolution coverage. An oracle continuation policy under the same patch budget measures the available benefit. This diagnostic stage determines whether learning continuation addresses a substantial bottleneck before training begins.
