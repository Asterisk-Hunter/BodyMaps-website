#!/usr/bin/env python3
r"""Build the viewer masks of CancerVerse: one tumor label map per scan that has an annotated tumor.

CancerVerse releases tumor masks only (``CV_########/segmentations/<organ>_lesion.nii.gz``, 13 per
scan, almost all empty) and no organ masks. The viewer wants one label map per case, so this folds
each scan's tumors into ``<overlay>/mask_only/CV_########/combined_labels.nii.gz``, a uint8 volume on
the CT's grid where every voxel holds the viewer label id of its tumor type
(``cancerverse_catalog.LESION_LABEL_IDS``: 22 pancreas, 33 liver, 34 kidney, 35 colon, 36 stomach,
37 adrenal gland, 38 bladder, 39 prostate, 40 esophagus, 41 spleen, 42 uterus, 43 duodenum,
44 gallbladder). Where two tumors overlap, the smaller one is drawn on top.

Which scans have a tumor, and in which organs, comes from the case index
(``scripts/build_cancerverse_index.py``), so only those masks are decoded. Scans without an
annotated tumor get no file: the site shows them CT-only, as before.

    python scripts/build_cancerverse_masks.py \
        --labels /home/visitor/cancerverse_v351/downloads/CancerVerse_Label.tar.gz \
        --index  /home/visitor/cancerverse_v351/cancerverse_case_index.json \
        --out    /home/visitor/cancerverse_v351 --workers 2

Resumable (a scan whose file exists is skipped; ``--force`` rebuilds), atomic (a file appears only
when complete), and read-only on the inputs. ``--only CV_00015333`` builds a single scan,
``--limit N`` the first N (for a trial). Exits non-zero if any scan failed.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))      # flask-server/, for services.*
sys.path.insert(0, _HERE)                       # scripts/ is not a package
from services.cancerverse_catalog import LESION_LABEL_IDS, LESION_TYPES, MASK_FILENAME  # noqa: E402
from build_cancerverse_index import iter_cases_from_tar  # noqa: E402

STEM_BY_ORGAN: Dict[str, str] = {organ: stem for stem, organ in LESION_TYPES.items()}


def stems_for(organs: Iterable[str]) -> List[str]:
    """Mask file stems for tumor-type names from the index ("liver" -> "liver_lesion")."""
    return [STEM_BY_ORGAN[o] for o in organs if o in STEM_BY_ORGAN]


def combine_case(members: Dict[str, bytes], stems: Iterable[str]):
    """Fold one scan's tumor masks into a label map.

    Returns ``(labels uint8 volume, affine, {label id: voxels})`` or None when none of the masks
    holds a voxel. Larger tumors are written first so a smaller one inside or over it stays visible.
    """
    import nibabel as nib

    layers = []
    for stem in stems:
        raw = members.get(stem)
        if raw is None or stem not in LESION_LABEL_IDS:
            continue
        img = nib.Nifti1Image.from_bytes(gzip.decompress(raw))
        mask = np.squeeze(np.asarray(img.dataobj)) > 0.5
        if mask.ndim != 3:
            raise ValueError(f"{stem}: expected a 3D mask, got shape {mask.shape}")
        voxels = int(np.count_nonzero(mask))
        if voxels:
            layers.append((voxels, stem, mask, img))
    if not layers:
        return None
    layers.sort(key=lambda layer: (-layer[0], layer[1]))
    shape, affine = layers[0][2].shape, layers[0][3].affine
    out = np.zeros(shape, dtype=np.uint8)
    counts: Dict[int, int] = {}
    for voxels, stem, mask, _img in layers:
        if mask.shape != shape:
            raise ValueError(f"{stem}: mask grid {mask.shape} differs from {shape}")
        out[mask] = LESION_LABEL_IDS[stem]
        counts[LESION_LABEL_IDS[stem]] = voxels
    return out, affine, counts


def build_case(case: str, members: Dict[str, bytes], organs: List[str], out_root: str, force: bool) -> dict:
    """Write one scan's mask. Never raises: a failure is reported in the result."""
    dest_dir = os.path.join(out_root, "mask_only", case)
    dest = os.path.join(dest_dir, MASK_FILENAME)
    try:
        if os.path.isfile(dest) and not force:
            return {"case": case, "status": "skipped"}
        combined = combine_case(members, stems_for(organs))
        if combined is None:
            return {"case": case, "status": "empty"}        # the index said tumor, the masks hold none
        import nibabel as nib

        labels, affine, counts = combined
        os.makedirs(dest_dir, exist_ok=True)
        tmp = os.path.join(dest_dir, "combined_labels.part.nii.gz")   # nibabel decides gzip by the extension
        image = nib.Nifti1Image(labels, affine)
        image.set_data_dtype(np.uint8)
        nib.save(image, tmp)
        os.replace(tmp, dest)                                   # a reader never sees half a file
        return {"case": case, "status": "built", "labels": counts, "shape": list(labels.shape)}
    except Exception as exc:                                     # one bad scan must not stop the run
        return {"case": case, "status": "error", "error": f"{type(exc).__name__}: {exc}"}


