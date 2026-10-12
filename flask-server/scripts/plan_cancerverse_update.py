#!/usr/bin/env python3
"""Work out which CancerVerse CTs must be downloaded to bring the server copy up to date.

The server copy lives on a read-only mount, so this only READS it (a file-size listing)
and the public Hugging Face file list, and writes a plan file for stage_cancerverse_update.sh.

    # on the server (read-only listing of the existing copy):
    cd /mnt/bodymaps/zzhou82/data/CancerVerse/image_only && \\
        find . -maxdepth 2 -name ct.nii.gz -printf '%P %s\\n' > /tmp/server_ct_sizes.txt
    # anywhere with internet:
    python scripts/plan_cancerverse_update.py --server-sizes /tmp/server_ct_sizes.txt --out plan.tsv

plan.tsv columns: case_id <TAB> bytes <TAB> sha256 (the Hugging Face LFS object id).
A scan is in the plan when it is NEW (not on the server) or its size DIFFERS from the
published file (the dataset notes say problematic CTs were fixed). A scan whose size is
unchanged is treated as unchanged; this is a size comparison, not a content check.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from typing import Dict, Tuple

REPO = "BodyMaps/CancerVerse"
API = "https://huggingface.co/api/datasets/" + REPO


def hf_ct_files(revision: str, retries: int = 6) -> Dict[str, Tuple[int, str]]:
    """{case_id: (bytes, sha256)} for every CT at the pinned revision (paginated tree API)."""
    url = f"{API}/tree/{revision}/CancerVerse?recursive=true&limit=1000"
    out: Dict[str, Tuple[int, str]] = {}
    while url:
        for attempt in range(retries):
            try:
                resp = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bodymaps-plan/1"}), timeout=120)
                break
            except Exception:
                if attempt == retries - 1:
                    raise
                time.sleep(15 * (attempt + 1))
        for entry in json.loads(resp.read()):
            path = entry.get("path", "")
            if entry.get("type") == "file" and path.endswith("/ct.nii.gz"):
                lfs = entry.get("lfs") or {}
                out[path.split("/")[1]] = (int(entry.get("size") or 0), lfs.get("oid") or "")
        match = re.search(r'<([^>]+)>;\s*rel="next"', resp.headers.get("Link", ""))
        url = match.group(1) if match else None
        time.sleep(1)                                   # polite to the hub
    return out


def read_server_sizes(path: str) -> Dict[str, int]:
    """Parse '<CV id>/ct.nii.gz <bytes>' lines (extra columns ignored)."""
    sizes: Dict[str, int] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                sizes[parts[0].split("/")[0]] = int(parts[1])
    return sizes


def build_plan(published: Dict[str, Tuple[int, str]], server: Dict[str, int]) -> Tuple[list, dict]:
    new = sorted(c for c in published if c not in server)
    changed = sorted(c for c in published if c in server and published[c][0] != server[c])
    server_only = sorted(c for c in server if c not in published)
    plan = [(c, published[c][0], published[c][1]) for c in new + changed]
    summary = {"published": len(published), "on_server": len(server), "unchanged": len(published) - len(new) - len(changed),
               "new": len(new), "changed": len(changed), "server_only": len(server_only),
               "download_bytes": sum(p[1] for p in plan)}
    return plan, summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--server-sizes", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--revision", default="main", help="HF revision to plan against; pass a commit sha to pin it")
    args = ap.parse_args(argv)
    plan, summary = build_plan(hf_ct_files(args.revision), read_server_sizes(args.server_sizes))
    missing_hash = [c for c, _, sha in plan if not sha]
    if missing_hash:
        print(f"ERROR: {len(missing_hash)} planned files have no published sha256 (first: {missing_hash[0]})", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8") as f:
        for case, size, sha in plan:
            f.write(f"{case}\t{size}\t{sha}\n")
    print(json.dumps(summary), file=sys.stderr)
    if summary["server_only"]:
        print(f"NOTE: {summary['server_only']} scans exist only on the server (not in this release); left alone.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
