# Fixed guest showcase

Signed-out public-site check,2026-10-26: `/` is the upload/workspace overview,
not a card grid. `/dashboard` contains the eight PanTS showcase cards described
in the handoff. Opening a card currently brings up sign-in.

`services/showcase.py` fixes the strip's original selection independently of
general search: PanTS only, four tumor and four no-tumor, interleaved; original
quality/demographic ranking, known demographics first among each cohort's top
eight candidates. Selection is cached once at catalog load and replaced on
catalog reload. Fewer than four eligible unique cases in either cohort means
an empty showcase and **no guest volume grants**, not a weaker fallback.

`GET/HEAD /api/showcase` is the shared source for display order and admission.
Only GET/HEAD reads of those exact eight case IDs are admitted at these routes:

- `/api/get-main-nifti/<id>.nii.gz`, full or low resolution;
- `/api/get-segmentations/<id>.nii.gz`, full or low resolution;
- `/api/cases/<id>/mesh-manifest`;
- `/api/cases/<id>/render_only/<filename>`;
- `/api/get-report-data/<id>` (React report and its idle warm-up);
- `/api/cases/<id>/organ-stats` (new catalog-only read counterpart to mask-data).

These are the viewer's CT, categorical mask/organ intensities, mesh, report and
organ-statistics reads. Metadata remains available through existing search.
Numeric and standard PanTS aliases resolve to the same exact allow-listed ID;
path-like, USER, CancerVerse and AbdomenAtlas IDs never qualify. Responses retain
private/no-store caching. New routes still default to private.

`POST /mask-data`, standalone HTML/PDF reports, report sharing, uploads, saving,
inference, session data, user scans and every non-showcase case remain private.
Meshes/reports may use the existing server-side read caches, never guest edits.
An authorization refusal never silently switches the viewer to a public mirror.
Organ-statistics failures return a generic503 response, never exception text or
internal paths. Computation diagnostics stay in server logs.

No layout/control rearrangement, deployment, server SSH or clinical-file access
is part of this PR. Ahmad/Zhou should review this exact narrowing of the
deny-by-default policy. Merge/deployment still need owner approval and VPN.
