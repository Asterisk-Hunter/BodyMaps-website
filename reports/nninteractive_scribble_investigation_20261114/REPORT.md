# nnInteractive scribble investigation

Date: 2026-11-14  
Scope: local code inspection, synthetic regression tests, and the supplied recording. No production server, site, or model service was accessed or changed.

## A. What is happening in the recording

The recording shows case 8854 with Aorta selected and 28/28 initial meshes loaded. A positive scribble is submitted around 00:35 on axial slice 287/918. A negative scribble is submitted around 02:00 on axial slice 305/918; the UI reports “Scribble — segmenting…”. Around 02:20, the visible axial and coronal red overlay has changed substantially or disappeared in the viewed region, while the 3D aorta still resembles the original red mesh.

The recording does not expose the raw request, voxel coordinates, model response, or segmentation voxel counts. The visible change alone cannot establish whether the model removed too much, a prompt was misplaced, or the displayed region changed for another reason.

## B. Model behavior and runtime identity

The application uses a remote nnInteractive model service. The backend default is `http://127.0.0.1:1527`; the repository README documents a separate server started with `nninteractive-server --model nnInteractive_v1.0 --device cuda --no-torch-compile`. The Python package installed in this local workstation environment is `nnInteractive 2.6.0`. That package version is not proof of the version running in the remote service.

The local capability request to `127.0.0.1:1527/capabilities` failed because the port was not listening. Docker was also unavailable because the Docker Desktop Linux engine pipe did not exist. The case 8854 CT, its current Aorta mask, the remote service's checkpoint ID, and capability metadata were not available locally. Therefore the recording's positive-only, negative-only, sequential, and three-view model replays were not run. No raw model outputs or model-quality conclusion are claimed.

The installed API source exposes point, bounding-box, lasso, and scribble interactions. `add_scribble_interaction` accepts a binary mask, `include_interaction`, and optional `interaction_bbox`; the method resolves positive and negative channels and forwards the mask to the selected channel. The application capability route maps the remote server's `supported_interactions`, version, license, initial-label/refinement support, and undo support into `/api/interactive-capabilities`; that endpoint could not be queried here.

## C. Data and prompt path

```text
Viewer CT and active labelmap
  -> useInteractivePromptTool: canvasPointToWorld / world point
  -> buildScribbleCroppedMask: worldToIndex, pane-axis mapping, binary 2D crop + half-open IJK bbox
  -> submitInteractiveSegmentPrompt: is_positive, mask, bbox, active label seed, session token
  -> Flask /api/interactive-segment/<case_id>: decode prompt and optional baseline
  -> nninteractive_predictor.predict: reuse or create per-case/label/resolution remote session
  -> _NNSession.add_interaction -> _add_scribble -> nnInteractive add_scribble_interaction
  -> returned full target mask; backend connected-component post-process; NIfTI response
  -> frontend validates and applies the returned full mask to the active label
  -> Cornerstone segmentation-modified event refreshes 2D MPR and edit listeners
  -> 3D pane uses baked GLB until an edit is registered, then live surface extraction
```

Relevant paths and functions:

