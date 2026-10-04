# Single-paper blueprint

Reviewed 4 October 2026.

**Working title:** Learning Target Continuation Across Crops for Interactive 3D Segmentation.

**Central hypothesis:** a model that distinguishes continuation beyond an artificial crop from natural termination and leakage can improve thin-target completeness through bounded native-resolution expansion under matched interaction and compute budgets.

## Connected scope

| Element | Role in the paper |
|---|---|
| Crop-border decisions | Diagnose missed thin crossings and distinguish artificial truncation from endpoints |
| Thin difference-map filtering | Measure its effect on refinement allocation and establish a strong inference control |
| Prompt-conditioned continuation head | Learn whether the selected target continues into observed neighboring image |
| Bounded native-resolution expansion | Convert predictions into segmentation recovery within the work budget |
| Spacing and orientation | Conditioning/robustness analysis |
| Coverage, spillover and annotation effort | Validate accuracy and practical benefit |

## Method

Train continuation supervision from complete masks intersected with artificial crops. Include real prompt trajectories, natural endpoints, distractors and failed predictions. Condition on image/decoder features, prior mask, signed prompts, crop geometry and physical spacing.

Begin with a frozen segmentation engine and a small trained head, then evaluate joint fine-tuning. Select adjacent native-resolution patches within a defined budget, preserve prompt context and merge overlaps using a common procedure.

## Evidence required

| Question | Experiment |
|---|---|
| Is crop incompleteness a real bottleneck? | Development-case traces, reviewed reference masks and continuation-oracle upper bound |
| What is gained beyond inference adjustments? | Tuned thresholds, reduced/no opening, geometry rules and full/larger refinement |
| What is gained beyond domain training? | Same-data, same-budget ordinary nnInteractive fine-tuning |
| Does the learned distinction matter? | Matched-capacity continuation, utility/uncertainty and endpoint heads |
| Do prompts and scheduling matter? | Component ablations and positive/negative extent tests |
| Does the result generalize? | Patient/source audits, independent external cohorts and ordinary-organ controls |
| Does it help annotators? | Counterbalanced expert time-to-quality study |

## Evidence status

Twenty-nine controlled checks reproduced small-border non-triggering and thin-change removal in the planning map. Real-case impact and new-model performance remain unmeasured. nnInteractive already has 3D context and native refinement.

The closest novelty comparisons include ErrorRoute, SeqSeg and learned endpoint/global-local tracking. ErrorRoute's full-method review remains open.

## Writing plan

Introduction → Method → Experimental Setup → Results → Discussion and Conclusion.

Use real examples, a method diagram, matched-budget performance curves and main/ablation/external evaluation tables. Study results will determine the final abstract and contribution wording.

The [main research proposal](../nninteractive_evaluation_report.md) contains the complete clean plan. The [template mapping](../nninteractive_paper_template_mapping.md) connects it to the supplied writing example.
