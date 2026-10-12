# Optional CT reconstruction and organ refinement

The workspace can request a real server pipeline: optional OpenVAE reconstruction, a supported segmentation model, optional ShapeKit organ refinement, then result packaging. View-only mode remains local to the browser and runs none of these server stages.

The supported segmentation models for optional stages are **ePAI, Atlas-Net, and LesionSegmenter**. Other existing model endpoints do not imply that their native labels are compatible with ShapeKit. In particular, the current MedIA vertebral label scheme is outside this pipeline's allowlist.

## Explicit preview-only presentation

The frontend supports two independent build-time flags, both **off by default**:

```dotenv
VITE_OPENVAE_UI_PREVIEW=true
VITE_SHAPEKIT_UI_PREVIEW=true
```

Set these only for an approved preview release, then rebuild the frontend. They work in development and production; changing a backend environment file alone does not change a built frontend. A flag set to `true` makes that optional choice a visible **Preview only** selection, even when its server runtime is unavailable. The stage is omitted from the actual inference request. It never reconstructs CT, refines masks, or consumes an additional stage entitlement. The chosen segmentation model still requires its normal authentication, plan access and real inference service.

Progress cards show previewed stages as **Not run**, including after the real segmentation completes, fails or is cancelled. Each preview has a two-second frontend animation explicitly labelled **Preview animation. No processing applied.** Its percentage describes the visual animation only, never model execution. The preprocessing animation starts while the real run is active; the postprocessing animation starts after the card observes a real successful result. The real model request, server status, history and result access are never delayed by an animation. Completed history opened after a reload uses a still frame without replay; cancellation, failure and unmount stop timers, and reduced-motion preferences skip animation.

The account's browser history keeps `preprocessingPreview` and/or `postprocessingPreview` alongside a pipeline whose corresponding real stage is null; these presentation markers are not sent to the server. A resumed job retains its original real pipeline regardless of later flag changes. Downloaded masks and archives contain only the actual server output and provenance, with no preview transformation. With both previews selected, segmentation uses the original CT and no ShapeKit refinement is applied.

Leave each flag unset or `false` to use the ordinary capability-checked stage. Enabling a **real** stage still requires its verified runtime, dependencies, compatible labels and isolated GPU validation described below. Preview flags do not validate those adapters or enable missing model installations.

## What the stages mean

| Stage | Input and result | Scope |
| --- | --- | --- |
| OpenVAE | Original CT to a separately stored reconstructed CT | The actual JHU inference script clips CT intensities to **[-1000, 1000] HU** during reconstruction. Reconstruction is not a demonstrated clinical quality improvement and may change image intensities. |
| Segmentation | Original CT, or reconstructed CT when OpenVAE was selected, to viewer-space labels | The chosen segmentation model determines the labels. Missing detections do not establish that an organ is healthy. |
| ShapeKit | Compatible segmentation to refined whole-organ masks | Refines supported organs only. Lesions and other unsupported labels are preserved; LesionSegmenter pancreas subregions are not silently merged into a whole-pancreas mask. |
| Packaging | Validated final labels and explicit provenance to the result archive | The job becomes completed only after its selected stages and packaging succeed. |

The original uploaded CT is retained unchanged. The viewer continues to use it as its CT reference, preserving the original attenuation values. A reconstructed CT is stored separately and served only through the owner-protected reconstruction endpoint. Pipeline metadata records `segmentation_input` as `original` or `reconstruction` and `viewer_reference` as `original`.

Reconstruction and masks must match the original CT dimensions and affine and contain finite values. Segmentation labels must be valid integers in the supported viewer scheme. The pipeline rejects incompatible geometry rather than relabelling a shifted image as successful.

## Install the actual OpenVAE checkpoint

OpenVAE requires its own source/runtime and the actual checkpoint. A missing checkpoint is an unavailable stage; the adapter does **not** substitute MAISI or another model.

The official repository is **gated**: its public listing does not grant checkpoint download access. An unauthenticated JHU download returned HTTP 401. The account owner must sign in on the repository page, personally review/accept its terms or request access as required, and use a read token from an account with approved access. The helper does not accept terms, request access, create tokens, or inspect cached credentials.

The download helper pins this official artifact:

