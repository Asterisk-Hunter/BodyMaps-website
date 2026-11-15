# Annotator access: saving corrections for everyone

A dataset scan (PanTS, CancerVerse, AbdomenAtlas) has **one version for everybody**. Nobody keeps a private copy of
it on the server. Approved people (annotators) can fix a scan's segmentation and save it with **Save to JHU server**
(viewer toolbar, above **Save to computer**, shown only to them). From then on every visitor gets the corrected
mask: the 2D masks, the 3D meshes, the organ statistics and PDAC staging all follow it. Everyone else sees only
**Save to computer**, which downloads their edit as a NIfTI file.

## Who is approved

The `annotator` role, or `annotation_manager`. **Being an admin is not enough.** Only an **annotation manager**
(today: the owner and the PI) can grant or remove `annotator` and create codes; an annotator cannot grant it to
anyone or see other accounts. `annotation_manager` itself is never granted through the website, only on the server:

```bash
cd /home/visitor/PanTS-Viewer/flask-server && /home/visitor/.conda/envs/PanTS_backend/bin/python scripts/grant_role.py --email <address> --role annotation_manager   # add --revoke to take it away
```

A manager sees two ways to give someone the annotator role:

1. **A temporary code.** Settings > People > *Annotator access code* > pick how long it works (1 hour, 1 day, 7 days) >
   **Create code**. The code (`XXXX-XXXX-XXXX`) is shown once; give it to the person. They enter it under
   Settings > Profile > *Invitation code*. A code works **once** and then expires, can be withdrawn from the same
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

## Assigning cases to annotators

An annotation manager can hand each annotator a range of library case numbers (the numbers `/case/<number>` opens)
for one task, for example "cases 55 to 95: veins and arteries". Account, Assignments has three parts:

- **My cases** (annotators and managers): each assignment with its progress and a Continue button that opens the next
  case still to do. On a case that is in an assignment, a bar above the viewer offers "Done, next case", "Flag, next
  case", "Mark as not done" and "Skip".
- **Hand out cases** (managers): a range, a task, an optional due date and note, and one or more people. With several
  people the range is split evenly, with a preview first. Giving the same cases to two people for the same task asks
  for confirmation, since it is usually a slip but is right for a second reader.
- **Everyone's progress** (managers): per person, with totals; an assignment can be given to someone else or removed.

Only annotators and managers can be given cases (grant `annotator` from Account, People). A person who loses the role
keeps their finished marks but cannot be handed new work. Marks live in `annotation_assignment_case`; a case with no row
is still to do. The API is `api/assignments_blueprint.py`; `alembic upgrade head` creates the two tables (additive and
reversible), then restart the backend.
