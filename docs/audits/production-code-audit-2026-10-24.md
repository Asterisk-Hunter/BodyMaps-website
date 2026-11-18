# Production code audit — 24 October 2026

Follow-up: viewer-specific fixes and newer verification are recorded in [viewer-release-check-2026-10-24.md](viewer-release-check-2026-10-24.md). Findings below describe the earlier audit snapshot; they are not the latest viewer status.

**Disposition: HOLD the production release.** Confirmed remaining defects and failing release checks are listed below. Passing focused tests do not establish that the whole application is correct.

## Scope and environment

- Repository: BodyMaps-website, branch `website-work`, base commit `8fb951fb`, including the existing uncommitted viewer changes and this audit's fixes.
- Read the root and frontend READMEs, website access policy, CI workflow, release procedure, and relevant application/server code. The documented production application uses Linux, Python 3.11, Gunicorn gthread, an external model service and configurable dataset/storage paths.
- Executed locally on Windows, Node 22.16.0 and Python 3.13.5. Backend checks use synthetic masks, temporary databases and Flask test clients; they do not use a production service or GPU.
- No hosting configuration, infrastructure, production service, deployment, remote data, Git push or commit was changed. BodyMaps-research code was not changed.
- This is a code audit with scoped regressions, not a certification of a running Linux/PostgreSQL/proxy/model-server installation. Actual filesystem permissions, proxy behaviour and external services remain unverified.

## Remaining findings

### R1 — High: catalog annotations are shared between accounts

`flask-server/api/api_blueprint.py::_pants_edited_mask_path` still selects one `edits/PanTS_<case>/combined_labels.nii.gz` per catalog case. `_pants_viewer_mask_path` prefers that mask for every account; `save_segmentation` writes it without an account namespace. Catalog mesh caches are also case-scoped.

**Reproduced:** synthetic account A saved a catalog mask, account B saved different labels for the same case, and the next read returned B's labels from the same destination. Atomic replacement prevents partial files, but does not prevent overwriting another editor's work or stale concurrent saves.

Original source masks remain separate; the shared saved overlay still changes what other users see. The uploaded-session ownership fix below does not resolve catalog ownership.

**Required before release:** define and enforce personal versus explicitly shared editing, apply that ownership to mask reads, writes, model baselines, reports and meshes, and reject stale conflicting saves. This audit does not silently choose a new storage/permission model.

### R2 — High: the complete frontend test suite is failing

The broader post-hardening run produced **29 failed / 160 passed test files; 112 failed / 1,394 passed tests** (1,506 tests). A later unmount-cancellation regression was added and passed in the focused run; the complete suite was not repeated after that final small change.

Examples include a missing `RefineFlyout` import, missing helper exports, mask history, live mesh events, organ grouping, model tools, flyout behaviour, comparisons and statistics. Several assertions target intentionally changed interfaces, but the failures have not all been classified as obsolete tests versus application defects. They cannot be dismissed as harmless or baseline failures without evidence.

`production-code-audit-2026-10-24.json` contains every failing test-file name. Full failure messages are retained locally in `local/audit-20261024/frontend-tests-final.log`.

**Required before release:** reconcile current behaviour and tests, investigate the runtime failures and obtain a trustworthy release suite. Do not delete or weaken assertions simply to make it green.

### R3 — Medium: custom structure metadata does not survive save/reopen

`CornerstoneNifti2.tsx::getCustomSegmentLabelsForExport` provides class metadata, but `saveSegmentation` sends only voxel labels and geometry. The backend stores a NIfTI labelmap without custom names/colours, and viewer initialization seeds the built-in class catalog.

Custom numeric voxel values may survive while their names/colours and picker entries do not. Keeping all built-in classes selectable fixes the original picker problem, but does not make custom metadata durable.

**Required:** persist and restore validated custom metadata with the corresponding saved mask and ownership. This is a confirmed code-path gap; a new live custom-class round trip was not executed in this audit.

### R4 — Dependency findings need triage

`npm audit --omit=dev --json` reported **20 package findings: 10 high, 9 moderate, 1 low, 0 critical**. The all-dependency scan reported 24. The package list is in the JSON companion; raw advisories and dependency paths are retained locally.

These are registry advisory matches, not proof that every finding is reachable in the deployed browser application. Some nominal production dependencies include build tooling. No automated downgrade or dependency upgrade was applied to the imaging stack. Advisory reachability and compatible remedies remain unreviewed.

The shared local Python installation also fails `pip check` due to Gradio/Streamlit/OpenTelemetry version conflicts. This is not proof that the production virtual environment has those conflicts; a clean installation of the documented requirements on Python 3.11 was not performed.

