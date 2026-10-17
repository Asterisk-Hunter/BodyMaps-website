# AbdomenAtlas, the third dataset

AbdomenAtlas 3.0 Mini (9,262 CTs with organ masks; the data the AtlasNet model is trained on) is searched
and viewed together with PanTS and CancerVerse. Its ids are `BDMAP_00000001` to `BDMAP_00009262`, and its
library numbers continue after CancerVerse: **34,324 is `BDMAP_00000001`** (PanTS is 1-9,901, CancerVerse
9,902-34,323). CancerVerse's block is frozen at 24,422, so a later CancerVerse release never renumbers
an AbdomenAtlas case.

The code is dormant until `ABDOMENATLAS_PATH` is set: with no path and no metadata CSV the library is
exactly PanTS + CancerVerse, as before.

## What the site shows

| | AbdomenAtlas |
|---|---|
| Library cards and search | yes: sex, age, scanner, contrast phase, tumor yes/no and tumor organs (liver, pancreas, kidney, colon), all read from the metadata CSV. The report texts and the radiologist note are never exposed. |
| Viewer: CT | yes, from the dataset mount (`<ABDOMENATLAS_PATH>/image_only/<id>/ct.nii.gz`) |
| Viewer: organ mask and organ panel | yes, 29 structures in the viewer's own numbering (the one PanTS uses) |
| 3D organ meshes | yes, baked on the first request from the mask |
| Card thumbnails | yes, once drawn (below) |
| Organ statistics, AI assistant, the model tools (point/box segment) | **not yet**: they read PanTS paths. A case shows the same "no statistics" notice CancerVerse does. |

Structures the dataset has but the viewer has no label for are not drawn: `celiac_aa`, `celiac_trunk`,
`esophagus`, `hepatic_vessel`, `liver_segment_1..8`, `portal_vein_and_splenic_vein`, `rectum`
(`services/abdomenatlas_catalog.py`, `UNMAPPED_MASK_FILES`).

## Where things live

```
ABDOMENATLAS_PATH          (read-only, the PI's download)
    AbdomenAtlas3.0MiniWithMeta.csv
    image_only/BDMAP_########/ct.nii.gz
    mask_only/BDMAP_########/segmentations/<organ>.nii.gz

ABDOMENATLAS_OVERLAY_PATH  (writable, built from the above)
    mask_only/BDMAP_########/combined_labels.nii.gz       one viewer mask per scan
    profile_only/BDMAP_########/profile.jpg               card thumbnails
    lowres/image_only/BDMAP_########/ct_lowres.nii.gz     optional
```

Meshes are cached under `MESH_PATH/BDMAP_########/` like the other datasets'.

## Before it can work: the CT folders must be readable

The dataset's tarballs unpack with mode `750`, so `image_only/BDMAP_########` is readable by the owner's
group only and the site (user `visitor`) gets "Permission denied". The owner (or anyone with rights on the
folder) fixes it once:

```bash
chmod -R go+rX /mnt/bodymaps/zzhou82/data/RadGPT/data/image_only
```

(Re-run it after any further download: the unpacking resets the mode.) The masks and the CSV are already
readable.

## Turning it on

1. Build the masks (reads the masks and each CT's header; about 4 s per scan, so use a few workers):

   ```bash
   PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
   cd flask-server
   $PYBIN scripts/build_abdomenatlas_masks.py --data "$ABDOMENATLAS_PATH" --out "$ABDOMENATLAS_OVERLAY_PATH" --limit 5   # a trial
   nice -n 19 $PYBIN scripts/build_abdomenatlas_masks.py --data "$ABDOMENATLAS_PATH" --out "$ABDOMENATLAS_OVERLAY_PATH" --workers 4
   ```

   Resumable and atomic; it prints `MASKS_DONE built=... errors=...` and exits non-zero if any scan failed.
   The masks of this dataset are stored as a box cut out of the CT, not on the CT's full grid, so each mask
   is checked against its CT's header and placed on the CT's grid; a mask that cannot be matched is reported
   as an error and no file is written for it (a mask that does not line up must never be shown).

2. Draw the thumbnails (`scripts/make_profile_previews.py` finds `<root>/image_only/<id>/ct.nii.gz`):

   ```bash
   nice -n 19 $PYBIN scripts/make_profile_previews.py --ct-root "$ABDOMENATLAS_PATH" --out-root "$ABDOMENATLAS_OVERLAY_PATH"
   ```

3. Add `ABDOMENATLAS_PATH` and `ABDOMENATLAS_OVERLAY_PATH` to `flask-server/.env` and restart the backend
   (`deploy/start_backend.sh`, when `/api/health` shows no running jobs): the metadata is read once at
   start-up.

To switch it off again, remove the two lines and restart. Nothing else changed.

## Optional: let nginx send the big files

CTs and masks go through Flask (`send_file`) until nginx has internal locations for the two roots, like the
CancerVerse ones in `deploy/nginx-bodymaps.conf`. That works but holds a gunicorn thread per download.
