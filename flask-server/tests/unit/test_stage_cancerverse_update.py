"""Staging flow end to end against a local fake Hugging Face (no network, no real dataset)."""
import functools
import hashlib
import http.server
import io
import os
import shutil
import subprocess
import sys
import tarfile
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))
import plan_cancerverse_update as plan_mod  # noqa: E402
from .test_build_cancerverse_index import case_masks  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "stage_cancerverse_update.sh")


def _bash():
    path = shutil.which("bash")
    if not path or "system32" in path.lower().replace("\\", "/") or not shutil.which("curl") or not shutil.which("sha256sum"):
        pytest.skip("needs a POSIX bash with curl and sha256sum")
    return path


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture
def hub(tmp_path):
    """A fake hub: <root>/main/CancerVerse/<id>/ct.nii.gz, the CSV, and the label archive."""
    root = tmp_path / "hub"
    files = {"CV_00000001": b"first CT bytes" * 500, "CV_00000002": b"second CT" * 900}
    for case, data in files.items():
        d = root / "main" / "CancerVerse" / case
        d.mkdir(parents=True)
        (d / "ct.nii.gz").write_bytes(data)
    (root / "main" / "CancerVerse_dataset_metadata.csv").write_text("CancerVerse ID,sex\nCV_00000001,M\n")
    with tarfile.open(root / "labels.tar.gz", "w:gz") as tf:
        for case in files:
            for stem, raw in case_masks({"liver_lesion": 20} if case == "CV_00000001" else {}).items():
                info = tarfile.TarInfo(f"CancerVerse/CancerVerse/{case}/segmentations/{stem}.nii.gz")
                info.size = len(raw)
                tf.addfile(info, io.BytesIO(raw))
    handler = functools.partial(QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield {"url": f"http://127.0.0.1:{server.server_address[1]}", "files": files, "root": root}
    server.shutdown()


def write_plan(path, files, corrupt=None):
    with open(path, "w", newline="\n") as f:
        lines = []
        for case, data in files.items():
            sha = hashlib.sha256(data).hexdigest()
            if case == corrupt:
                sha = "0" * 64
            lines.append(f"{case}\t{len(data)}\t{sha}")
        f.write("\n".join(lines))                     # no trailing newline on purpose


def run(hub, plan, overlay, **env):
    full = {**os.environ, "HF_BASE": hub["url"], "LABELS_URL": hub["url"] + "/labels.tar.gz", "MIN_FREE_GB": "0",
            "FETCH_DELAY": "0", "RETRY_DELAY": "0", "PYTHON": sys.executable, "WORKERS": "1",
            "MAKE_PREVIEWS": "0", **env}
    return subprocess.run([_bash(), SCRIPT, str(plan).replace("\\", "/"), str(overlay).replace("\\", "/")],
                          capture_output=True, text=True, env=full, timeout=120)


def test_stages_verified_cts_then_index_then_metadata(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    result = run(hub, plan, overlay)
    assert result.returncode == 0, result.stdout + result.stderr
    for case, data in hub["files"].items():                       # last plan line has no newline: still staged
        assert (overlay / "image_only" / case / "ct.nii.gz").read_bytes() == data
    assert (overlay / "CancerVerse_dataset_metadata.csv").exists()
    from services import cancerverse_catalog as cv
    index = cv.load_case_index(str(overlay / "cancerverse_case_index.json"))
    assert cv.tumor_types_for_case(index["CV_00000001"]) == ("liver",)
    assert cv.tumor_types_for_case(index["CV_00000002"]) == ()
    assert "CANCERVERSE_OVERLAY_PATH" in result.stdout           # it tells the operator the next step
    assert not list(overlay.rglob("*.part"))
    # the viewer's tumor mask is built for the scan that has a tumor, and only for it
    assert (overlay / "mask_only" / "CV_00000001" / "combined_labels.nii.gz").exists()
    assert not (overlay / "mask_only" / "CV_00000002").exists()


def test_masks_can_be_skipped_and_a_failure_does_not_block_publishing(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    skipped = run(hub, plan, overlay, MAKE_MASKS="0")
    assert skipped.returncode == 0, skipped.stdout + skipped.stderr
    assert not (overlay / "mask_only").exists()
    assert (overlay / "CancerVerse_dataset_metadata.csv").exists()
    plan2, overlay2 = tmp_path / "plan2.tsv", tmp_path / "overlay2"
    write_plan(plan2, hub["files"])
    # a python that cannot run the mask builder: the step warns and the CSV is still published
    broken = tmp_path / "py.sh"
    exe = sys.executable.replace(chr(92), '/')
    broken.write_text(
        "#!/bin/bash\n"
        'case "$1" in *build_cancerverse_masks.py) exit 3;; esac\n'
        f'exec "{exe}" "$@"\n'
    )
    broken.chmod(0o755)
    result = run(hub, plan2, overlay2, PYTHON=str(broken).replace("\\", "/"))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WARNING: building the tumor masks" in result.stdout
    assert (overlay2 / "CancerVerse_dataset_metadata.csv").exists()


def test_rerun_skips_finished_files(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    assert run(hub, plan, overlay).returncode == 0
    (hub["root"] / "main" / "CancerVerse" / "CV_00000001" / "ct.nii.gz").unlink()   # hub would now 404 if asked again
    assert run(hub, plan, overlay).returncode == 0


def test_a_corrupt_download_is_discarded_and_the_metadata_is_not_published(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"], corrupt="CV_00000002")
    result = run(hub, plan, overlay)
    assert result.returncode != 0
    assert "mismatch" in result.stdout
    assert (overlay / "image_only" / "CV_00000001" / "ct.nii.gz").exists()
    assert not (overlay / "image_only" / "CV_00000002" / "ct.nii.gz").exists()
    assert not (overlay / "CancerVerse_dataset_metadata.csv").exists()


def test_refuses_to_write_under_the_dataset_mount(hub, tmp_path):
    plan = tmp_path / "plan.tsv"
    write_plan(plan, hub["files"])
    result = run(hub, plan, "/mnt/bodymaps/zzhou82/data/CancerVerse_overlay")
    assert result.returncode != 0 and "refusing" in result.stdout + result.stderr


def test_refuses_when_there_is_not_enough_free_space(hub, tmp_path):
    plan = tmp_path / "plan.tsv"
    write_plan(plan, hub["files"])
    result = run(hub, plan, tmp_path / "overlay", MIN_FREE_GB="999999999")
    assert result.returncode != 0 and "not enough free space" in result.stdout + result.stderr
    assert not (tmp_path / "overlay" / "image_only").exists()


def test_dry_run_changes_nothing(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    result = run(hub, plan, overlay, DRY_RUN="1")
    assert result.returncode == 0 and "DRY_RUN" in result.stdout
    assert not (overlay / "image_only").exists()


def test_plan_lists_new_and_changed_scans_and_leaves_the_rest():
    published = {"CV_1": (100, "a"), "CV_2": (200, "b"), "CV_3": (300, "c"), "CV_4": (50, "d")}
    server = {"CV_1": 100, "CV_2": 999, "CV_3": 300, "CV_9": 5}
    plan, summary = plan_mod.build_plan(published, server)
    assert [p[0] for p in plan] == ["CV_4", "CV_2"]              # new first, then changed
    assert summary == {"published": 4, "on_server": 4, "unchanged": 2, "new": 1, "changed": 1,
                       "server_only": 1, "download_bytes": 250}


def test_server_size_listing_parser(tmp_path):
    listing = tmp_path / "sizes.txt"
    listing.write_text("CV_00000001/ct.nii.gz 112429739 2026-06-24\nbroken line\nCV_00000002/ct.nii.gz 99\n")
    assert plan_mod.read_server_sizes(str(listing)) == {"CV_00000001": 112429739, "CV_00000002": 99}


def fake_df(tmp_path, free_gb):
    """A `df` that reports a fixed amount of free space, to test the disk-space check."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    script = bindir / "df"
    script.write_text("#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\n"
                      f"printf 'fake 0 0 {free_gb * 1048576} 0%% /\\n'\n", newline="\n")
    script.chmod(0o755)
    return {"PATH": str(bindir).replace("\\", "/") + os.pathsep + os.environ["PATH"]}


def test_a_resumed_run_only_needs_space_for_what_is_still_missing(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    assert run(hub, plan, overlay).returncode == 0                     # everything is staged
    tight = fake_df(tmp_path, free_gb=10)
    # 10 GB free with a 10 GB floor: a fresh run (anything to fetch) must refuse ...
    fresh = run(hub, plan, tmp_path / "fresh", MIN_FREE_GB="10", **tight)
    assert fresh.returncode != 0 and "not enough free space" in fresh.stdout + fresh.stderr
    # ... but finishing a run that already has every file must not
    resumed = run(hub, plan, overlay, MIN_FREE_GB="10", **tight)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr


def test_it_stops_after_consecutive_failed_downloads(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    ghosts = {f"CV_9000000{i}": b"x" * 10 for i in range(6)}           # the hub has none of these
    write_plan(plan, ghosts)
    result = run(hub, plan, overlay, MAX_CONSECUTIVE_FAILS="2")
    assert result.returncode != 0 and "in a row failed" in result.stdout + result.stderr
    assert result.stdout.count("FAILED") == 2                           # it did not go on to try all six


def test_a_malformed_plan_is_rejected_before_anything_is_downloaded(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    sha = "a" * 64
    for bad in (f"../../etc\t5\t{sha}", f"CV_00000001\tfive\t{sha}", "CV_00000001\t5\tnothex"):
        plan.write_text(bad + "\n", newline="\n")
        result = run(hub, plan, overlay)
        assert result.returncode != 0 and "in the plan" in result.stdout + result.stderr, bad
        assert not (overlay / "image_only").exists()


@pytest.mark.parametrize("overlay", ["//mnt/bodymaps/x", "/mnt/./bodymaps/x", "/mnt//bodymaps", "/mnt/bodymaps/../bodymaps/y"])
def test_the_dataset_mount_guard_survives_odd_spellings(hub, tmp_path, overlay):
    plan = tmp_path / "plan.tsv"
    write_plan(plan, hub["files"])
    result = run(hub, plan, overlay)
    assert result.returncode != 0 and "refusing" in result.stdout + result.stderr


def test_the_index_is_checked_against_the_metadata_it_was_published_with(hub, tmp_path):
    """A label archive that lacks most of the CSV's scans is an incomplete download: nothing is published."""
    (hub["root"] / "main" / "CancerVerse_dataset_metadata.csv").write_text(
        "CancerVerse ID,sex\n" + "".join(f"CV_{i:08d},M\n" for i in range(1, 201)))
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    result = run(hub, plan, overlay)
    assert result.returncode != 0
    assert not (overlay / "cancerverse_case_index.json").exists()
    assert not (overlay / "CancerVerse_dataset_metadata.csv").exists()


def test_a_label_archive_with_the_wrong_sha256_is_rejected(hub, tmp_path):
    plan, overlay = tmp_path / "plan.tsv", tmp_path / "overlay"
    write_plan(plan, hub["files"])
    result = run(hub, plan, overlay, LABELS_SHA256="0" * 64)
    assert result.returncode != 0 and "sha256 mismatch" in result.stdout + result.stderr
    assert not (overlay / "cancerverse_case_index.json").exists()
    right = hashlib.sha256((hub["root"] / "labels.tar.gz").read_bytes()).hexdigest()
    assert run(hub, plan, overlay, LABELS_SHA256=right).returncode == 0
