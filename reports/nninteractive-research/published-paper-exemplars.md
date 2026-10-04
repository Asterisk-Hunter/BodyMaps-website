# Published examples for a coherent crop-continuation paper

Checked: 4 October 2026. These published methods illustrate how connected technical components support a scientific claim. They provide evidence-design examples rather than venue requirements or acceptance predictions.

## DeepIGeoS

**Publication:** IEEE Transactions on Pattern Analysis and Machine Intelligence, 41(7), 1559–1572, July 2019; DOI 10.1109/TPAMI.2018.2840695. Accepted May 2018 and published online in 2018. **Access:** full article read through PMC.

Initial and refinement networks, geodesic prompt encoding, resolution preservation, and constrained CRF support efficient interactive medical refinement. Comparisons of geodesic versus Euclidean prompts and CRF variants use the same scribbles; quality, drawing effort, and user time are measured in 2D and 3D tasks. The useful pattern is to test how each component contributes to one correction pipeline. [Full article](https://pmc.ncbi.nlm.nih.gov/articles/PMC6594450/)

## BIFSeg

**Publication:** Interactive Medical Image Segmentation Using Deep Learning With Image-Specific Fine Tuning, IEEE Transactions on Medical Imaging, 37(7), 1562–1573, July 2018; DOI 10.1109/TMI.2018.2791721. **Access:** institutional metadata/abstract and primary indexed methods/results inspected; full live retrieval was incomplete.

Bounding-box binary training, image-specific adaptation, uncertainty weighting, and scribbles support adaptable segmentation of unseen objects. Comparisons hold initialization and scribbles constant, examine loss weighting, and test seen/unseen targets and supervised/unsupervised refinement. This illustrates how adaptation and generalization claims can be separated experimentally. [Institutional record](https://discovery.ucl.ac.uk/id/eprint/10032237/), [primary article](https://pmc.ncbi.nlm.nih.gov/articles/PMC6051485/)

## 3DSAM-adapter

**Publication:** 3DSAM-adapter: Holistic adaptation of SAM from 2D to 3D for promptable tumor segmentation, Medical Image Analysis, 98, article 103324, December 2024; DOI 10.1016/j.media.2024.103324. **Access:** publisher abstract/metadata and full author manuscript arXiv v2 read. Publisher metadata resolve an inconsistent article number in the arXiv journal-reference field.

Encoder conversion, visual prompt sampling, and decoder aggregation support parameter-efficient volumetric adaptation. Four tumor tasks, alternative adapters and full fine-tuning, component removals, and prompt-location tests assess the combined claim. The evidence connects the architectural adaptation to its intended volumetric behavior. [Publisher](https://www.sciencedirect.com/science/article/pii/S1361841524002494), [author manuscript](https://arxiv.org/html/2306.13465v2)

## Application to the selected paper

The provisional claim is:

> Learning whether the prompted target continues beyond the current crop can guide native-resolution segmentation, recovering thin or elongated anatomy with fewer corrections and controlled spillover at a matched inference budget.

The connected mechanism is crop-boundary ambiguity, followed by premature stopping or inappropriate expansion, lost detail, and repeated corrections. A prompt-conditioned boundary predictor, selective continuation into neighboring native-resolution crops, and consistent overlap fusion therefore belong to the same method. Fusion may be an established implementation choice; its role can be measured without asserting separate novelty.

## Evidence progression

| Scientific question | Supporting experiment |
|---|---|
| How often does crop handling contribute to baseline error? | Audited development trajectories with failure prevalence and physical geometry strata. |
| Can the model distinguish artificial truncation, true endpoints, and spillover? | Held-out boundary-state prediction and calibration, including changed positive/negative prompts. |
| Does this distinction improve the target mask? | Recovery of coverage and thin detail, false-connection measurements, and oracle continuation at a fixed patch budget. |
| Which components cause the improvement? | Boundary supervision, prompt conditioning, routing, and fusion ablations with matched data and resources. |
| Is improvement attributable to model training? | Frozen-engine routing experiment, same-data segmentation fine-tuning, tuned heuristics, larger-crop/tiling, and closest learned-routing comparisons. |
| Does the effect transfer? | External patient/source evaluation, a second suitable thin target, and stratification by contrast, anisotropy, orientation, and branching. |
| Does the complete annotation workflow improve? | Quality versus correction budget and latency, followed by expert time to adjudicated acceptable masks. |

The manuscript can follow this chain: observed crop-boundary failure → boundary-state formulation → native-resolution continuation model → controlled comparisons → external robustness → annotation effort and limitations. Each result should clarify the strength and scope of the same central hypothesis.