| Stage | File and function | Finding |
|---|---|---|
| Tool polarity | `PanTS-Demo/src/routes/VisualizationPage.tsx`, `effectiveAiNegative` and `useInteractivePromptTool` setup | Remove is represented as `includeInteraction: false`; Shift reverses the selected polarity. |
| Screen/world prompt | `PanTS-Demo/src/helpers/viewer/useInteractivePromptTool.ts`, `submit`, `confirm`, `handleClick` | Canvas points become world points; freehand prompt masks are built at confirmation. Alt is passed as the polarity inversion flag. |
| Scribble rasterization | `PanTS-Demo/src/helpers/CornerstoneNifti2.tsx`, `buildScribbleCroppedMask` | `worldToIndex` returns IJK. Axial projects to `[i,j]`, sagittal to `[j,k]`, coronal to `[i,k]`; the crop bbox is half-open and spans one slice. Radius defaults to 2 voxels. |
| Request + full mask application | `PanTS-Demo/src/helpers/CornerstoneNifti2.tsx`, `submitInteractiveSegmentPrompt` | Serializes the polarity, mask/bbox, current active-label seed and session token; validates the returned NIfTI; applies the returned full target mask only to the active label and does not overwrite other labels. |
| Request decode and geometry | `flask-server/api/api_blueprint.py`, `/interactive-segment/<case_id>`; `flask-server/services/advanced_analysis.py`, `lps_to_ijk`, `_decode_mask_payload` | LPS point conversion negates x/y to RAS before inverse-affine mapping. Cropped raw masks decode in Fortran order, matching the viewer's axis-0-fastest byte layout. Low-resolution requests with cropped strokes stay on the same voxel grid rather than being silently switched to full resolution. |
| Session and polarity | `flask-server/services/nninteractive_predictor.py`, `_NNSession.add_interaction`, `_add_scribble`, `predict` | `is_positive` is forwarded unchanged as `include_interaction`. First-request baselines are set on the target buffer and supplied via `add_initial_seg_interaction`; later interactions reuse the stateful session. Explicit reset clears history and optionally reinjects a baseline. |
| Model output filtering | `flask-server/api/api_blueprint.py`, post-prediction connected-component block | Keeps only the largest connected component when the returned prediction has multiple components. This could remove disconnected predicted regions; whether it affected this recording is unknown. |
| 2D rendering | `PanTS-Demo/src/helpers/CornerstoneNifti2.tsx`, `submitInteractiveSegmentPrompt` and `_notifySegmentationChanged` | Accepted full-mask changes update the Cornerstone labelmap, trigger a segmentation-modified event, and rerender viewports. Empty predictions and reductions below 10% of an existing mask larger than 500 voxels are rejected; other large reductions are allowed. |
| 3D rendering | `PanTS-Demo/src/components/viewer/MeshViewer.tsx`, `LiveSegmentMesh.tsx`; `CornerstoneNifti2.tsx`, `extractSegmentSurface` | Before this local change, edited catalog organs continued to use their baked GLB, so the 3D surface could stay unchanged while 2D showed the edited labelmap. This was an explicit behavior in the old renderer. |

The initial mask enters on the first prompt as a binary seed made from the active labelmap. If the remote session is new/empty, the backend pads the seed if needed, sets it as target buffer, and adds it as nnInteractive's initial-label interaction. The backend then reuses the per-session target buffer; it does not reset between ordinary positive/negative prompts. Explicit reset is a distinct action. The separate one-shot “AI refine” call resets and injects the current mask for that isolated operation.

For a negative scribble, the frontend does not erase just the scribbled voxels. nnInteractive receives a negative guidance-channel mask and returns a revised full target mask. The viewer then applies that complete returned mask. A negative interaction can therefore cause broad changes by design; it is not a local subtraction contract.

## D. Tests and observed results

Added a backend regression case that sends both positive and negative cropped lasso/scribble payloads through the Flask route and verifies that mask bytes, bbox, and polarity arrive unchanged at the predictor. Added a focused fake-session check that `is_positive=False` reaches `add_scribble_interaction(... include_interaction=False)` with the same crop and bbox.

Updated the mesh-pane tests to verify that an edited baked organ switches to a live surface after it has loaded, and that a newer settled mask revision is passed to the live surface. The existing debounce hook now increments the surface revision after edits settle while preserving the edited-ID list identity when membership is unchanged.

Verification run:

- `npm test -- src/test/meshViewerPane.test.tsx src/helpers/viewer/useEditedCatalogIds.test.ts` — 12 tests passed.
- `python -m pytest tests/unit/test_interactive_session_ownership.py -q` — 18 tests passed.
- The first UI run caught and fixed a loading-state issue for edited baked meshes; the rerun passed.
- No test invoked a real model, real CT, GPU, or production endpoint.

