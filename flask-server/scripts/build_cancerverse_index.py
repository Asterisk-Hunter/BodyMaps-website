#!/usr/bin/env python3
r"""Build the CancerVerse case index: which organs have an annotated tumor in each scan.

Search needs a tumor type per CancerVerse scan (PanTS tumors are all pancreatic; CancerVerse
annotates 13 organs). The answer lives in the released per-lesion masks:
``CancerVerse/CV_########/segmentations/<organ>_lesion.nii.gz``, 13 files per scan, almost
all of them empty. This reads the label archive once and writes a small JSON:

    {"version": 1, "cases": {"CV_00000001": {"tumors": ["liver", "kidney"],
                                           "volumes_ml": {"liver": 12.3, "kidney": 0.4},
                                           "shape": [..], "spacing": [..]}}}

``tumors`` lists the organs with an annotated tumor, largest first; ``volumes_ml`` gives each
volume. ``shape`` / ``spacing`` come from the mask header (the mask grid is the CT grid).
Output goes to $CANCERVERSE_OVERLAY_PATH/cancerverse_case_index.json (or CANCERVERSE_INDEX_FILE).

How it stays fast without guessing. Decompressing all 13 full-CT masks of every scan takes
hours. Masks that were never touched are written by one tool, so every such EMPTY mask of a
scan has exactly the same compressed size. A mask that differs in size was TOUCHED by an
annotator, but touched does not mean tumor: annotations that were later erased are saved as
all-zero volumes with a different, larger size (about 4% of touched masks in the real data).
So every touched mask is decompressed and counted, and the untouched ones are skipped.
To prove that skip is safe, every --qc-every-th scan also has its untouched masks verified
(they share a gzip CRC32 + size trailer, so one decompression per identical group proves
the group): any tumor found in an untouched mask is counted and the run exits non-zero.
--exact decompresses every mask of every scan instead (slowest, makes no assumption).

Usage:
    python scripts/build_cancerverse_index.py --labels CancerVerse_Label.tar.gz \
        --out /home/visitor/cancerverse_v351/cancerverse_case_index.json --workers 4
    python scripts/build_cancerverse_index.py --labels-dir /path/to/CancerVerse ...   # extracted
Read-only on the inputs; writes only --out.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import struct
import sys
import tarfile
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from typing import Dict, Iterator, List, Optional, Tuple

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from services.cancerverse_catalog import LESION_TYPES  # noqa: E402

DTYPES = {2: "u1", 4: "<i2", 8: "<i4", 16: "<f4", 64: "<f8", 256: "i1", 512: "<u2", 768: "<u4"}


def parse_header(first: bytes) -> dict:
    """Fields of a NIfTI-1 header (first 348+ bytes of the decompressed file)."""
    if len(first) < 352:
        raise ValueError("NIfTI header is truncated")
    endian = "<" if struct.unpack("<i", first[0:4])[0] == 348 else ">"
    if endian == ">" and struct.unpack(">i", first[0:4])[0] != 348:
        raise ValueError("not a NIfTI-1 file")
    dim = struct.unpack(endian + "8h", first[40:56])
    datatype = struct.unpack(endian + "h", first[70:72])[0]
    pixdim = struct.unpack(endian + "8f", first[76:108])
    vox_offset = struct.unpack(endian + "f", first[108:112])[0]
    slope, inter = struct.unpack(endian + "2f", first[112:120])
    if datatype not in DTYPES:
        raise ValueError(f"unsupported NIfTI datatype {datatype}")
    if not slope or not np.isfinite(slope):
        slope, inter = 1.0, 0.0
    ndim = max(1, min(int(dim[0]), 3))
    shape = [int(d) for d in dim[1:1 + ndim]]
    return {"endian": endian, "shape": shape, "spacing": [float(p) for p in pixdim[1:1 + ndim]],
            "dtype": np.dtype(DTYPES[datatype]).newbyteorder("<" if endian == "<" else ">"),
            "slope": float(slope), "inter": float(inter), "offset": int(vox_offset) or 352}


def read_header(gz_bytes: bytes) -> dict:
    return parse_header(zlib.decompressobj(31).decompress(gz_bytes[:65536], 352))


def _decompressed_chunks(gz_bytes: bytes) -> Iterator[bytes]:
    """Decompressed pieces, fed in 64 KB slices so memory stays bounded (zeros expand ~1000x)."""
    d = zlib.decompressobj(31)
    for i in range(0, len(gz_bytes), 65536):
        out = d.decompress(gz_bytes[i:i + 65536])
        if out:
            yield out
    out = d.flush()
    if out:
        yield out


def count_foreground(gz_bytes: bytes) -> Tuple[int, dict]:
    """Number of voxels whose decoded value is above 0.5, streaming (bounded memory)."""
    head, pending = b"", b""
    info, skip, total, thr, greater = None, 0, 0, 0.0, True
    for out in _decompressed_chunks(gz_bytes):
        if info is None:
            head += out
            if len(head) < 352:
                continue
            info = parse_header(head)
            skip = info["offset"]
            thr = (0.5 - info["inter"]) / info["slope"]
            greater = info["slope"] > 0
            out, head = head, b""
        if skip:
            drop = min(skip, len(out))
            out, skip = out[drop:], skip - drop
        if out:
            buf = pending + out
            usable = len(buf) - len(buf) % info["dtype"].itemsize
            pending = buf[usable:]
            arr = np.frombuffer(buf[:usable], dtype=info["dtype"])
            total += int(np.count_nonzero(arr > thr if greater else arr < thr))
    if info is None:
        raise ValueError("empty or truncated mask")
    return total, info


def _ml(voxels: int, info: dict) -> float:
    return round(voxels * float(np.prod(info["spacing"][:3])) / 1000.0, 3)


def process_case(case: str, members: Dict[str, bytes], qc: bool = False, exact: bool = False) -> dict:
    """Index one scan from its mask files (name stem -> gzip bytes)."""
    sizes = {stem: len(b) for stem, b in members.items()}
    smallest = min(sizes.values())
    compare = len(members) >= 3                 # with too few masks nothing can be compared
    volumes: Dict[str, float] = {}
    touched_without_tumor = qc_checked = qc_untouched_with_tumor = 0
    info = read_header(next(iter(members.values())))
    untouched: Dict[bytes, List[str]] = {}      # untouched masks, grouped by gzip trailer (CRC32 + size)
    for stem, raw in members.items():
        organ = LESION_TYPES.get(stem)
        if organ is None:
            continue
        is_untouched = compare and sizes[stem] == smallest
        if is_untouched and not exact:
            if qc:
                untouched.setdefault(raw[-8:], []).append(stem)
            continue
        voxels, info = count_foreground(raw)    # touched (or exact mode): decide by content
        if voxels:
            volumes[organ] = _ml(voxels, info)
        elif not is_untouched:
            touched_without_tumor += 1          # an annotation that was erased
    # Untouched masks with the same size AND the same CRC32/size trailer hold identical data,
    # so decompressing one per group proves the whole group is empty.
    for stems in untouched.values():
        voxels, info = count_foreground(members[stems[0]])
        qc_checked += len(stems)
        if voxels:
            qc_untouched_with_tumor += len(stems)
            for stem in stems:
                volumes[LESION_TYPES[stem]] = _ml(voxels, info)
    ordered = sorted(volumes, key=lambda o: (-volumes[o], o))
    return {"case": case, "tumors": ordered, "volumes_ml": {o: volumes[o] for o in ordered},
            "shape": info["shape"], "spacing": [round(x, 4) for x in info["spacing"]],
            "touched_without_tumor": touched_without_tumor,
            "qc_checked": qc_checked, "qc_untouched_with_tumor": qc_untouched_with_tumor}


def iter_cases_from_tar(path: str) -> Iterator[Tuple[str, Dict[str, bytes]]]:
    """Cases in archive order; a case's masks are contiguous (flushed when the case changes)."""
    cur, members = None, {}
    with tarfile.open(path, mode="r|gz") as tf:
        for m in tf:
            if not (m.isfile() and m.name.endswith(".nii.gz")):
                continue
            parts = m.name.split("/")
            if len(parts) < 3 or parts[-2] != "segmentations":
                continue
            case, stem = parts[-3], parts[-1][:-7]
            if case != cur:
                if cur is not None and members:
                    yield cur, members
                cur, members = case, {}
            members[stem] = tf.extractfile(m).read()
    if cur is not None and members:
        yield cur, members


