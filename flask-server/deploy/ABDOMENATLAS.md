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
| Viewer: organ mask and organ panel | yes, 34 structures in the 2D mask in the viewer's own numbering (the one PanTS uses); the organ panel of an AbdomenAtlas case adds the esophagus, rectum, celiac AA, celiac trunk and the portal and splenic vein, and gives the liver a group of its own |
| 3D organ meshes | yes, 43 structures: the 34 above, baked on the first request from the mask, plus the nine that sit inside the liver (hepatic vessels and the eight liver segments), baked ahead of time by `bake_dataset_meshes.py` |
| Card thumbnails | yes, once drawn (below) |
| Organ statistics, AI assistant, the model tools (point/box segment) | **not yet**: they read PanTS paths. A case shows the same "no statistics" notice CancerVerse does. |

### Where each of the 43 structures goes

Every file of the dataset has a viewer label (`services/label_scheme.py`, ids 45-58 are the 14 that PanTS and CancerVerse do not
have). One voxel of the 2D mask holds one label, so what a structure overlaps decides where it can go (measured on four scans):

| Structures | Overlap | Goes into |
|---|---|---|
| esophagus, rectum, celiac AA, celiac trunk | none (at most 6% of a structure's voxels lie inside any other one) | `combined_labels.nii.gz`, the 2D mask |
| portal and splenic vein | 67-79% of it lies inside `veins` | the 2D mask, painted after `veins` (the way the pancreas parts go over the pancreas) |
| hepatic vessels, liver segments 1-8 | 76-99% of each lies inside the liver (the segments even extend a little past it) | `parts_labels.nii.gz`, a second map read only by the 3D meshes |

Painting the nine liver structures into the 2D mask would erase the whole liver from the overlay, its organ-panel entry and its
mesh, so they stay out of it: the liver is whole in 2D and the segments and vessels are 3D structures. Their 2D voxels do not exist,
so the organ panel's "jump to" for them does nothing in the 2D views.

## Where things live

```
ABDOMENATLAS_PATH          (read-only, the PI's download)
    AbdomenAtlas3.0MiniWithMeta.csv
    image_only/BDMAP_########/ct.nii.gz
    mask_only/BDMAP_########/segmentations/<organ>.nii.gz

ABDOMENATLAS_OVERLAY_PATH  (writable, built from the above)
    mask_only/BDMAP_########/combined_labels.nii.gz       one viewer mask per scan (34 structures)
    mask_only/BDMAP_########/parts_labels.nii.gz          hepatic vessels and liver segments, for the 3D meshes only
    mask_only/BDMAP_########/mask_scheme.json             which file lists the case was built with
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

   Resumable and atomic; it prints `MASKS_DONE built=... errors=...` and exits non-zero if any scan failed. A case whose
   `mask_scheme.json` names the present file lists is skipped; one built with an older list (or without the marker) is rebuilt,
   so after a release that adds structures the same command upgrades the overlay. A scan whose parts map cannot be placed on its
   CT is an error and keeps its old masks.
   The masks of this dataset are stored as a box cut out of the CT, not on the CT's full grid, so each mask
   is checked against its CT's header and placed on the CT's grid; a mask that cannot be matched is reported
   as an error and no file is written for it (a mask that does not line up must never be shown).

2. Draw the thumbnails (`scripts/make_profile_previews.py` finds `<root>/image_only/<id>/ct.nii.gz`):

   ```bash
   nice -n 19 $PYBIN scripts/make_profile_previews.py --ct-root "$ABDOMENATLAS_PATH" --out-root "$ABDOMENATLAS_OVERLAY_PATH"
   ```

3. Bake the 3D meshes ahead of time (the first request would otherwise bake a case on the spot, and without the parts meshes):

   ```bash
   nice -n 19 ionice -c3 $PYBIN scripts/bake_dataset_meshes.py --dataset abdomenatlas --workers 2 \
       --min-free-gb 250 --stop-file /home/visitor/STOP_atlas_bake
   ```

   It stops cleanly when the disk runs under `--min-free-gb` or the stop file exists, and a rerun continues. A case that was baked
   before its parts map existed gets the parts meshes added to its manifest without rebaking the others (`partsBaked`).

4. Add `ABDOMENATLAS_PATH` and `ABDOMENATLAS_OVERLAY_PATH` to `flask-server/.env` and restart the backend
   (`deploy/start_backend.sh`, when `/api/health` shows no running jobs): the metadata is read once at
   start-up.

To switch it off again, remove the two lines and restart. Nothing else changed.

## Optional: let nginx send the big files

CTs and masks go through Flask (`send_file`) until nginx has internal locations for the two roots, like the
CancerVerse ones in `deploy/nginx-bodymaps.conf`. That works but holds a gunicorn thread per download.
