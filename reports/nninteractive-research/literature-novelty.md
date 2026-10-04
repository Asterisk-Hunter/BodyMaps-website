# Literature notes: prompt-conditioned crop continuation

Research checked: 4 October 2026.

## Selected research question

Can a trained segmentation model distinguish a prompted target continuing beyond an artificial crop from a genuine endpoint or foreground spillover, and use that distinction to recover thin or elongated anatomy at native resolution with fewer corrections?

The proposed contribution connects three dependent parts: a prompt-conditioned crop-boundary predictor, selective continuation into neighboring native-resolution crops, and consistent fusion of the resulting target mask. Inputs can include image and decoder features, previous segmentation, accumulated positive/negative prompts, crop geometry, and physical voxel spacing. Training labels come from full target masks sampled into artificial crops, with continuation, endpoint, and spillover examples.

The scientific distinction is **continuation of the user-selected target under changing prompts**. A negative correction can change which branch belongs to the intended target; anatomical connectivity alone does not determine the desired segmentation. Artificial crop truncation also differs from acquisition field-of-view truncation, where anatomy beyond the scan is unobserved.

This is a research hypothesis. The search identified related methods but no exact match in the retrieved literature. Novelty remains provisional, especially pending complete review of ErrorRoute and the closest tracking methods.

## Closest relevant sources

| Source and publication status | Relevant overlap | Evidence inspected |
|---|---|---|
| [nnInteractive](https://arxiv.org/abs/2503.08373), 2025 paper; [official code](https://github.com/MIC-DKFZ/nnInteractive) | Promptable volumetric segmentation and adaptive crop processing form the starting baseline. Exact implementation observations are recorded in the separate code audit. | Primary abstract and official repository. |
| [SLIP](https://arxiv.org/html/2607.22332v1), July 2026 preprint | Cached image features, memory-conditioned patch propagation, and interactive updates are close architectural context. Its prospective expert study informs annotation evaluation. | Full manuscript HTML. Peer-reviewed acceptance not established. |
| [SAMI3D-DW](https://arxiv.org/html/2609.25743v1), September 2026 technical preprint | Recent point/box segmentation competitor with strong reported vascular results and a broad CT/MR benchmark. | Full report HTML. Proprietary training limits direct reproduction. |
| [SeqSeg](https://arxiv.org/abs/2501.15712), Annals of Biomedical Engineering; online September 2024, 2025 volume; [code](https://github.com/numisveinsson/SeqSeg) | Local nnU-Net segmentations, geometric tracking, branching queues, and sparse-seed vascular-tree assembly. | Primary abstract and official implementation description. |
| [Global Control for Local SO(3)-Equivariant Scale-Invariant Vessel Segmentation](https://arxiv.org/html/2403.15314v2), STACOM 2024/revised proceedings 2025 | Coarse segmentation supplies start/stop conditions to a local vessel tracker, addressing early termination and roaming. | Full manuscript HTML. |
| [BEA-CACE](https://pubmed.ncbi.nlm.nih.gov/40751109/), International Journal of Computer Assisted Radiology and Surgery, 2025; DOI 10.1007/s11548-025-03483-1 | Double-DQN tracking with a 3D CNN bifurcation, endpoint, and radius detector; extraction from one seed. | Primary abstract and publication metadata. Full methods remain to review. |
| [Adaptive Morph-Patch Transformer](https://arxiv.org/html/2511.06897v1), November 2025 preprint | Learned velocity/deformation fields create morphology-aligned patches; semantic clustering attention supports aortic segmentation. | Full manuscript HTML. |
| [ErrorRoute](https://www.biorxiv.org/content/10.64898/2026.09.21.753373v1), September 2026 preprint | Learns expected native-resolution refinement utility and selects 3D blocks under a compute budget. It is the closest comparison for learned resolution routing. | Primary DOI abstract retrieved in the main audit. Full body/code review remains outstanding. |

## How the proposed formulation relates to these methods

Local vessel tracing, endpoint prediction, adaptive patch geometry, and learned refinement utility already have relevant precedents. The proposed model combines a more specific supervision target—whether the prompted object is censored by the current crop—with prompt-dependent continuation decisions and segmentation feedback.

The comparison should establish whether this supervision improves target recovery beyond anatomical endpoint detection or generic block utility. It should also test whether negative prompts redirect continuation correctly near adjacent vessels, branching structures, or connected distractors. These are the central distinctions to evaluate against the retrieved methods.

SLIP reports low interaction latency and includes a six-expert study across three tasks. SAMI3D-DW reports higher category-macro Dice than nnInteractive on its 4,326-case benchmark, while noting limitations in unseen-site evaluation. These sources provide contemporary performance context; their numbers use different protocols and cannot be directly combined into a shared ranking.

## Evidence needed for the selected paper

1. **Measured crop-boundary failures.** Record baseline interaction trajectories and quantify premature stopping, spillover expansion, and thin-detail loss. Stratify by physical thickness, anisotropy, orientation, crop-face contact, contrast, and branching. Audit scan truncation and annotation completeness separately.
2. **Learnable boundary states.** Evaluate continuation/endpoint/spillover prediction on held-out patients and sources, including varied prompts. Report discrimination, calibration, and prompt-dependent changes in predictions.
3. **Causal segmentation benefit.** Measure how boundary decisions change recovered target coverage, centerline or branch recall, false connections, and correction effort. An oracle continuation experiment can estimate the available improvement at a fixed patch budget.
4. **Controlled method comparisons.** Match data, initial prompts, training effort, and inference budgets across standard nnInteractive, same-data fine-tuning, tuned crop heuristics, larger-crop or tiling baselines, uncertainty routing, and learned utility routing. Add applicable vessel-tracking and endpoint-detector comparisons.
5. **Dependent component evidence.** Compare continuation supervision, prompt conditioning, selective native-resolution routing, and overlap fusion separately, then evaluate the full model. Include a frozen segmentation-engine experiment to separate routing effects from trained segmentation improvements.
6. **External annotation evidence.** Use audited patient/source splits, an external dataset or institution, and a second suitable thin-structure target where available. Report quality versus correction budget, runtime, patch count, memory, failure rate, and expert time to an adjudicated acceptable mask.

A convincing result would connect better crop-boundary reasoning to improved segmentation and annotation efficiency at comparable resources. Gains confined to a classifier metric, one training anatomy, or extra computation would support a narrower conclusion.

## Access and novelty status

The bounded search covered crop continuation, local vessel tracking, endpoints, adaptive patches, interactive segmentation, and compute routing. Exact novelty remains open until the outstanding full methods are reviewed and citation tracing is completed. Published and preprint sources are distinguished above. Publication potential depends on the resulting evidence; acceptance is not established by this literature assessment.
