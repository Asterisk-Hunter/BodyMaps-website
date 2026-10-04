# Evaluation and feasibility: learned crop continuation

Research date: 2026-10-04. The selected method learns whether the prompted target continues across an artificial crop boundary, distinguishes true endpoints and spillover, and gathers further native-resolution evidence selectively. Engine inspection and CPU probes support the mechanism; trained-method performance and real-case causal impact are unmeasured. Institutional GPU use and JHU PanTS access are planned according to the user; exact hardware, cohort permissions and expert availability remain to be established.

## Training formulation

Condition a continuation head on local image/decoder features, accumulated signed prompts, previous mask and crop geometry. Generate supervision by cutting artificial crops from fully annotated training volumes and tracing the selected target into observed neighboring image. Include natural endpoints, nearby distractors, failed baseline trajectories and user-restricted target variants. Scan field-of-view truncation and incompletely annotated distal anatomy require separate uncertain labels or adjudication.

First demonstrate a small supervised run through the real prompt/mask interface. The local trainer is a network-reconstruction stub, so data loading, interaction simulation, losses, augmentation and optimization must be implemented reproducibly. Train a small continuation head with the segmenter frozen to isolate information value, then assess joint segmentation/continuation training. Retain identical training data and interaction distributions across controls. Reference masks create training labels and evaluation targets; runtime routing receives model inputs only.

The original nnInteractive training used eight A100 40GB GPUs for approximately 11–12 days across diverse datasets. That foundation-pretraining cost differs from the proposed pretrained-backbone experiment. Profile representative crops, gradients and unrolled interactions before choosing batch size and hardware; available institutional GPUs should determine the measured plan. [nnInteractive paper](https://arxiv.org/html/2503.08373v1)

## Data provenance and split

PanTS aggregates public abdominal collections and reserved external cohorts, including duct, vessel and surrounding-organ annotations. Its paper describes 9,901 public training scans and 26,489 reserved test scans. Confirm accessible release, labels and permissions rather than treating the published totals as available study data. [PanTS paper](https://arxiv.org/html/2507.01291v1), [official repository](https://github.com/MrGiovanni/PanTS)

Build a patient/source manifest containing original collection/ID, institution, phase/series, image hash and geometry, annotation revision and quality, label availability and permitted use. Keep all visits/phases from a patient together. Audit overlap with nnInteractive pretraining, the automatic initializer and competing encoders: later release dates or new labels do not establish unseen images. nnInteractive's reported training sources include AbdomenAtlas1.1Mini, MSD hepatic vessels, TotalSegmentatorV2, TopCoW, SegA and AortaSeg24. [nnInteractive paper](https://arxiv.org/html/2503.08373v1)

Use public sources for training/development, source-held-out validation for selection, and a frozen external test cohort. Independently quality-check thin structures, endpoints and target identity. Report missing/incomplete labels explicitly. SuPreM predictions serve as initialization, while independently reviewed annotations define reference quality.

## Comparisons that establish the contribution

| Scientific question | Required comparison |
|---|---|
| Does crop continuation limit baseline quality? | Pinned nnInteractive, crop traces, diagnostic oracle continuation at the same patch budget. |
| Is learning necessary? | Validation-tuned border/contact thresholds, reduced/no opening, larger or anisotropic crops, exhaustive native-resolution coverage. |
| Does continuation supervision add value? | Same-data backbone fine-tuning; parameter/compute-matched generic uncertainty or utility head; endpoint-only head. |
| Does changing user intent matter? | Full model versus removed prompt conditioning, including signed corrections and adjacent competing targets. |
| Does selective native-resolution expansion matter? | Continuation prediction with fixed scheduling, generic routing with selective scheduling, and the coupled method. |
| How does it compare with the nearest methods? | Learned utility routing, local vessel propagation/patch growth, endpoint tracking, and a relevant runnable interactive competitor. |

Closest comparisons include [ErrorRoute](https://doi.org/10.64898/2026.09.21.753373), [SeqSeg](https://arxiv.org/html/2501.15712v1), [global/local geometric tracking](https://arxiv.org/html/2403.15314v1), [BEA-CACE](https://doi.org/10.1007/s11548-025-03483-1), and [Adaptive Morph-Patch Transformer](https://arxiv.org/html/2511.06897v1). ErrorRoute's primary abstract was verified during research, but full-method access remains an unresolved novelty dependency. Confirm executable implementations and weights; identify approximations transparently. [SLIP](https://arxiv.org/html/2607.22332v1) provides a current interactive accuracy/latency comparison where runnable.

Keep backbone, initializer, preprocessing, patch size, output fusion and postprocessing fixed for the policy-only experiment. Compare joint-training variants against same-data, same-budget training controls. Report matched interaction effort and compute, plus a quality/compute curve when exact runtime equality is impractical.

## Interaction protocol and outcomes

Evaluate empty-mask prompting and correction of a fixed automatic mask as separate tracks. Use point-only and 2D-box-initialized workflows separately. Combine fixed recorded histories with closed-loop simulation using the same error-selection policy on each method's own predictions. Count additional human inputs and calibrate mixed-tool budgets to measured drawing time. [RadioActive simulator](https://arxiv.org/abs/2411.07885), [RClicks](https://arxiv.org/abs/2410.11722)

Predeclare a primary outcome, provisionally normalized surface-Dice AUC across a fixed correction budget on thin targets, with task-specific millimetre tolerance justified by annotation variability. Report Dice/NSD at 1, 3, 5 and 10 corrections, accepted-quality failure rate, centerline/endpoint coverage, breaks, false bridges and leakage. Include ordinary organs as regression controls. Stratify by thickness, anisotropy, orientation, branch structure, contrast, crop-face position and scan truncation.

Evaluate the learned decision itself using continuation/endpoint/spillover confusion, calibration, missed continuation, false expansion and routing precision. Connect these decisions to downstream segmentation and effort. Record evaluated patches, peak memory, p50/p95 latency and failures, separating cold load, preprocessing, inference, transfer and viewer refresh.

Human validation should use independent experts, practice cases, counterbalanced order, matched cases and blinded final-mask adjudication. Compare time to accepted quality or quality under fixed time; derive sample size from pilot variance and power. Analyze paired patients with patient/reader/institution clustering, confidence intervals and prespecified multiplicity handling. Multiple slices or correction rounds from one patient remain correlated.

## Staged decision gates

1. Pin checkpoint, engine commit, Docker digest and prompt capabilities; reproduce baseline with wrapper/grid controls and reliable reference masks.
2. Establish real crop-censoring frequency and its causal contribution. Measure diagnostic oracle benefit and strong heuristic interventions.
3. Verify a trainable interface, then assess frozen-backbone continuation learning against matched controls and held-out sources.
4. Advance to joint training and expert validation when downstream gains survive matched compute, same-data fine-tuning and leakage/false-bridge checks.

The paper becomes defensible when its learned distinction produces worthwhile external-cohort quality and effort improvements. Small oracle benefit or parity with simple heuristics would narrow the claim; classifier accuracy alone would not establish better annotation. Venue suitability follows those results. The immediate work is the pinned baseline, clean source split and crop-continuation diagnostic study.
