#!/usr/bin/env python3
"""Review a real pipeline in a new, isolated output directory.

Without --execute this only reports preflight availability. It never imports
Flask, loads a deployment .env, changes a database, or restarts services.
Execution still uses the local machine's GPU/CPU and requires a quiet window.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import threading
import time
import uuid
import zipfile


MODELS = ("ePAI", "Atlas-Net", "LesionSegmenter")
# Whole-organ viewer IDs supported by ShapeKit. Every other positive label is
# protected; in particular, lesions and pancreas subregions are not refined.
REFINABLE_LABELS = frozenset({1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 23, 24, 25, 26, 29})


def _local_only():
    # These must precede every application import, including in injected tests.
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.environ["GPU_WORKERS_ENABLED"] = "false"
    os.environ["EPAI_REMOTE_ENABLED"] = "false"
    os.environ["EPAI_SCRIPT_PATH"] = ""
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True


def _pipeline_module():
    _local_only()
    root = str(Path(__file__).resolve().parents[1])
    if root not in sys.path:
        sys.path.insert(0, root)
    return importlib.import_module("services.inference_pipeline")


def _real_adapter():
    _local_only()
    # Also prevent .env loading with older python-dotenv installations that do
    # not yet honor PYTHON_DOTENV_DISABLED. The adapter imports this function.
    import dotenv
    original = dotenv.load_dotenv
    dotenv.load_dotenv = lambda *args, **kwargs: False
    try:
        return importlib.import_module("services.auto_segmentor")
    finally:
        dotenv.load_dotenv = original


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _save(path, payload):
    descriptor, name = tempfile.mkstemp(prefix=".review-", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _availability(model, pipeline):
    if model in ("OpenVAE", "ShapeKit"):
        return pipeline.stage_availability(model)
    prefix, environment = {
        "ePAI": ("EPAI", "CONDA_ENV_EPAI"),
        "Atlas-Net": ("ATLASNET", "CONDA_ENV_ATLASNET"),
        "LesionSegmenter": ("LESIONSEG", "CONDA_ENV_LESIONSEG"),
    }[model]
    configured = os.getenv(f"{prefix}_CKPT_PATH", "").strip()
    if not configured:
        return False, f"Pass the approved {prefix}_CKPT_PATH explicitly; review does not load production .env."
    checkpoint = Path(configured)
    if not (checkpoint / "dataset.json").is_file() or not (checkpoint / "plans.json").is_file():
        return False, "Model dataset.json or plans.json is missing."
    name = os.getenv("EPAI_CHECKPOINT_NAME", "checkpoint_final.pth") if model == "ePAI" else "checkpoint_final.pth"
    if not any(checkpoint.glob(f"fold_*/{name}")):
        return False, "No configured model fold checkpoint is installed."
    if not pipeline._environment_present(os.getenv(environment, "epai")):
        return False, "The selected model runtime is not installed."
    return True, None


def _isolated_runtime(output):
    for name, directory in {
        "XDG_CACHE_HOME": "cache", "TORCH_HOME": "cache/torch", "HF_HOME": "cache/huggingface",
        "MPLCONFIGDIR": "cache/matplotlib", "CUDA_CACHE_PATH": "cache/cuda",
        "TMPDIR": "temp", "TMP": "temp", "TEMP": "temp",
    }.items():
        path = output / directory
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    # Checkpoint paths remain caller-configured read-only inputs. Prediction
    # scratch directories belong solely to this review.
    for prefix in ("EPAI", "ATLASNET", "LESIONSEG"):
        for suffix in ("RAW", "PREPROCESSED", "RESULTS"):
            path = output / "scratch" / prefix.lower() / suffix.lower()
            path.mkdir(parents=True, exist_ok=True)
            os.environ[f"{prefix}_NNUNET_{suffix}"] = str(path)


def _inside(path, output):
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(output):
        raise ValueError("An adapter returned an artifact outside the isolated review directory.")
    return resolved


def _protected_labels(raw_path, final_path):
    import nibabel as nib
    import numpy as np
    raw = np.asanyarray(nib.load(str(raw_path)).dataobj)
    final = np.asanyarray(nib.load(str(final_path)).dataobj)
    protected = (set(np.unique(raw)) | set(np.unique(final))) - REFINABLE_LABELS - {0}
    for label in protected:
        if not np.array_equal(raw == label, final == label):
            raise ValueError(f"Refinement changed protected viewer label {int(label)}.")
    return sorted(int(label) for label in protected)


def review(input_path, output, model, preprocessing=None, postprocessing=None, *,
           execute=False, dispatch=None, cancel_session=None, availability=None,
           pipeline_module=None):
    """Inject dispatch/cancel/availability for tests; real execution is opt-in."""
    _local_only()
    pipeline = pipeline_module or _pipeline_module()
    import nibabel as nib

    if model not in MODELS or preprocessing not in (None, "OpenVAE") or postprocessing not in (None, "ShapeKit"):
        raise ValueError("Unsupported model or optional pipeline selection.")
    input_path = Path(input_path).expanduser().resolve(strict=True)
    requested_output = Path(output).expanduser()
    output = requested_output.resolve()
    if input_path.is_relative_to(output):
        raise ValueError("The output directory cannot contain the input scan.")
    if requested_output.exists() or requested_output.is_symlink() or output.exists():
        raise FileExistsError("The output directory already exists; choose a new directory.")
    if not output.parent.is_dir():
        raise ValueError("Create the isolated review parent directory first.")
    if not input_path.is_file() or not input_path.name.lower().endswith((".nii", ".nii.gz")):
        raise ValueError("Input must be an existing NIfTI (.nii or .nii.gz) file.")
    header = nib.load(str(input_path))
    if len(header.shape) < 3 or any(n <= 1 for n in header.shape[:3]) or any(n != 1 for n in header.shape[3:]):
        raise ValueError("Input must be one three-dimensional CT volume.")
    check_available = availability or (lambda item: _availability(item, pipeline))
    available = []
    for item in (preprocessing, model, postprocessing):
        if item:
            ready, reason = check_available(item)
            available.append({"model": item, "available": bool(ready), "reason": reason})
    preflight = {"mode": "preflight", "execute": False, "local_only": True,
                 "available": all(item["available"] for item in available), "models": available,
                 "output_created": False}
    if not execute:
        return preflight
    if not preflight["available"]:
        raise ValueError("Preflight is unavailable; install/configure the explicitly selected models before execution.")
    selected = pipeline.selection(model, preprocessing, postprocessing)
    # Atomic ownership claim. No existing directory is reused or removed.
    output.mkdir(mode=0o700)
    session_id = "review-" + uuid.uuid4().hex
    stopped = threading.Event()
    started = time.perf_counter()
    state = {"version": 1, "session_id": session_id, "status": "running", "started_at": _now(),
             "completed_at": None, "pipeline": selected, "pipeline_stages": pipeline.initial_stages(selected),
             "adapter_timings_seconds": [], "checks": {}, "artifacts": {},
             "input_sha256": None, "error": None, "accuracy_validated": False}
    state_path = output / "review.json"
    staged = None
    source_hash = None
    previous_handlers = {}
    cancel_threads = []
    published_archive = None
    cancel = cancel_session or (lambda _session: False)

    def save():
        state["elapsed_seconds"] = time.perf_counter() - started
        _save(state_path, state)

    def publish(**fields):
        state.update(copy.deepcopy(fields))
        save()

    def request_cancel(signum=None, _frame=None):
        if stopped.is_set():
            return
        stopped.set()
        state["cancel_signal"] = signum
        # The main thread may be interrupted while the adapter holds its lock;
        # acquire that lock from another thread rather than deadlocking here.
        thread = threading.Thread(target=cancel, args=(session_id,), daemon=True)
        cancel_threads.append(thread)
        thread.start()

    def check_cancelled():
        if stopped.is_set():
            raise pipeline.PipelineCancelled("Review cancelled by signal")

    try:
        save()
        _isolated_runtime(output)
        if dispatch is None:
            adapter = _real_adapter()
            dispatch, cancel = adapter.run_auto_segmentation, adapter.cancel_session
        if threading.current_thread() is not threading.main_thread():
            raise ValueError("Run the review on the main thread so cancellation signals can be handled.")
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, request_cancel)

        source_hash = _sha256(input_path)
        state["input_sha256"] = source_hash
        staged_dir = output / "input"
        staged_dir.mkdir()
        staged = staged_dir / ("original.nii.gz" if input_path.name.lower().endswith(".gz") else "original.nii")
        with input_path.open("rb") as source, staged.open("xb") as target:
            shutil.copyfileobj(source, target)
        if _sha256(staged) != source_hash:
            raise ValueError("The input changed while it was copied; no inference was started.")
        pipeline.validate_grid(staged, staged)
        check_cancelled()

        def measured_dispatch(source, **kwargs):
            tick = time.perf_counter()
            try:
                result = dispatch(source, **kwargs)
                return str(_inside(result, output)) if result else result
            finally:
                state["adapter_timings_seconds"].append({"model": kwargs["model"], "seconds": time.perf_counter() - tick})

        final, reconstruction, stages = pipeline.run_pipeline(
            input_path=str(staged), session_dir=str(output), session_id=session_id,
            pipeline=selected, dispatch=measured_dispatch, publish=publish,
            cancelled=stopped.is_set, on_start=lambda: not stopped.is_set(),
        )
        final = _inside(final, output)
        final_mask = _inside(final / "combined_labels.nii.gz", output)
        pipeline.validate_grid(final_mask, staged, labels=True)
        state["checks"]["final_geometry"] = True
        if reconstruction:
            reconstruction = _inside(reconstruction, output)
            pipeline.validate_grid(reconstruction, staged)
            state["checks"]["reconstruction_geometry"] = True
            state["artifacts"]["reconstruction"] = str(reconstruction.relative_to(output))
        if postprocessing:
            raw_mask = _inside(final / "segmentation_original/combined_labels.nii.gz", output)
            state["checks"]["protected_labels"] = _protected_labels(raw_mask, final_mask)
            state["checks"]["protected_labels_preserved"] = True
            if any(final.glob("*.csv")):
                raise ValueError("A refined result contains unlabelled raw CSV measurements at its root.")
        state["checks"]["original_unchanged"] = _sha256(input_path) == source_hash
        state["checks"]["staged_original_unchanged"] = _sha256(staged) == source_hash
        if not all(state["checks"][key] for key in ("original_unchanged", "staged_original_unchanged")):
            raise ValueError("Original CT bytes changed during processing.")
        check_cancelled()
        provenance = {"input_sha256": source_hash, "final_mask_sha256": _sha256(final_mask),
                      "pipeline": selected, "checks": state["checks"], "accuracy_validated": False,
                      "raw_measurements": "segmentation_original" if postprocessing else None}
        _save(final / "review-provenance.json", provenance)
        temporary_zip = output / "results.zip.part"
        archive = output / "results.zip"
        try:
            with zipfile.ZipFile(temporary_zip, "x", compression=zipfile.ZIP_DEFLATED) as package:
                for item in sorted(final.rglob("*")):
                    check_cancelled()
                    if item.is_file():
                        _inside(item, output)
                        if item.name.endswith((".nii.gz", ".nii", ".csv", ".json")):
                            package.write(item, item.relative_to(final).as_posix())
            check_cancelled()
            os.link(temporary_zip, archive)
            published_archive = archive
        finally:
            temporary_zip.unlink(missing_ok=True)
        check_cancelled()
        state["pipeline_stages"] = pipeline.finish_packaging(stages)
        state["artifacts"].update(final_directory=str(final.relative_to(output)), archive=archive.name,
                                   final_mask=str(final_mask.relative_to(output)))
        state["status"] = "completed"
    except (Exception, KeyboardInterrupt) as error:
        if isinstance(error, KeyboardInterrupt):
            request_cancel(signal.SIGINT)
        cancelled = stopped.is_set() or isinstance(error, pipeline.PipelineCancelled)
        state["status"] = "cancelled" if cancelled else "failed"
        state["error"] = "Review cancelled" if cancelled else str(error)
        state["pipeline_stages"] = pipeline.finish_packaging(
            state["pipeline_stages"], error=state["error"], cancelled=cancelled)
        if published_archive is not None:
            published_archive.unlink(missing_ok=True)
    finally:
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
        for thread in cancel_threads:
            thread.join(timeout=6)
        # Record input preservation even on a failed/cancelled pipeline.
        if source_hash is not None:
            for key, path in (("original_unchanged", input_path), ("staged_original_unchanged", staged)):
                try:
                    state["checks"][key] = path is not None and _sha256(path) == source_hash
                except OSError:
                    state["checks"][key] = False
            if state["status"] == "completed" and not all(state["checks"][key] for key in ("original_unchanged", "staged_original_unchanged")):
                state["status"], state["error"] = "failed", "Original CT changed before review completion."
        state["completed_at"] = _now()
        save()
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New directory below an existing isolated parent.")
    parser.add_argument("--model", required=True, choices=MODELS)
    parser.add_argument("--preprocessing", choices=("OpenVAE",))
    parser.add_argument("--postprocessing", choices=("ShapeKit",))
    parser.add_argument("--execute", action="store_true", help="Explicitly allow real local GPU/CPU computation.")
    args = parser.parse_args(argv)
    try:
        result = review(args.input, args.output, args.model, args.preprocessing, args.postprocessing, execute=args.execute)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "rejected", "error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    if result.get("status") == "cancelled":
        return 130
    return 0 if result.get("status") == "completed" or result.get("mode") == "preflight" and result["available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