def todo_from_index(index: dict, only: Optional[Iterable[str]] = None) -> Dict[str, List[str]]:
    """{case id: tumor-type names} for the scans the index says have a tumor."""
    wanted = set(only) if only else None
    todo = {}
    for case, entry in index.get("cases", {}).items():
        if entry.get("tumors") and (wanted is None or case in wanted):
            todo[case] = list(entry["tumors"])
    return todo


def run(cases: Iterable[Tuple[str, Dict[str, bytes]]], todo: Dict[str, List[str]], out_root: str,
        workers: int = 1, force: bool = False, limit: int = 0, progress_every: int = 500) -> dict:
    results: List[dict] = []
    started = time.time()
    submitted = 0

    def absorb(res: dict) -> None:
        results.append(res)
        if res["status"] == "error":
            print(f"ERROR {res['case']}: {res['error']}", file=sys.stderr, flush=True)
        if progress_every and len(results) % progress_every == 0:
            print(f"{len(results)} scans done, {time.time() - started:.0f}s", flush=True)

    pending: List = []
    pool = ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        for case, members in cases:
            if case not in todo:
                continue
            if limit and submitted >= limit:
                break
            submitted += 1
            if pool is None:
                absorb(build_case(case, members, todo[case], out_root, force))
                continue
            pending.append(pool.submit(build_case, case, members, todo[case], out_root, force))
            if len(pending) >= workers * 4:                      # bounded memory: wait for the oldest
                absorb(pending.pop(0).result())
        for fut in pending:
            absorb(fut.result())
    finally:
        if pool is not None:
            pool.shutdown()

    seen = {r["case"] for r in results}
    scans_per_label: Dict[int, int] = {}
    for r in results:
        for label in (r.get("labels") or {}):
            scans_per_label[int(label)] = scans_per_label.get(int(label), 0) + 1
    return {
        "built": sum(r["status"] == "built" for r in results),
        "skipped": sum(r["status"] == "skipped" for r in results),
        "empty": [r["case"] for r in results if r["status"] == "empty"],
        "errors": {r["case"]: r["error"] for r in results if r["status"] == "error"},
        "not_in_archive": sorted(c for c in todo if c not in seen) if not limit else [],
        "scans_per_label": {str(k): v for k, v in sorted(scans_per_label.items())},
        "seconds": round(time.time() - started, 1),
    }


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--labels", required=True, help="CancerVerse_Label.tar.gz")
    ap.add_argument("--index", required=True, help="cancerverse_case_index.json")
    ap.add_argument("--out", required=True, help="overlay folder; masks go to <out>/mask_only/<id>/")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--only", action="append", help="build just this scan id (repeatable)")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many scans (a trial run)")
    ap.add_argument("--force", action="store_true", help="rebuild scans that already have a mask")
    args = ap.parse_args(argv)

    with open(args.index, encoding="utf-8") as f:
        todo = todo_from_index(json.load(f), args.only)
    print(f"{len(todo)} scans with an annotated tumor to build into {args.out}/mask_only", flush=True)
    summary = run(iter_cases_from_tar(args.labels), todo, args.out, workers=max(1, args.workers),
                  force=args.force, limit=args.limit)
    summary["finished"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not args.only and not args.limit:
        tmp = os.path.join(args.out, "cancerverse_masks.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1)
        os.replace(tmp, os.path.join(args.out, "cancerverse_masks.json"))
    print(f"MASKS_DONE built={summary['built']} skipped={summary['skipped']} empty={len(summary['empty'])} "
          f"errors={len(summary['errors'])} not_in_archive={len(summary['not_in_archive'])} "
          f"in {summary['seconds']}s", flush=True)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