## Confirmed fixes made during this audit

| Fault | Change | Evidence |
| --- | --- | --- |
| A signed-in account could save another account's uploaded UUID mask | Require existing job ownership before resolving or writing that mask | Foreign owner is denied without changing the file; owner succeeds |
| Catalog model interaction histories were shared between accounts | Include authenticated account ID in prompt and undo/sync model-session keys | Distinct accounts obtain distinct session scopes |
| UUID prompt/sync could reach another account's model state | Apply upload ownership checks before taking model slots or loading volumes | Foreign-owner prompt and sync are denied before model calls |
| A CT cache could publish one case's key with another case's image/array under gthread | Publish and read one immutable `(key, image, array)` tuple | Deterministic interleaving regression failed before the fix and passes now |
| Queued or delayed prompts could act after a case/resolution change or viewer unmount | Invalidate hook queue generations, abort active work, bind model proposals to an exact viewer generation/volume, check before merge | Case switch, resolution switch, unmount, explicit cancellation and same-shape replacement regressions |
| HD mask image IDs were not tracked for disposal | Claim upgraded images and release replaced low-resolution images through the viewer context | Typecheck/build and code review; no quantitative browser memory soak was performed |
| A foreign but syntactically valid geometry could resample a mask out of the case and overwrite it with zeros | Require an equivalent case grid, allowing valid stack flips/permutations | Out-of-grid payload is rejected; reversed slices and axis permutations remain supported |
| Gzip payloads were expanded without a grid-sized output limit | Bound compressed reads and decoded bytes to a verified grid; reject malformed/truncated gzip and invalid deflate data | Expansion, malformed header, CRC/truncation and deflate regressions |
| Corrupt gzip could be reinterpreted as raw labels and saved | Remove that fallback for gzip-shaped input | A corrupt request with the same byte count as the reference is rejected without writing |
| Saving a coarse mask could erase fine structures absent from the preview | Compare with the original preview and merge only changed coarse voxels onto the full-resolution master | An untouched one-voxel structure survives while a separate edit is saved; returned count matches the persisted master |
| Model setup instructions selected a different server version from the pinned client | Align README server pin to 2.5.1 | README and requirements agree; no package/service installation was performed |

Earlier save fixes remain included: numeric one-byte scalar snapshots, X-fastest voxel order, live LPS geometry, save request timeout, mutable-mask caching, Windows open-download replacement, safe success logging and built-in picker availability. Their regressions remain in the focused suite.

Three test-fixture corrections were also made: path assertions now work on Windows and Linux; the local-auto-signin test actually uses a loopback client; the guest-upload test uses temporary storage rather than failing because an old fixture exists in a working directory. The security restrictions themselves were not weakened.

## Verification results

| Check | Observed result |
| --- | --- |
| Access policy, upload ownership, payload/geometry, CT concurrency, mask save/reload, cache, meshes, path safety | 226 passed |
| Auth endpoint suite, separate process | 75 passed |
| Guest gating suite, separate process | 12 passed |
| Focused frontend payload/save/viewer/request-target/hook regressions | 23 passed |
| Full frontend run, bounded to two workers | 112 failed / 1,394 passed; 29 failed files |
| Production frontend build and TypeScript build | Passed, with existing codec externalization and large-chunk warnings |
| Full ESLint run | 9 errors / 408 warnings; not green |
| `git diff --check` | Passed |
| One-process aggregate backend attempt | Incomplete: stopped after stalling around 69% for more than 13 minutes, with failures; not a successful full backend run |

The CI workflow deliberately runs several backend modules in separate processes because they reload global application/DB state. The aggregate attempt also exposed local-auth environment and working-directory fixture interference. The isolated results above establish only the named coverage, not that every backend test passes. Generated synthetic test state was retained under `local/audit-20261024/`; original case data was not used for destructive checks.

## Limits of this review

- No live production authentication, PostgreSQL, actual Linux file ownership/locking, proxy/X-Accel delivery, concurrent real users, GPU inference or model-server protocol round trip was executed.
- No failure-injection test establishes complete rollback of a failed HD mask replacement. Its implementation still deserves that coverage before claiming recovery from every download/render failure.
- No long browser memory soak, mobile/cross-browser matrix or large-volume concurrent load benchmark was run.
- No existing production annotations were migrated or repaired. Any catalog edit isolation change will need explicit preservation of existing saved work.
- No zero-defect guarantee is made. R1–R4 and the failed checks prevent an unconditional production-readiness sign-off.

Local evidence: `local/audit-20261024/` (raw logs and synthetic repros, not committed). The JSON companion retains a small shareable summary without scans, masks, credentials or images.
