#!/usr/bin/env python3
r"""Build the viewer masks of AbdomenAtlas: one label map per scan, in the viewer's own organ numbering.

AbdomenAtlas 3.0 Mini ships one binary file per structure
(``mask_only/BDMAP_########/segmentations/<organ>.nii.gz``, about 44 per scan). The viewer wants ONE
label map per case where every voxel holds the viewer label id of its structure
(``services/label_scheme.py``: 14 liver, 17 pancreas, 12 left kidney, 33 liver lesion ...), the same
numbering PanTS and the AI models use. This folds the files of the 2D map
(``abdomenatlas_catalog.VIEWER_MASK_FILES``, in paint order: organs, their parts, vessels, then the
lesions on top) into ``<out>/mask_only/<id>/combined_labels.nii.gz``.

The nine structures that sit inside the liver (hepatic vessels and the eight liver segments) would erase it from the map,
so they go into a second map, ``<out>/mask_only/<id>/parts_labels.nii.gz``
(``abdomenatlas_catalog.PARTS_MASK_FILES``), read by the 3D meshes only. A small marker, ``mask_scheme.json``, records which
file lists a case was built with, so a rerun rebuilds only the cases made with an older list.

    PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
    cd flask-server
    $PYBIN scripts/build_abdomenatlas_masks.py \
        --data /mnt/bodymaps/zzhou82/data/RadGPT/data \
        --out  /home/visitor/abdomenatlas_overlay --limit 5          # a trial first
    $PYBIN scripts/build_abdomenatlas_masks.py --data ... --out ... --workers 4   # then the whole set

The masks are checked against their scan before they are written: the CT's header (never its voxels) is
read, a mask on the CT's own grid is kept as it is, a mask stored as a cropped box of the CT (same
voxel size and orientation, a whole-voxel offset) is placed into the CT's grid, and anything else, or a CT
that cannot be read, is reported as an error instead of becoming a mask that would not line up.

Resumable (a scan already built with the current file lists is skipped; ``--force`` rebuilds), atomic (a file appears only when
complete), and read-only on the dataset. ``--only BDMAP_00000001`` builds a single scan, ``--limit N``
the first N. Exits non-zero if any scan failed.
"""
import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))      # flask-server/, for services.*
from services.abdomenatlas_catalog import MASK_FILENAME, PARTS_FILENAME, PARTS_MASK_FILES, VIEWER_MASK_FILES  # noqa: E402

SCHEME_FILENAME = "mask_scheme.json"

CASE_RE = re.compile(r"^BDMAP_\d{8}$")


def scheme_id() -> str:
    """Names the two file lists (stems and label ids, in paint order) a mask is built from."""
    import hashlib

    return hashlib.sha1(repr((VIEWER_MASK_FILES, PARTS_MASK_FILES)).encode()).hexdigest()[:12]


