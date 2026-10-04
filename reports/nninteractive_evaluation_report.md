# Learning Target Continuation Across Crops for Interactive 3D Segmentation

Research proposal for BodyMaps, reviewed 4 October 2026.

## Research objective

Develop and evaluate a prompt-conditioned continuation model that identifies when a user-selected structure extends beyond an inference crop, then allocates additional native-resolution patches to recover its extent.

The intended contribution is improved thin-structure completeness under matched interaction and compute budgets. The study will also measure leakage, false connections and annotation effort.

## Scientific question

Interactive volumetric segmentation operates within finite inference crops. A structure touching a crop face can continue outside that crop, terminate naturally, or represent leakage into a nearby structure. These cases require different decisions.

The proposed method learns this distinction from the image, accumulated signed prompts, previous segmentation and crop geometry. Its predictions guide acquisition of adjacent patches while preserving the user's target.

The initial clinical setting is thin structures around the pancreas, such as pancreatic/common bile ducts and selected vessels, where image visibility and complete reference annotations support evaluation. PanTS is the intended development dataset. Independently sourced cohorts provide external evaluation; ordinary organs provide regression controls.

## Existing evidence

The audited nnInteractive source is package 2.5.1, commit `bbe12fdccc876cb2d4e0a47133811e362608e000`.

Its border-change detector triggers when changed border area exceeds 1,500 voxels, or exceeds 100 voxels with relative change greater than 0.2. Its refinement-planning difference map uses erosion followed by dilation with an effective kernel width of five voxels.

Twenty-nine controlled CPU checks reproduced these operators:

- Changes of 1, 25 or 100 border voxels from an empty prior border did not trigger expansion; 101 did.
- Straight difference-map tubes one to four voxels thick disappeared in all three orientations.
- A 512-voxel thin tube disappeared while a 512-voxel cube survived.

These checks demonstrate numerical behavior. They have not established the frequency of real segmentation failures or the performance of a new model. The filtered map controls refinement planning; fallback patches and other refinement paths may compensate.

nnInteractive already processes volumetric images and prompts and provides native-resolution refinement. The research contribution concerns the learned decision about target continuation and patch allocation.

## Contribution and method

The paper has two connected methodological contributions:

1. A formulation and empirical diagnosis of crop-induced incompleteness, distinguishing artificial truncation, natural termination and leakage.
2. A learned prompt-conditioned continuation model coupled to bounded native-resolution patch expansion.

A small continuation head will use local image/decoder features, the previous mask, accumulated positive and negative prompts, crop position and physical spacing. Boundary candidates will receive continuation, termination, leakage or unresolved predictions. The exact output representation will be selected during development.

Full training masks intersected with sampled artificial crops supply supervision. Complete annotations and true endpoints are important: missing labels could otherwise teach false termination. Training trajectories will include erroneous segmentations and nearby distractors.

The scheduler will select adjacent native-resolution patches within a defined work budget, carry prompt context forward, merge overlaps consistently and prevent repeated traversal. All feature extraction and patch passes count toward the compute budget. Runtime routing uses observed image evidence and prompts.

First train the continuation head with the segmentation engine frozen. Evaluate joint fine-tuning once this establishes useful information. Both stages use controls with matching training data and comparable capacity.

## Closest related work

