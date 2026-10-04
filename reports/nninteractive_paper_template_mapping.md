# Paper writing structure

Reviewed 4 October 2026. Writing reference: the supplied `research_paper.txt` example inspected on this date.

## Format reference

The supplied file uses Springer's LNCS LaTeX class and a MICCAI 2025 template header. It contains a populated CancerVerse example. Its narrative connects a specific problem to a focused contribution, a controlled benchmark and measured results.

The associated preamble, bibliography and figure assets were not supplied in the reports folder at inspection. A complete LaTeX project and the selected venue's current author kit will be assembled for submission.

## Mapping to our study

**Title:** Learning Target Continuation Across Crops for Interactive 3D Segmentation.

| Section | Content |
|---|---|
| Abstract | Crop-completeness problem, proposed continuation model, evaluated data/budgets, measured outcome and bounded conclusion |
| Introduction | Annotation need, existing interactive 3D capability, crop-boundary ambiguity, central hypothesis and contributions |
| Related work | Promptable 3D segmentation, local tracing/termination and adaptive-resolution routing |
| Method | Target-conditioned continuation supervision and budgeted native-resolution patch expansion |
| Experimental Setup | Data provenance, complete thin-target labels, patient/source splits, prompts, matched budgets, baselines and statistical analysis |
| Results | Real-case mechanism frequency/oracle headroom, main comparison, inference/training/component controls, external transfer and completed reader study |
| Discussion and Conclusion | Demonstrated scope, leakage/compute trade-offs, ambiguous annotations and failure cases |
| Credits and references | Confirmed study-specific authorship, funding, approvals, disclosures and verified citations |

## Contribution wording

1. Formulation and empirical diagnosis of crop-induced incompleteness, distinguishing artificial truncation, natural termination and leakage.
2. Learned prompt-conditioned continuation with bounded native-resolution expansion, supported by controlled segmentation and annotation evaluation.

## Figures and tables

- Verified real-case teaser showing crop extent, target extent and reference.
- Method diagram marking training-only mask supervision and runtime inputs.
- Quality-versus-interaction and quality-versus-compute curves.
- External successes and failure examples.
- Main comparison, diagnostic/ablation and external/reader tables.

The current evidence consists of source audit and controlled mechanism checks. Results and result-bearing abstract sentences will be written from completed experiments.

Full study plan: [nninteractive_evaluation_report.md](nninteractive_evaluation_report.md).