def is_current(dest_dir: str) -> bool:
    """True when this case's masks were built with the present file lists (and the 2D map exists)."""
    try:
        with open(os.path.join(dest_dir, SCHEME_FILENAME), "r", encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        return False
    if marker.get("scheme") != scheme_id() or not os.path.isfile(os.path.join(dest_dir, MASK_FILENAME)):
        return False
    return not marker.get("parts") or os.path.isfile(os.path.join(dest_dir, PARTS_FILENAME))


def list_cases(data_root: str, only: Optional[Iterable[str]] = None) -> List[str]:
    """Case ids with a mask folder under ``<data_root>/mask_only``, sorted; ``only`` narrows them."""
    wanted = set(only) if only else None
    root = os.path.join(data_root, "mask_only")
    return sorted(d for d in os.listdir(root) if CASE_RE.match(d) and (wanted is None or d in wanted))


def combine_case(seg_dir: str, files=VIEWER_MASK_FILES):
    """Fold one scan's per-organ masks into a viewer label map.

    Returns ``(labels uint8 volume, affine, {label id: voxels})``, or None when none of the files holds
    a voxel. Files are painted in ``files`` order (``VIEWER_MASK_FILES`` by default), so where two overlap
    the later one (a vessel over an organ, a lesion over its organ) is the one that shows.
    """
    import nibabel as nib

    out = None
    affine = None
    counts: Dict[int, int] = {}
    for stem, label_id in files:
        path = os.path.join(seg_dir, stem + ".nii.gz")
        if not os.path.isfile(path):
            continue
        img = nib.load(path)
        mask = np.squeeze(np.asanyarray(img.dataobj)) > 0.5
        if mask.ndim != 3:
            raise ValueError(f"{stem}: expected a 3D mask, got shape {mask.shape}")
        if out is None:
            out = np.zeros(mask.shape, dtype=np.uint8)
            affine = img.affine
        elif mask.shape != out.shape:
            raise ValueError(f"{stem}: mask grid {mask.shape} differs from {out.shape}")
        voxels = int(np.count_nonzero(mask))
        if voxels:
            out[mask] = label_id
            counts[label_id] = voxels
    if out is None or not counts:
        return None
    # A later file can paint over an earlier one: report what is left in the volume, not what was drawn.
    present = {int(v): int(c) for v, c in zip(*np.unique(out, return_counts=True)) if v}
    return out, affine, present


def fit_to_scan(labels: np.ndarray, affine: np.ndarray, ct_path: str):
    """Put a label map on its CT's grid; ``(labels, ct affine)``. Raises ValueError when it cannot be done.

    Only the CT's header is read. Same grid: kept. A box cut out of the CT (same voxel size and
    orientation, whole-voxel offset, fully inside it): padded to the CT's shape. Anything else is an error:
    drawing such a mask over the scan would put every organ in the wrong place.
    """
    import nibabel as nib

    try:
        ct = nib.load(ct_path)
        ct_shape, ct_affine = tuple(int(n) for n in ct.shape[:3]), np.asarray(ct.affine)
    except Exception as exc:
        reason = type(exc).__name__
        try:
            os.stat(ct_path)                    # nibabel reports a folder it may not enter as "not found"
        except OSError as stat_error:
            reason = f"{type(stat_error).__name__}: {stat_error.strerror}"
        raise ValueError(f"the CT cannot be read ({reason}), so the mask cannot be checked against it")
    if tuple(labels.shape) == ct_shape and np.allclose(affine, ct_affine, atol=1e-3):
        return labels, ct_affine
    rel = np.linalg.inv(ct_affine) @ affine           # the mask's voxel grid in the CT's voxel coordinates
    if not np.allclose(rel[:3, :3], np.eye(3), atol=1e-3):
        raise ValueError("the mask and the CT differ in voxel size or orientation")
    offset = rel[:3, 3]
    if np.abs(offset - np.rint(offset)).max() > 0.02:
        raise ValueError("the mask is not on the CT's voxel grid")
    start = np.rint(offset).astype(int)
    stop = start + np.array(labels.shape)
    if (start < 0).any() or (stop > np.array(ct_shape)).any():
        raise ValueError(f"the mask {tuple(labels.shape)} at offset {start.tolist()} falls outside the CT {ct_shape}")
    fitted = np.zeros(ct_shape, dtype=np.uint8)
    fitted[start[0]:stop[0], start[1]:stop[1], start[2]:stop[2]] = labels
    return fitted, ct_affine


def _write_labels(labels: np.ndarray, affine: np.ndarray, dest_dir: str, filename: str) -> None:
    import nibabel as nib

    tmp = os.path.join(dest_dir, "." + filename.replace(".nii.gz", ".part.nii.gz"))   # nibabel decides gzip by the extension
    image = nib.Nifti1Image(labels, affine)
    image.set_data_dtype(np.uint8)
    nib.save(image, tmp)
    os.replace(tmp, os.path.join(dest_dir, filename))              # a reader never sees half a file


def build_case(case: str, data_root: str, out_root: str, force: bool) -> dict:
    """Write one scan's masks. Never raises: a failure is reported in the result."""
    dest_dir = os.path.join(out_root, "mask_only", case)
    try:
        if is_current(dest_dir) and not force:
            return {"case": case, "status": "skipped"}
        seg_dir = os.path.join(data_root, "mask_only", case, "segmentations")
        ct_path = os.path.join(data_root, "image_only", case, "ct.nii.gz")
        combined = combine_case(seg_dir)
        if combined is None:
            return {"case": case, "status": "empty"}        # no file the viewer knows, or all of them empty
        labels, affine, counts = combined
        labels, affine = fit_to_scan(labels, affine, ct_path)
        os.makedirs(dest_dir, exist_ok=True)
        # The parts map is built BEFORE the 2D map is published: a scan whose parts cannot be placed on its CT is an error and
        # keeps its old masks, so the two maps of one case always come from one build.
        parts = combine_case(seg_dir, PARTS_MASK_FILES)
        parts_counts: Dict[int, int] = {}
        if parts is not None:
            parts_labels, parts_affine, parts_counts = parts
            parts_labels, parts_affine = fit_to_scan(parts_labels, parts_affine, ct_path)
            _write_labels(parts_labels, parts_affine, dest_dir, PARTS_FILENAME)
        else:
            try:
                os.remove(os.path.join(dest_dir, PARTS_FILENAME))      # a stale parts map of an earlier build
            except OSError:
                pass
        _write_labels(labels, affine, dest_dir, MASK_FILENAME)
        marker = os.path.join(dest_dir, "." + SCHEME_FILENAME + ".part")
        with open(marker, "w", encoding="utf-8") as handle:
            json.dump({"scheme": scheme_id(), "parts": bool(parts_counts)}, handle)
        os.replace(marker, os.path.join(dest_dir, SCHEME_FILENAME))
        return {"case": case, "status": "built", "labels": counts, "parts": parts_counts, "shape": list(labels.shape)}
    except Exception as exc:                                     # one bad scan must not stop the run
        return {"case": case, "status": "error", "error": f"{type(exc).__name__}: {exc}"}


def run(cases: List[str], data_root: str, out_root: str, workers: int = 1, force: bool = False,
        limit: int = 0, progress_every: int = 250) -> dict:
    if limit:
        cases = cases[:limit]
    results: List[dict] = []
    started = time.time()

    def absorb(res: dict) -> None:
        results.append(res)
        if res["status"] == "error":
            print(f"ERROR {res['case']}: {res['error']}", file=sys.stderr, flush=True)
        if progress_every and len(results) % progress_every == 0:
            print(f"{len(results)}/{len(cases)} scans done, {time.time() - started:.0f}s", flush=True)

    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            pending: List = []
            for case in cases:
                pending.append(pool.submit(build_case, case, data_root, out_root, force))
                if len(pending) >= workers * 4:                  # bounded memory: wait for the oldest
                    absorb(pending.pop(0).result())
            for fut in pending:
                absorb(fut.result())
    else:
        for case in cases:
            absorb(build_case(case, data_root, out_root, force))

    scans_per_label: Dict[int, int] = {}
    for r in results:
        for label in list(r.get("labels") or {}) + list(r.get("parts") or {}):
            scans_per_label[int(label)] = scans_per_label.get(int(label), 0) + 1
    return {
        "built": sum(r["status"] == "built" for r in results),
        "skipped": sum(r["status"] == "skipped" for r in results),
        "empty": [r["case"] for r in results if r["status"] == "empty"],
        "errors": {r["case"]: r["error"] for r in results if r["status"] == "error"},
        "scans_per_label": {str(k): v for k, v in sorted(scans_per_label.items())},
        "seconds": round(time.time() - started, 1),
    }


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, help="AbdomenAtlas folder holding mask_only/ (ABDOMENATLAS_PATH)")
    ap.add_argument("--out", required=True, help="overlay folder; masks go to <out>/mask_only/<id>/")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--only", action="append", help="build just this scan id (repeatable)")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many scans (a trial run)")
    ap.add_argument("--force", action="store_true", help="rebuild scans even when they were built with the current file lists")
    args = ap.parse_args(argv)

    cases = list_cases(args.data, args.only)
    print(f"{len(cases)} scans to build into {args.out}/mask_only", flush=True)
    summary = run(cases, args.data, args.out, workers=max(1, args.workers), force=args.force, limit=args.limit)
    summary["finished"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not args.only and not args.limit:
        os.makedirs(args.out, exist_ok=True)
        tmp = os.path.join(args.out, "abdomenatlas_masks.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1)
        os.replace(tmp, os.path.join(args.out, "abdomenatlas_masks.json"))
    print(f"MASKS_DONE built={summary['built']} skipped={summary['skipped']} empty={len(summary['empty'])} "
          f"errors={len(summary['errors'])} in {summary['seconds']}s", flush=True)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