def iter_cases_from_dir(root: str) -> Iterator[Tuple[str, Dict[str, bytes]]]:
    for case in sorted(os.listdir(root)):
        seg = os.path.join(root, case, "segmentations")
        if not os.path.isdir(seg):
            continue
        members = {}
        for name in sorted(os.listdir(seg)):
            if name.endswith(".nii.gz"):
                with open(os.path.join(seg, name), "rb") as f:
                    members[name[:-7]] = f.read()
        if members:
            yield case, members


def build_index(cases: Iterator[Tuple[str, Dict[str, bytes]]], workers: int = 1, qc_every: int = 50,
                exact: bool = False, progress_every: int = 1000) -> dict:
    results: Dict[str, dict] = {}
    started = time.time()

    def absorb(res: dict):
        prev = results.get(res["case"])
        if prev:                                       # same case seen twice: merge, never drop
            merged = {**prev["volumes_ml"], **res["volumes_ml"]}
            res["tumors"] = sorted(merged, key=lambda o: (-merged[o], o))
            res["volumes_ml"] = {o: merged[o] for o in res["tumors"]}
            for key in ("touched_without_tumor", "qc_checked", "qc_untouched_with_tumor"):
                res[key] += prev[key]
        results[res["case"]] = res

    def is_qc(i: int) -> bool:
        return bool(qc_every) and i % qc_every == 0

    if workers <= 1:
        for i, (case, members) in enumerate(cases):
            absorb(process_case(case, members, is_qc(i), exact))
            if progress_every and (i + 1) % progress_every == 0:
                print(f"{i + 1} scans, {time.time() - started:.0f}s", flush=True)
    else:
        pending: List = []
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for i, (case, members) in enumerate(cases):
                pending.append(pool.submit(process_case, case, members, is_qc(i), exact))
                if len(pending) >= workers * 8:        # bounded memory: wait for the oldest
                    absorb(pending.pop(0).result())
                if progress_every and (i + 1) % progress_every == 0:
                    print(f"{i + 1} scans read, {time.time() - started:.0f}s", flush=True)
            for fut in pending:
                absorb(fut.result())

    out_cases = {case: {"tumors": r["tumors"], "volumes_ml": r["volumes_ml"], "shape": r["shape"], "spacing": r["spacing"]}
                 for case, r in sorted(results.items())}
    return {"version": 1, "mode": "exact" if exact else "checked",
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "scans": len(out_cases), "scans_with_tumor": sum(1 for c in out_cases.values() if c["tumors"]),
            "touched_masks_without_tumor": sum(r["touched_without_tumor"] for r in results.values()),
            "qc": {"untouched_masks_verified": sum(r["qc_checked"] for r in results.values()),
                   "untouched_masks_with_tumor": sum(r["qc_untouched_with_tumor"] for r in results.values())},
            "cases": out_cases}