| Field | Pinned value |
| --- | --- |
| Repository | [SMILE-project/OpenVAE](https://huggingface.co/SMILE-project/OpenVAE) |
| Revision | `d0cb74be63bcc4d59ea56e01dacbbdff0ec11e6d` |
| File | `OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt` |
| Size | `83,831,747` bytes, approximately **80 MiB** |
| SHA-256 | `4d93e824397797fc6458ace25c9a08cad8ab3ca53e2a890ba357c3e62632adcb` |

From `flask-server`, run the helper explicitly under the account that will own the checkpoint, choosing the destination file:

```bash
python scripts/fetch_openvae_checkpoint.py \
  --destination "$HOME/openvae/ckpt/OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt"
```

For gated access, supply the standard `HF_TOKEN` environment variable in the invoking shell. A Bash prompt keeps the token value out of shell history and process arguments:

```bash
read -r -s -p 'Approved Hugging Face read token: ' HF_TOKEN
printf '\n'
export HF_TOKEN
python scripts/fetch_openvae_checkpoint.py \
  --destination /absolute/path/to/approved-review/weights/autoencoder_best.pt
unset HF_TOKEN
```

Use the account's narrowly scoped read access, and do not paste the token into project files, deployment `.env`, chat, or command arguments. See Hugging Face's [user access-token documentation](https://huggingface.co/docs/hub/security-tokens) and [gated-model access guidance](https://huggingface.co/docs/hub/models-gated). The helper intentionally reads only `HF_TOKEN`; a previous `hf auth login` alone does not make its cached token available to this helper. No Hugging Face client dependency is required.

Authorization is sent only to the exact HTTPS `huggingface.co` origin (default port or 443). Redirects to signed CDN/other-host URLs remove the header; insecure HTTP redirects are refused. HTTP 401/403 errors show access instructions without printing response bodies or tokens. Authentication does not relax revision, size, SHA-256, or no-overwrite checks.

The helper streams to its own temporary file beside the destination, checks the exact size and SHA-256, then publishes the complete file with an atomic hard link. A matching existing checkpoint is accepted without a network request. A mismatching existing file, a directory, or a symbolic link is never overwritten. If another process creates a different destination during download, that file is preserved and the command fails. A filesystem without hard-link support fails safely; there is no overwrite fallback. Failed or interrupted downloads remove only the helper's own temporary file.

This command downloads a file only. It does not load the checkpoint, edit configuration, install packages, run GPU inference, or restart services. Configure the approved runtime separately:

| Setting | Meaning |
| --- | --- |
| `OPENVAE_SRC_PATH` | OpenVAE source directory containing `test/test_3dvae.py` |
| `OPENVAE_CHECKPOINT_PATH` | Absolute path of the verified `autoencoder_best.pt` |
| `CONDA_ENV_OPENVAE` | Existing OpenVAE environment name, default `openvae` |
| `SHAPEKIT_SRC_PATH` | ShapeKit source directory containing `main.py` |
| `CONDA_ENV_SHAPEKIT` | Existing ShapeKit environment name, default `shapekit` |
| `SHAPEKIT_CPU_NUM` | ShapeKit worker setting, default `16`; size for the approved server |

The server capability check verifies local source, checkpoint, and runtime availability. It is a preflight check, not proof of a successful GPU run or segmentation accuracy.

## Server state, ownership, and artifacts

Requests use the existing authenticated inference endpoint with `preprocessing` set to `OpenVAE` or empty, and `postprocessing` set to `ShapeKit` or empty. The server validates supported model combinations, stage availability, ownership, and account access. Client-supplied filesystem paths remain rejected. An accepted pipeline counts as one scan; its internal stages are not independently charged as additional scans.

The durable job stores the pipeline selection and actual stage transitions. Stage IDs are `preprocessing`, `segmentation`, `postprocessing`, and `packaging`; unselected optional stages are omitted and can be shown as “Skipped” from the explicit selection. Legacy jobs with no pipeline metadata do not prove that an optional stage ran. The UI uses measured upload transfer and real server state, not timer-generated model percentages.

Each attempt uses separate stage directories below `pipeline/<unique-attempt>/`. The raw segmentation is retained. When ShapeKit is selected, the final output contains:

```text
combined_labels.nii.gz              final refined viewer labels
pipeline.json                      selected stages and provenance
segmentation_original/
  combined_labels.nii.gz            model output before refinement
  output.csv                       raw model measurements, when produced
```

`pipeline.json` identifies raw measurements as `segmentation_original` when refinement was selected. A pre-refinement CSV must not be presented as measurements of the refined final mask. Without refinement, an existing model-produced CSV describes its unrefined segmentation; not every model produces a CSV. The reconstructed CT is separate from this mask archive.

The final output directory is published only after the selected pipeline and archive succeed. Both the segmentation endpoint and session meshes use that final output. Failed or cancelled pipelines must retain their terminal state and must not offer a partial result as a completed pipeline. Cancellation applies to the same owned session throughout all selected stages.

## Verification before release

Local mocked tests cover the orchestration and download helper, including corrupt/truncated downloads, no-clobber publication races, and cleanup. They do not download weights or validate the GPU models.

`flask-server/scripts/verify_processing_pipeline.py` supports a standalone review without importing Flask, loading deployment `.env`, changing a database, or restarting services. Supply an existing approved NIfTI, a **new** output directory beneath an existing isolated parent, explicit model source/checkpoint/runtime environment variables, and a supported model. Without `--execute`, it only reports dependency availability and creates no output directory:

```bash
python scripts/verify_processing_pipeline.py \
  --input /absolute/path/to/approved-review-ct.nii.gz \
  --output /absolute/path/to/isolated-runs/new-review-001 \
  --model ePAI --preprocessing OpenVAE --postprocessing ShapeKit
```

Add `--execute` only for an explicitly approved compute run. The verifier forces local inference, redirects temporary/cache/nnU-Net scratch files to its run directory, copies the input before inference, records actual stage timings, checks original hashes and geometry, verifies protected labels after ShapeKit, and packages real provenance before marking completion. Its `review.json` records failure or signal cancellation as terminal states. Existing output directories are refused, and cancellation targets its own session only. This filesystem isolation does not reserve GPU resources against production work: use an agreed quiet window and monitor the deployed health endpoint and active jobs. No inference or accuracy claim follows from a successful preflight.

Before enabling these stages in a release, run an **isolated GPU integration test** using an approved CT and separate test sessions/storage. Exercise each advertised model and enabled stage combination. Confirm the original CT bytes remain unchanged, reconstruction and masks retain the original geometry, protected labels survive refinement, the viewer and archive use the same final mask, and raw measurements remain labelled as provenance. Also verify cancel/failure, retry, unavailable dependencies, ownership denial, restart/history recovery, and the stage display in the approved Chrome profile.

Record checkpoint identity, model/runtime versions, selected stages, outcomes, and measured timings. Successful execution alone does not establish improved accuracy, clinical validity, or a quantified speedup. Complete the required local design review before any production deployment.
