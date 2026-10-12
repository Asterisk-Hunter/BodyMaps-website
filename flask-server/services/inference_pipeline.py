"""Owned, sequential inference stages using the existing model adapters.

Only explicit, compatible stages run. The caller owns admission, quota, durable
job updates, cancellation and final publication. No client supplies paths here.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import nibabel as nib
import numpy as np

SUPPORTED_MODELS = ("ePAI", "Atlas-Net", "LesionSegmenter")


class PipelineError(ValueError):
    def __init__(self, message, code="invalid_pipeline", status=400):
        super().__init__(message)
        self.code, self.status = code, status


class PipelineCancelled(RuntimeError):
    pass


def _environment_present(name):
    root = Path(os.path.expanduser(os.getenv("CONDA_ENVS_DIR", "").strip() or "~/.conda/envs"))
    candidates = [root / name / "bin" / "python", root / name / "python.exe"]
    explicit = os.getenv("CONDA_EXE_PATH", "").strip()
    if explicit:
        candidates.extend([Path(explicit).parent.parent / "envs" / name / "bin" / "python"])
    return any(path.is_file() for path in candidates)


def stage_availability(model):
    """Cheap local preflight; it does not claim a successful model smoke test."""
    if model == "OpenVAE":
        src = Path(os.getenv("OPENVAE_SRC_PATH", "/home/visitor/openvae"))
        checkpoint = Path(os.getenv("OPENVAE_CHECKPOINT_PATH", str(src / "ckpt/OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt")))
        if not (src / "test/test_3dvae.py").is_file():
            return False, "OpenVAE is not installed on this server."
        if not checkpoint.is_file():
            return False, "The actual OpenVAE weights are not installed. No substitute model will run."
        if not _environment_present(os.getenv("CONDA_ENV_OPENVAE", "openvae")):
            return False, "The OpenVAE runtime is not configured on this server."
    elif model == "ShapeKit":
        src = Path(os.getenv("SHAPEKIT_SRC_PATH", "/home/visitor/ShapeKit"))
        if not (src / "main.py").is_file():
            return False, "ShapeKit is not installed on this server."
        if not _environment_present(os.getenv("CONDA_ENV_SHAPEKIT", "shapekit")):
            return False, "The ShapeKit runtime is not configured on this server."
    else:
        return False, "Unknown pipeline stage."
    return True, None


def options():
    def option(model):
        available, reason = stage_availability(model)
        return {"id": model, "label": model, "available": available,
                "reason": reason, "supported_models": list(SUPPORTED_MODELS)}
    return {"version": 1, "preprocessing": [option("OpenVAE")],
            "postprocessing": [option("ShapeKit")]}


def selection(model, preprocessing=None, postprocessing=None, lesion_target=None):
    for value, expected, field in ((preprocessing, "OpenVAE", "preprocessing"),
                                   (postprocessing, "ShapeKit", "postprocessing")):
        if value not in (None, "", expected):
            raise PipelineError(f"Unsupported {field} selection.")
    preprocessing, postprocessing = preprocessing or None, postprocessing or None
    if (preprocessing or postprocessing) and model not in SUPPORTED_MODELS:
        raise PipelineError("This segmentation model does not yet support the selected pipeline stages.")
    if lesion_target not in (None, "", "pancreatic", "pancreas", "liver", "kidney", "colon"):
        raise PipelineError("Unsupported primary lesion result.")
    for selected in (preprocessing, postprocessing, "OpenVAE" if model == "OpenVAE" else None):
        if selected:
            available, reason = stage_availability(selected)
            if not available:
                raise PipelineError(reason, "pipeline_unavailable", 503)
    return {"version": 1, "preprocessing": preprocessing, "model": model,
            "postprocessing": postprocessing,
            "lesion_target": "pancreatic" if lesion_target == "pancreas" else (lesion_target or None),
            "segmentation_input": "reconstruction" if preprocessing else "original",
            "viewer_reference": "original"}


def initial_stages(pipeline):
    pairs = []
    if pipeline["preprocessing"]:
        pairs.append(("preprocessing", pipeline["preprocessing"]))
    pairs.append(("segmentation", pipeline["model"]))
    if pipeline["postprocessing"]:
        pairs.append(("postprocessing", pipeline["postprocessing"]))
    pairs.append(("packaging", None))
    return [{"id": key, "model": model, "status": "queued", "started_at": None,
             "completed_at": None, "error": None} for key, model in pairs]


def _now():
    return datetime.now(timezone.utc).isoformat()


def validate_grid(path, reference, *, labels=False):
    """Never publish a shifted, non-finite or malformed artifact as success."""
    image, original = nib.load(str(path)), nib.load(str(reference))
    if image.shape[:3] != original.shape[:3] or any(d != 1 for d in image.shape[3:]):
        raise PipelineError("The model output does not match the original CT dimensions.")
    if not np.allclose(image.affine, original.affine, atol=1e-4, rtol=1e-5):
        raise PipelineError("The model output does not match the original CT geometry.")
    data = np.asanyarray(image.dataobj)
    if not np.isfinite(data).all():
        raise PipelineError("The model output contains invalid values.")
    if labels and (np.any(data < 0) or np.any(data > 35) or np.any(data != np.floor(data))):
        raise PipelineError("The segmentation output is not in the supported viewer label scheme.")


def run_pipeline(*, input_path, session_dir, session_id, pipeline, dispatch,
                 publish, cancelled, on_start):
    """Return an unpublished final directory and separate reconstruction path.

    Every adapter call receives the SAME cancellation id but a separate stage
    directory. Persistent cancellation is checked after the adapter clears its
    subprocess flags, including inside on_start after it acquires the GPU slot.
    """
    stages = initial_stages(pipeline)
    current = None
    # Retries never reuse a raw mask or mesh cache from an earlier attempt.
    root = Path(session_dir) / "pipeline" / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)

    def check():
        if cancelled():
            raise PipelineCancelled("Cancelled by user")

    def save():
        publish(pipeline_stages=copy.deepcopy(stages))

    def invoke(stage_id, model, source):
        nonlocal current
        check()
        current = next(stage for stage in stages if stage["id"] == stage_id)
        stage_dir = root / stage_id
        stage_dir.mkdir(exist_ok=True)

        def granted():
            if cancelled() or on_start() is False:
                return False
            current.update(status="running", started_at=_now())
            save()
            return True

        output = dispatch(str(source), session_dir=str(stage_dir), model=model,
                          session_id=session_id, on_start=granted)
        check()
        if not output or not Path(output).is_dir():
            raise PipelineError(f"{model} did not produce its expected output.")
        return Path(output)

    try:
        reconstruction = None
        model_input = Path(input_path)
        if pipeline["preprocessing"]:
            pre = invoke("preprocessing", pipeline["preprocessing"], model_input)
            reconstruction = pre / "reconstructed_ct.nii.gz"
            validate_grid(reconstruction, input_path)
            current.update(status="completed", completed_at=_now())
            save()
            model_input = reconstruction
        raw = invoke("segmentation", pipeline["model"], model_input)
        validate_grid(raw / "combined_labels.nii.gz", input_path, labels=True)
        current.update(status="completed", completed_at=_now())
        save()
        final = raw
        if pipeline["postprocessing"]:
            final = invoke("postprocessing", pipeline["postprocessing"], raw)
            validate_grid(final / "combined_labels.nii.gz", input_path, labels=True)
            # Raw measurements describe the original segmentation, not the
            # refined masks. Keep them only as explicit provenance.
            provenance = final / "segmentation_original"
            provenance.mkdir(exist_ok=True)
            for source in raw.iterdir():
                if source.name == "combined_labels.nii.gz" or source.suffix == ".csv":
                    shutil.copy2(source, provenance / source.name)
            current.update(status="completed", completed_at=_now())
            save()
        check()
        current = next(stage for stage in stages if stage["id"] == "packaging")
        current.update(status="running", started_at=_now())
        save()
        (final / "pipeline.json").write_text(json.dumps({
            "pipeline": pipeline, "raw_measurements": "segmentation_original" if pipeline["postprocessing"] else None,
        }, indent=2), encoding="utf-8")
        return str(final), str(reconstruction) if reconstruction else None, stages
    except Exception as exc:
        if current is not None and current["status"] != "completed":
            current.update(status="cancelled" if isinstance(exc, PipelineCancelled) or cancelled() else "failed",
                           completed_at=_now(), error="Cancelled by user" if cancelled() else str(exc))
        save()
        raise


def finish_packaging(stages, *, error=None, cancelled=False):
    stages = copy.deepcopy(stages)
    stage = next((s for s in stages if s["id"] == "packaging"), None)
    if stage and stage["status"] == "running":
        stage.update(status="cancelled" if cancelled else ("failed" if error else "completed"),
                     completed_at=_now(), error=error)
    return stages