def missing_scans(metadata_csv: str, index: dict) -> Tuple[List[str], int]:
    """(scan ids listed in the metadata CSV's first column that the index lacks, number of CSV scans)."""
    with open(metadata_csv, newline="", encoding="utf-8-sig") as f:
        rows = csv.reader(f)
        next(rows, None)                                # header
        ids = [row[0].strip() for row in rows if row and row[0].strip()]
    return [i for i in ids if i not in index["cases"]], len(ids)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--labels", help="CancerVerse_Label.tar.gz")
    src.add_argument("--labels-dir", help="extracted label folder containing CV_########/segmentations/")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--exact", action="store_true", help="decompress every mask of every scan (slowest)")
    ap.add_argument("--qc-every", type=int, default=50,
                    help="verify the untouched masks of every Nth scan (0 = off)")
    ap.add_argument("--metadata", help="metadata CSV (first column: CancerVerse ID). The index is NOT written if "
                                       "too many of its scans are missing from the labels, which is what a "
                                       "truncated archive looks like (tarfile ends quietly at a cut)")
    ap.add_argument("--max-missing", type=float, default=0.005,
                    help="largest tolerated fraction of --metadata scans without labels (default 0.5%%)")
    args = ap.parse_args(argv)
    cases = iter_cases_from_tar(args.labels) if args.labels else iter_cases_from_dir(args.labels_dir)
    index = build_index(cases, workers=max(1, args.workers), qc_every=max(0, args.qc_every), exact=args.exact)
    if args.metadata:
        missing, listed = missing_scans(args.metadata, index)
        print(f"{len(missing)} scans in the metadata have no label folder in the archive"
              + (f" (e.g. {', '.join(missing[:3])})" if missing else ""))
        if not index["cases"] or len(missing) > args.max_missing * listed:
            print(f"ERROR: too many scans are missing (limit {args.max_missing:.1%}); the archive looks incomplete. "
                  f"Index NOT written.", file=sys.stderr)
            return 2
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))
    os.replace(tmp, args.out)                          # readers never see a half-written file
    qc = index["qc"]
    print(f"INDEX_DONE {index['scans']} scans, {index['scans_with_tumor']} with a tumor ({index['mode']} mode); "
          f"{index['touched_masks_without_tumor']} touched masks held no tumor (erased annotations); "
          f"QC: {qc['untouched_masks_verified']} untouched masks verified, {qc['untouched_masks_with_tumor']} held a tumor")
    return 1 if qc["untouched_masks_with_tumor"] else 0


if __name__ == "__main__":
    sys.exit(main())