| Work | Relevant comparison |
|---|---|
| [nnInteractive](https://arxiv.org/html/2503.08373v1) | Interactive 3D baseline with AutoZoom and native-resolution refinement |
| [ErrorRoute](https://doi.org/10.64898/2026.09.21.753373) | Learned native-resolution refinement utility and budget routing; full-method access remains unresolved |
| [SeqSeg](https://arxiv.org/html/2501.15712v1) | Sequential local vessel segmentation and branch queues |
| [Global Control for Local Vessel Segmentation](https://arxiv.org/html/2403.15314v1) | Global extent control and geometric local tracking |
| [BEA-CACE](https://doi.org/10.1007/s11548-025-03483-1) | Learned vessel endpoint and bifurcation tracking |
| [Adaptive Morph-Patch Transformer](https://arxiv.org/html/2511.06897v1) | Morphology-adapted patch representation |
| [SLIP](https://arxiv.org/html/2607.22332v1) | Contemporary interactive 3D accuracy and latency comparison |

The proposed distinction is target continuation across artificial crop boundaries conditioned on changing user intent. Novelty remains provisional until the closest full methods are compared. The literature review covers publicly discoverable work through 4 October 2026.

## Experimental plan

### Baseline and data preparation

Pin the deployed image, checkpoint, plans, configuration and image/mask geometry. Compare engine outputs under common postprocessing. BodyMaps' largest-component cleanup is an integration control because it can remove disconnected predictions.

Build patient/source manifests recording original collection IDs, institutions, phases, geometry, annotation revisions and permissions. PanTS annotation novelty alone does not establish image independence from nnInteractive training data. Keep all patient visits and phases within a single split.

Collect reproducible prompt trajectories, crop decisions, masks, quality measurements and separate model/transport/render timings. The existing interaction telemetry is insufficient for a performance study.

### Diagnostic pilot

Use approximately 60–100 distinct development patients as an initial diagnostic sample, subject to data availability and label review.

Measure real crop-induced misses and their recoverability. Use ground-truth-informed continuation as an evaluation-only upper bound. Compare threshold tuning, reduced/no difference-map opening, geometry-based continuation and larger/full refinement. This establishes both the available improvement and the contribution needed from learning.

### Main comparisons and ablations

Compare pinned nnInteractive, strong inference controls, same-data ordinary fine-tuning, the proposed method and available relevant competitors under matched information and work.

Test continuation supervision against generic utility/uncertainty and endpoint prediction with matched capacity. Ablate prompt conditioning and selective scheduling. Examine positive extension and negative restriction prompts, thickness, contrast, branching, orientation and anisotropic spacing.

Use fixed-prompt replay and closed-loop simulation with a common policy applied to each method's own errors. Report point-only and box-initialized workflows separately.

### Outcomes and analysis

The provisional primary endpoint is normalized surface-Dice AUC over a fixed interaction budget, with predefined task-specific millimetre tolerances.

Secondary outcomes include centerline/branch coverage where labels permit, clDice, false bridges, spillover, Dice, HD95, prompt violations, failure rates and ordinary-organ performance. Report latency, memory and total inference work alongside quality.

Use paired patient comparisons, confidence intervals and analyses that account for patient, institution and reader clustering. Estimate final sample size from diagnostic variance and effect size. Freeze the final external cohort before model selection is completed.

### Expert annotation study

A counterbalanced BodyMaps study will measure time to independently assessed acceptable quality, with matched cases and practice sessions. Record inspection/navigation, drawing, computation and transport separately. Reader participation and study size remain to be established.

## Manuscript structure

Use the supplied LNCS-style example as the writing reference:

1. Introduction: clinical need, crop-continuation problem and contributions.
2. Method: continuation supervision and bounded native-resolution expansion.
3. Experimental Setup: audited cohorts, trajectories, budgets, baselines and statistics.
4. Results: diagnostic evidence, main comparison, ablations, external evaluation and completed reader study.
5. Discussion and Conclusion: demonstrated scope, failure modes and practical trade-offs.

Planned figures are a verified crop-truncation case, the method flow, quality-versus-interaction/compute curves and external successes/failures. Planned tables cover main comparisons, diagnostic/component controls and external/reader outcomes.

Published [DeepIGeoS, IEEE TPAMI](https://pmc.ncbi.nlm.nih.gov/articles/PMC6594450/) and [3DSAM-adapter, Elsevier Medical Image Analysis](https://www.sciencedirect.com/science/article/pii/S1361841524002494) provide examples of connected method components supported by controlled evaluation.

## Current status

Source-level mechanism checks are complete. Training GPU access and PanTS/additional data are planned. The immediate stage is deployment/data provenance and the real-data diagnostic pilot. No new-model performance or publication outcome has been established.

## Supporting evidence

- [Research evidence index](nninteractive-research/RESEARCH_DECISION.md)
- [Writing-template mapping](nninteractive_paper_template_mapping.md)
