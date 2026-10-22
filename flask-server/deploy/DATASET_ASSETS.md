# Dataset assets: thumbnails (`profile_only`) and 3D meshes (`render_only`)

Each dataset on the shared drive is laid out the same way, and the site reads two more folders per case:

| folder | one per case | made by | read by the site from |
|---|---|---|---|
| `profile_only/<id>/profile.jpg` | a 512x512 bone-window coronal MIP, the library card | `scripts/make_profile_previews.py` | `<dataset root>/profile_only` (and an overlay first, for CancerVerse and AbdomenAtlas) |
| `render_only/<id>/<organ>.glb` + `manifest.json` | the 3D tab's organ meshes | `scripts/bake_dataset_meshes.py` | `MESH_PATH` (default `/home/visitor/data/render_only`) |

The shared drive is read-only for the `visitor` account, so everything is built on the web node and the owner
copies the finished folders across. Nothing below changes the datasets.

## Before building

- **AbdomenAtlas scans must be readable.** Its `image_only/BDMAP_*` folders are created mode 750, so `visitor`
  gets "Permission denied". The masks, thumbnails and viewer masks all need the scan's header, so the owner runs
  `chmod -R go+rX <AbdomenAtlas>/image_only` (again after any new download).
- **CancerVerse labels must be readable** for any rebuild of its tumor masks: some `mask_only/*/segmentations`
  files are created mode 750 as well (`chmod -R go+rX <CancerVerse>/mask_only`).
- Run long jobs with `nice -n 15` (and `--workers 4` at most) on the web node, and keep the disk floor
  (`--min-free-gb`, default 100) so a bake can never fill `/home`.

## Build, per dataset

```
PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
cd flask-server

# PanTS: masks are on the shared drive; meshes go to MESH_PATH
nice -n 15 $PYBIN scripts/bake_dataset_meshes.py --dataset pants --workers 4

# CancerVerse: tumor masks first (scripts/build_cancerverse_masks.py), then thumbnails and meshes
nice -n 15 $PYBIN scripts/make_profile_previews.py --ct-root <CancerVerse> --out-root $CANCERVERSE_OVERLAY_PATH
nice -n 15 $PYBIN scripts/bake_dataset_meshes.py --dataset cancerverse --workers 4

# AbdomenAtlas: viewer masks first (scripts/build_abdomenatlas_masks.py), then the same two
nice -n 15 $PYBIN scripts/make_profile_previews.py --ct-root <AbdomenAtlas> --out-root $ABDOMENATLAS_OVERLAY_PATH
nice -n 15 $PYBIN scripts/bake_dataset_meshes.py --dataset abdomenatlas --workers 4
```

`bake_dataset_meshes.py` is resumable (a case with complete, current meshes is skipped), `--dry-run` lists the
work, `--stop-file PATH` halts it cleanly when the file appears (run it again to continue), and a case whose mask
holds no labels gets a manifest with no organs (there is nothing to draw). A case that failed is listed and the
exit code is 1; the others are kept.

## Moving finished assets to the shared drive

Copy, do not move: the site keeps reading `MESH_PATH` and the overlays, and an interrupted move would leave a case
with no meshes. As the dataset's owner:

```
# 3D meshes of one dataset (the cache holds all three, told apart by their id prefix)
rsync -rt --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r --include='PanTS_*/' --include='PanTS_*/*' --exclude='*' \
    /home/visitor/data/render_only/ <PanTS>/render_only/          # likewise CV_* and BDMAP_*

# thumbnails built into an overlay
rsync -rt --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r /home/visitor/cancerverse_v351/profile_only/ <CancerVerse>/profile_only/
```

Once a dataset's `render_only/` is on the shared drive, point `MESH_PATH` at a folder that holds all three (or
keep the local cache); the site needs no other change.
