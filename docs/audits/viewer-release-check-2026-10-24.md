# Viewer follow-up verification — 24 October 2026

Scope: the CT viewer and the API paths it uses for editing, saving, reopening and displaying masks/meshes. This supersedes the viewer findings in the earlier audit snapshot. The separate AI assistant/model picker and site statistics are outside this change. No deployment, hosting changes, push or commit was performed.

## Confirmed repairs

- Local CTs, masks, saved edits, backups, generated meshes, runtime sessions, archives, logs, environment files and caches are ignored. No tracked NIfTI, NPY/NPZ, DICOM, database or ZIP files were found. No user data was deleted.
- Catalog saved masks and generated meshes are isolated by authenticated user. Uploaded sessions retain their existing ownership checks. Legacy local-development edits remain readable in the explicitly enabled local development session; source dataset masks remain immutable.
- Labelmap saves validate numeric byte values, payload length, bounded gzip and case geometry; coarse saves preserve unchanged full-resolution detail. Atomic replacement prevents partial file writes.
- Saves carry the loaded revision and a captured account identity. A stale tab receives HTTP 409; an account change cannot redirect a delayed save into the newly signed-in user's annotation directory. The revision check and replacement share a thread/process lock, including equivalent numeric case IDs.
- Custom names and RGBA colours are validated and embedded in the same atomically written NIfTI as their voxels. They are restored into the picker and rendering colours on reopen. HTTP metadata supports international names. Label IDs above the byte range are rejected.
- Quiz, solo and live-room masks cannot be persisted through the normal personal-case save callback. Quiz practice does not expose the normal Save button.
- Delayed model operations are tied to the loaded viewer generation. Case/resolution changes and cancellation invalidate pending work before it can modify a replacement volume.
- HD labelmaps are staged under a new cache ID; the original remains owned until attachment succeeds. Failure-injection transaction tests cover loading failure, partial attachment failure, successful retirement and failed restoration. CT modality tagging, CT/MR preset changes, case-scoped undo history and centroid invalidation were repaired.
- Viewer toolbar/flyout timers, axial keyboard stepping, slice input semantics, structure controls, organ-panel accessibility, compare-view HD carry-over and 3D retries/focus were reconciled with the current interface. The full built-in editing class picker remains available after reopening.

## Verification

| Check | Result |
| --- | --- |
| Access policy, ownership, CT cache concurrency, save payload/geometry, masks, caches, meshes and path safety | 234 passed |
| Complete frontend test run | 1,509 passed; 10 failed across 3 files |
| Remaining failed files | `aiModels.test.tsx` (2), `aiSidebar.test.tsx` (4), `statisticsPage.test.tsx` (4); outside viewer scope |
| Latest owner-bound save and quiz save guard regressions | Viewer smoke suite: 10 passed |
| Mesh loading/recovery and visible-bounds tests | 15 passed |
| Save metadata/payload and HD transaction regressions, with viewer smoke at that point | 24 passed |
| Scoped viewer ESLint | 0 errors; 319 warnings |
| Final TypeScript and production frontend build | Passed; codec externalization and large-chunk warnings remain |
| Whitespace check | Passed |

The complete run includes other passing site tests; 1,509 is not a count of viewer-only tests. Focused counts overlap the complete run and must not be added together. Raw logs are retained under ignored `local/audit-20261024/`.

## Boundaries of the evidence

- Backend regressions use synthetic temporary volumes and Flask clients on Windows. They do not certify a deployed Linux filesystem, reverse proxy, production database, real concurrent users or GPU service.
- HD transaction failure tests exercise the transaction callbacks. They do not establish recovery from every possible WebGL/Cornerstone failure in a real browser.
- No long browser memory soak, cross-browser matrix or large-volume stress test was performed in this follow-up.
- The earlier dependency scan still needs compatible, reachable-advisory triage. No imaging-stack downgrade or automatic dependency upgrade was applied. The complete website suite is not green and this report does not certify the whole site.
- Existing shared production edits were not deleted or automatically assigned to users. Their ownership needs to be resolved explicitly if such files exist before adopting the new personal storage layout.
- The newly added metadata endpoint returns 404 for datasets outside the existing numeric-PanTS/uploaded-session save backend, allowing their ordinary viewer to load. This change does not add new dataset-specific annotation persistence support.

The verified claim is that the named viewer regressions pass locally. It is not a zero-defect or production-installation guarantee.
