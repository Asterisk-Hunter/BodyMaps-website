#!/usr/bin/env python3
r"""Bake the 3D meshes (``render_only``) of a whole dataset ahead of time.

The viewer's 3D tab draws one GLB per organ plus a ``manifest.json``, under
``<MESH_PATH>/<case id>/``. The site bakes them the first time somebody opens a case (a wait of seconds to
a minute, and the same work again for the next visitor if the cache is read-only). This runs that same bake
(``services.mesh_generation.bake_case_meshes``, the code the routes run) over every case of a dataset, so the
3D tab opens instantly and the finished folders can be copied to the dataset's own ``render_only/``.

    PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
    cd flask-server
    nice -n 15 $PYBIN scripts/bake_dataset_meshes.py --dataset cancerverse --limit 5      # a trial first
    nice -n 15 $PYBIN scripts/bake_dataset_meshes.py --dataset cancerverse --workers 4    # then the set

What it reads, per dataset (all read-only):
  pants         <PANTS_PATH>/mask_only/PanTS_########/combined_labels.nii.gz, converted to the viewer's
                organ numbering in a temporary file (the dataset numbers organs differently);
  cancerverse   <CANCERVERSE_OVERLAY_PATH>/mask_only/CV_########/combined_labels.nii.gz (tumor masks,
                built by scripts/build_cancerverse_masks.py), meshed unsmoothed like the site does;
  abdomenatlas  <ABDOMENATLAS_OVERLAY_PATH>/mask_only/BDMAP_########/combined_labels.nii.gz (built by
                scripts/build_abdomenatlas_masks.py, which needs the scans readable).
Scans with no mask have no organs to draw and are not listed.

Where it writes: ``--mesh-root`` (default ``MESH_PATH``, the folder the site serves meshes from), one
folder per case. Resumable: a case whose manifest is complete (every GLB it names exists) and not older
than its mask is skipped; ``--force`` rebakes it. A manifest baked before the viewer's organ numbering
existed still counts as complete (the site relabels it when it is read); ``--refresh-legacy`` rebakes those
too. It stops when the disk it writes to has less than ``--min-free-gb`` free or when the ``--stop-file`` appears
(finished cases are kept; run it again to continue), and exits non-zero if any case failed. ``--dry-run`` lists what would be baked and writes nothing.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from typing import Dict, Iterable, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))      # flask-server/, for services.*

DATASETS = ("pants", "cancerverse", "abdomenatlas")
CASE_RE = {
    "pants": re.compile(r"^PanTS_\d{8}$"),
    "cancerverse": re.compile(r"^CV_\d{8}$"),
    "abdomenatlas": re.compile(r"^BDMAP_\d{8}$"),
}
MASK_NAME = "combined_labels.nii.gz"
# The site meshes CancerVerse's tumors without smoothing (api_blueprint._cancerverse_mesh_manifest).
UNSMOOTHED = frozenset({"cancerverse"})


def mask_root(dataset: str, data_root: Optional[str]) -> str:
    """The folder holding ``mask_only/`` for a dataset."""
    if data_root:
        return data_root
    from constants import Constants
    root = {
        "pants": Constants.PANTS_PATH,
        "cancerverse": Constants.CANCERVERSE_OVERLAY_PATH,
        "abdomenatlas": Constants.ABDOMENATLAS_OVERLAY_PATH,
    }[dataset]
    if not root:
        raise SystemExit(f"No mask folder is configured for {dataset}: pass --data-root.")
    return root


def list_cases(dataset: str, root: str, only: Optional[Iterable[str]] = None) -> List[str]:
    """Case ids that have a mask file under ``<root>/mask_only``, sorted; ``only`` narrows them."""
    wanted = set(only) if only else None
    base = os.path.join(root, "mask_only")
    out = []
    for name in sorted(os.listdir(base)):
        if not CASE_RE[dataset].match(name) or (wanted is not None and name not in wanted):
            continue
        if os.path.isfile(os.path.join(base, name, MASK_NAME)):
            out.append(name)
    return out


def manifest_state(case_dir: str, mask_path: str, refresh_legacy: bool) -> str:
    """'ok' (nothing to do), 'missing', 'incomplete', 'stale' (the mask is newer) or 'legacy'."""
    from services.label_scheme import SCHEME
    from services.mesh_generation import organ_glb_filename

    manifest_path = os.path.join(case_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        return "missing"
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        organs = manifest["organs"]
        if not isinstance(organs, list) or not isinstance(manifest.get("bounds"), dict):
            return "incomplete"
        if any(not os.path.isfile(os.path.join(case_dir, organ_glb_filename(organ))) for organ in organs):
            return "incomplete"
    except (OSError, ValueError, KeyError, TypeError):
        return "incomplete"
    if os.path.getmtime(manifest_path) < os.path.getmtime(mask_path):
        return "stale"
    if refresh_legacy and manifest.get("labelScheme") != SCHEME:
        return "legacy"
    return "ok"


PARTS_MASK = "parts_labels.nii.gz"


def parts_pending(case_dir: str, parts_path: str) -> bool:
    """True when a case has a second label map (AbdomenAtlas' liver segments and hepatic vessels) whose meshes are not in the
    manifest yet: the flag is missing, or the map is newer than the manifest."""
    if not os.path.isfile(parts_path):
        return False
    manifest_path = os.path.join(case_dir, "manifest.json")
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            baked = json.load(handle).get("partsBaked") is True
    except (OSError, ValueError):
        return True
    return not baked or os.path.getmtime(parts_path) > os.path.getmtime(manifest_path)


def _folder_bytes(path: str) -> int:
    return sum(os.path.getsize(os.path.join(path, name)) for name in os.listdir(path)
               if os.path.isfile(os.path.join(path, name)))


def bake_case(job: Tuple[str, str, str, str, bool, bool]) -> dict:
    """Bake one case. Never raises: a failure is reported in the result so one bad scan cannot stop the run."""
    dataset, case, root, mesh_root, force, refresh_legacy = job
    mask_path = os.path.join(root, "mask_only", case, MASK_NAME)
    case_dir = os.path.join(mesh_root, case)
    parts_path = os.path.join(root, "mask_only", case, PARTS_MASK) if dataset == "abdomenatlas" else ""
    try:
        state = manifest_state(case_dir, mask_path, refresh_legacy)
        if state == "ok" and not force:
            if parts_path and parts_pending(case_dir, parts_path):
                from services.mesh_generation import bake_extra_meshes

                manifest = bake_extra_meshes(case, parts_path, case_dir, route_base="cases", smooth=dataset not in UNSMOOTHED)
                return {"case": case, "status": "baked", "was": "parts", "organs": len(manifest["organs"]),
                        "bytes": _folder_bytes(case_dir)}
            return {"case": case, "status": "skipped"}
        from services.mesh_generation import bake_case_meshes

        scratch = None
        source = mask_path
        if dataset == "pants":
            import nibabel as nib
            import numpy as np
            from services.label_scheme import to_viewer

            raw = nib.load(mask_path)
            os.makedirs(os.path.join(mesh_root, ".bake-tmp"), exist_ok=True)
            scratch = tempfile.mkdtemp(prefix=f"{case}-", dir=os.path.join(mesh_root, ".bake-tmp"))
            source = os.path.join(scratch, MASK_NAME)
            nib.save(nib.Nifti1Image(to_viewer(np.asanyarray(raw.dataobj)).astype(np.uint8), raw.affine), source)
        try:
            manifest = bake_case_meshes(case, source, case_dir, route_base="cases", smooth=dataset not in UNSMOOTHED)
            if parts_path and os.path.isfile(parts_path):
                from services.mesh_generation import bake_extra_meshes

                manifest = bake_extra_meshes(case, parts_path, case_dir, route_base="cases", smooth=dataset not in UNSMOOTHED)
        finally:
            if scratch:
                shutil.rmtree(scratch, ignore_errors=True)
        return {"case": case, "status": "baked", "was": state, "organs": len(manifest["organs"]),
                "bytes": _folder_bytes(case_dir)}
    except Exception as exc:                                     # one bad scan must not stop the run
        return {"case": case, "status": "error", "error": f"{type(exc).__name__}: {exc}"}


def free_gb(path: str) -> float:
    return shutil.disk_usage(path).free / 1e9


def run(jobs: List[tuple], workers: int, mesh_root: str, min_free_gb: float,
        log=print, stop_file: Optional[str] = None) -> Dict[str, object]:
    """Bake every job; returns the totals. Stops submitting when the disk falls under ``min_free_gb`` or
    when ``stop_file`` exists (finished cases are kept, in-flight ones finish)."""
    totals = {"baked": 0, "skipped": 0, "error": 0, "bytes": 0, "stopped_for_disk": False,
              "stopped_by_file": False, "errors": []}

    def should_stop() -> bool:
        if stop_file and os.path.exists(stop_file):
            totals["stopped_by_file"] = True
            return True
        if free_gb(mesh_root) < min_free_gb:
            totals["stopped_for_disk"] = True
            return True
        return False

    started = time.monotonic()
    done = 0

    def absorb(result: dict) -> None:
        nonlocal done
        done += 1
        status = result["status"]
        totals[status] = totals.get(status, 0) + 1
        if status == "baked":
            totals["bytes"] += result.get("bytes", 0)
        if status == "error":
            totals["errors"].append(result)
            log(f"  [error] {result['case']}: {result['error']}")
        if done % 25 == 0 or done == len(jobs):
            rate = done / max(time.monotonic() - started, 1e-9)
            log(f"  {done}/{len(jobs)}  baked={totals['baked']} skipped={totals['skipped']} error={totals['error']}"
                f"  ({rate:.2f} cases/s, {totals['bytes'] / 1e9:.1f} GB written, {free_gb(mesh_root):.0f} GB free)")

    if workers <= 1:
        for job in jobs:
            if should_stop():
                break
            absorb(bake_case(job))
        return totals
    # Submit in small waves so a full disk stops the run instead of finishing a queue of thousands.
    wave = max(workers * 2, 4)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for start in range(0, len(jobs), wave):
            if should_stop():
                break
            for result in pool.map(bake_case, jobs[start:start + wave]):
                absorb(result)
    return totals


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Bake the 3D meshes of a dataset ahead of time.")
    ap.add_argument("--dataset", choices=DATASETS, required=True)
    ap.add_argument("--data-root", help="folder holding mask_only/ (default: the dataset's configured path)")
    ap.add_argument("--mesh-root", help="where the case folders are written (default: MESH_PATH)")
    ap.add_argument("--only", nargs="*", help="bake just these case ids")
    ap.add_argument("--limit", type=int, help="only the first N cases (for a trial)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--force", action="store_true", help="rebake cases that already have meshes")
    ap.add_argument("--refresh-legacy", action="store_true",
                    help="also rebake meshes baked before the viewer's organ numbering")
    ap.add_argument("--min-free-gb", type=float, default=100.0, help="stop when the disk has less free than this")
    ap.add_argument("--stop-file", help="stop cleanly (finished cases are kept) once this file exists")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    root = mask_root(args.dataset, args.data_root)
    from constants import Constants
    mesh_root = args.mesh_root or Constants.MESH_PATH
    cases = list_cases(args.dataset, root, args.only)
    if args.limit:
        cases = cases[:args.limit]
    jobs = [(args.dataset, case, root, mesh_root, args.force, args.refresh_legacy) for case in cases]
    print(f"{args.dataset}: {len(cases)} cases with a mask under {root}\n  meshes -> {mesh_root}", flush=True)

    if args.dry_run:
        todo = [case for case in cases
                if args.force or manifest_state(os.path.join(mesh_root, case),
                                                os.path.join(root, "mask_only", case, MASK_NAME),
                                                args.refresh_legacy) != "ok"]
        print(f"  would bake {len(todo)} of {len(cases)} (rest already have current meshes)")
        for case in todo[:20]:
            print("   ", case)
        return 0

    os.makedirs(mesh_root, exist_ok=True)
    totals = run(jobs, args.workers, mesh_root, args.min_free_gb, stop_file=args.stop_file)
    print(f"DONE baked={totals['baked']} skipped={totals['skipped']} error={totals['error']} "
          f"written={totals['bytes'] / 1e9:.1f} GB", flush=True)
    if totals["stopped_by_file"]:
        print(f"STOPPED by {args.stop_file}. Remove it and run again to continue; finished cases are skipped.", flush=True)
        return 3
    if totals["stopped_for_disk"]:
        print(f"STOPPED: less than {args.min_free_gb:g} GB free under {mesh_root}. Free space (or move meshes to "
              f"the shared drive) and run again; finished cases are skipped.", flush=True)
        return 2
    return 1 if totals["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