## E. Root-cause assessment

| Observation | Finding | Confidence |
|---|---|---|
| 3D mesh remains nearly unchanged after edits shown in 2D | Confirmed stale-view behavior: baked catalog GLBs were deliberately kept static after edits. Local code now switches an edited organ to a live marching-cubes surface after edits settle. | High for code path; actual case 8854 visual replay remains pending. |
| Negative interaction polarity | No polarity inversion was found in the traced frontend-to-backend path. Code and fake-session tests show `false` reaches nnInteractive's negative channel. | High for mapping; not evidence that the model response is good. |
| Scribble crop layout | The frontend axis projection, half-open bbox, and backend Fortran-order decode are consistent by inspection; the existing and extended synthetic route tests preserve crop contents and bbox. | Moderate; no known-voxel UI-to-model replay was possible. |
| Large 2D removal after negative scribble | Unresolved. It may be the model's full-mask response, a prompt-location issue, post-processing of disconnected components, or another runtime/data issue. No direct output was captured. | Unknown. |
| nnInteractive model defect | Not established. | No direct model evidence. |

## F. Local fix

The confirmed 2D/3D revision mismatch is fixed locally: catalog organs use the baked mesh for initial loading, then switch to a surface generated from the current labelmap after a 400 ms edit-settle interval. The new `maskRevision` triggers extraction only after edits settle rather than on each brush event. Unedited catalog organs retain the pre-baked GLB path. This change has focused unit coverage but still needs a local browser check on the recording's scan before it can be considered visually verified.

No inference weights, model implementation, prompt math, or production service was changed.

## G. Regression coverage and remaining direct checks

Covered locally: positive/negative payload polarity preservation, crop bytes and bbox through the API route, negative-channel forwarding in a fake nnInteractive session, edited-mesh revision propagation, and edit debounce/list behavior.

Not yet proven: an exact UI world-to-voxel round trip in axial/coronal/sagittal views; a real positive-only, negative-only, and sequential model replay from the same initial Aorta mask; raw model versus returned NIfTI versus applied labelmap comparison; 2D/3D mask-hash equality on the actual scan; async behavior under a real model service. The model endpoint, checkpoint and scan were unavailable, so these cannot honestly be marked passed.

## H. Direct answers

1. **Is nnInteractive itself behaving incorrectly?** Unknown; direct inference was unavailable.
2. **Is our wiring incorrect?** Polarity and mask/bbox transport look consistent and are regression-tested. The 3D stale-mesh path was incorrect for displaying the current edited mask and is fixed locally.
3. **Is negative polarity passed correctly?** Yes in the inspected code path and synthetic regression tests; real service behavior was not exercised.
4. **Are coordinates correct?** The transformations are internally consistent by inspection, but a prompt-to-known-voxel end-to-end test is still required, especially for orthogonal views and oblique images.
5. **Is the initial mask handled correctly?** Code supplies the active label as an initial-label target on session creation/empty-session recovery, then retains the stateful session. The case-specific runtime state could not be checked.
6. **Why does the negative scribble cause the observed removal?** Not proven. The system asks the model for a revised full mask; it does not perform local voxel deletion. A broad reduction is therefore possible, but the exact cause in this recording is unverified.
7. **Why does the 3D mesh remain unchanged?** Because the old viewer deliberately kept rendering the original baked GLB after an organ was edited. Local code now rebuilds an edited organ's live surface after edits settle.
8. **What code changed?** `LiveSegmentMesh.tsx`, `MeshViewer.tsx`, `useEditedCatalogIds.ts`, and `VisualizationPage.tsx`; no model or production change.
9. **What proves the fix?** The 11 focused frontend tests and 18 focused backend tests pass. They prove the local state/event logic and polarity transport, not the unavailable real-model behavior; a browser replay on case 8854 remains necessary.
