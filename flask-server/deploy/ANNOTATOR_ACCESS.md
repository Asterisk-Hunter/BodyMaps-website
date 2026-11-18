# Annotator access: saving corrections for everyone

A dataset scan (PanTS, CancerVerse, AbdomenAtlas) has **one version for everybody**. Nobody keeps a private copy of
it on the server. Approved people (annotators) can fix a scan's segmentation and save it with **Save to JHU server**
(viewer toolbar, above **Save to computer**, shown only to them). From then on every visitor gets the corrected
mask: the 2D masks, the 3D meshes, the organ statistics and PDAC staging all follow it. Everyone else sees only
**Save to computer**, which downloads their edit as a NIfTI file.

## Who is approved

The `annotator` role allows project participation and shared-mask editing. Project creators manage only
projects they created, and case assignees edit only their own assigned drafts. There is no global
`annotation_manager` permission. Legacy rows with that role grant no access and can be removed by an admin.

An admin may grant or revoke annotator access in People settings. An annotator may also issue a one-time
invite code from the annotation-project workspace.

1. **A temporary code.** Annotation projects > *Invite team* > pick how long it works (1 hour, 1 day, 7 days) >
   **Create code**. The code (`XXXX-XXXX-XXXX`) is shown once; give it to the person. They enter it under
   Settings > Team access > *Invitation code*. A code works **once** and then expires, can be withdrawn from the same
   list, and the list shows who used each one. Only a SHA-256 digest is stored.
2. **By email.** Settings > People > search the person > Edit > **Make annotator** (or **Remove annotator**).

## Where the corrected version lives

Under the viewer label cache (`PANTS_VIEWER_LABEL_CACHE_PATH`, default `<PERMISSIONS_DIR>/pants_viewer_labels`):

| What | Path |
| --- | --- |
| shared mask | `edits/shared/<PanTS_########, CV_######## or BDMAP_########>/combined_labels.nii.gz` (+ `meta.json`: version, who, when) |
| replaced versions | `edits/shared-history/<id>/<UTC timestamp>.nii.gz` (newest 20 kept) |
| shared 3D meshes | `<MESH_PATH>/shared/<id>/` |

The dataset's own files (`mask_only/`, the CancerVerse / AbdomenAtlas overlays) are never touched. Every reader that
shows a mask prefers the shared mask. Saving also builds the new 3D meshes (and the PanTS low-resolution preview) in the
background, so the first visitor after a save does not wait for them; if that fails they are built on first view as
before.

Older per-account edits (`edits/accounts/<hash>/...`) are no longer shown or written; the files are left on disk.

## Before this goes live

Run the usual deploy (`alembic upgrade head` creates the `annotator_invite` table; it is additive and reversible), then
restart the backend. No environment variable is needed any more.

## Undoing a bad correction

- In the app: an annotator can call `DELETE /api/shared-annotation/<case>` (everyone sees the original again; the
  removed version is archived).
- By hand: copy a file from `shared-history/` back to `edits/shared/<id>/combined_labels.nii.gz`. Meshes and
  statistics refresh themselves (they are keyed by the file's revision).

## Not covered yet

Per-organ source files that PDF reports and report measurements read (`mask_only/<case>/segmentations/*.nii.gz`) are
not rewritten, so those still describe the original annotation.
