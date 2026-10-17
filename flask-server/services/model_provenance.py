"""What produced a stored mask: the exact checkpoint, the inference settings, the code version, and
which labels the model can output at all.

The user dataset keeps model predictions, not annotations. A model name alone cannot say which
weights or settings made a mask, so once a checkpoint is retrained or a setting changes, the older
and newer masks become indistinguishable. Each admitted case therefore also records:

  provenance     the checkpoint files (sha256, size), the inference settings, and the web app's git commit
  label_support  the labels the model is able to output, so that "label absent" can be told apart from
                 "label never assessed" (a model that has no kidney-lesion class never reports one)

Everything here describes the web process that admitted the scan, from its environment and disk. It
cannot see a remote GPU worker or a separately started warm server that was configured differently, and
says so in `limits` instead of guessing.

The checkpoint locations and settings mirror services/auto_segmentor.py and scripts/*_predict.py. The
tests read those files and fail if the two drift apart.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import threading
from datetime import datetime, timezone
from typing import Iterable, Optional

SCHEMA = 1

# model -> (environment variable, default) for the nnU-Net model folder. Same names and defaults as
# the runners in services/auto_segmentor.py.
MODEL_CHECKPOINT = {
    "ePAI": ("EPAI_CKPT_PATH",
             "/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres"),
    "Atlas-Net": ("ATLASNET_CKPT_PATH",
                  "/home/visitor/atlasnet/model/nnUNet_results/Dataset001_ATLASNet/nnUNetTrainer__nnUNetPlans__3d_fullres"),
    "LesionSegmenter": ("LESIONSEG_CKPT_PATH",
                        "/home/visitor/lesionsegmenter/model/nnUNet_results/Dataset_LesionSegmenter/nnUNetTrainer__nnUNetPlans__3d_fullres"),
}
DEFAULT_CHECKPOINT_NAME = "checkpoint_final.pth"
# Files of an nnU-Net model folder that define the model (weights + preprocessing/architecture plan).
_PLAN_FILES = ("plans.json", "dataset.json")

_TRUE = {"1", "true", "yes", "on"}
_hash_lock = threading.Lock()
_hash_cache: dict = {}          # (path, size, mtime_ns) -> sha256
_version_lock = threading.Lock()
_version_cache: dict = {}


def _truthy(value) -> bool:
    return str(value if value is not None else "").strip().lower() in _TRUE


def _sha256_file(path: str, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _cached_sha256(path: str) -> dict:
    """sha256 + size of a file, hashed once per (path, size, mtime) for the life of the process:
    a checkpoint is hundreds of MB, and it must not be re-read for every collected scan."""
    st = os.stat(path)
    key = (path, st.st_size, st.st_mtime_ns)
    with _hash_lock:
        digest = _hash_cache.get(key)
    if digest is None:
        digest = _sha256_file(path)
        with _hash_lock:
            for stale in [k for k in _hash_cache if k[0] == path]:
                del _hash_cache[stale]          # the file changed on disk: forget its old hash
            _hash_cache[key] = digest
    return {"sha256": digest, "size_bytes": st.st_size}


def checkpoint_name(model: str, env=None) -> str:
    env = os.environ if env is None else env
    if model == "ePAI":      # the ePAI runner reads the file name from the environment
        return env.get("EPAI_CHECKPOINT_NAME", DEFAULT_CHECKPOINT_NAME)
    return DEFAULT_CHECKPOINT_NAME


def checkpoint_fingerprint(model: str, env=None) -> dict:
    """Identify the weights this process would load for `model`. Always returns a dict; `hashed` says
    whether the files could be read here."""
    env = os.environ if env is None else env
    rule = MODEL_CHECKPOINT.get(model)
    if rule is None:
        return {"hashed": False, "reason": "no checkpoint rule for this model"}
    var, default = rule
    root = env.get(var, default)
    if model == "ePAI" and _truthy(env.get("EPAI_REMOTE_ENABLED", "false")):
        return {"path": env.get("EPAI_REMOTE_CKPT_PATH", root), "hashed": False,
                "reason": "inference ran on a remote host (EPAI_REMOTE_ENABLED); its checkpoint cannot be read from here"}
    name = checkpoint_name(model, env)
    out: dict = {"path": root, "hashed": False}
    if not os.path.isdir(root):
        out["reason"] = "model folder not found on this host"
        return out
    # nnU-Net keeps the weights in <model folder>/fold_<f>/ ("-f all" is used by the runners).
    weights = next((p for p in (os.path.join(root, "fold_all", name), os.path.join(root, name))
                    if os.path.isfile(p)), None)
    if weights is None:
        out["reason"] = f"{name} not found under the model folder"
        return out
    try:
        files = {os.path.relpath(weights, root).replace(os.sep, "/"): _cached_sha256(weights)}
        for fn in _PLAN_FILES:
            p = os.path.join(root, fn)
            if os.path.isfile(p):
                files[fn] = _cached_sha256(p)
        if model == "ePAI":
            # With a TensorRT plan configured, that engine (built from the checkpoint) is what runs, so
            # the checkpoint alone would not say which network made the labels.
            plan = (env.get("EPAI_TRT_PLAN_PATH") or "").strip()
            if plan and os.path.isfile(plan):
                files["tensorrt_plan"] = {**_cached_sha256(plan), "path": plan}
            elif plan:
                out["tensorrt_plan_missing"] = plan
    except OSError as e:
        out["reason"] = f"unreadable:{type(e).__name__}"
        return out
    out.update(hashed=True, files=files)
    return out


def inference_settings(model: str, env=None) -> Optional[dict]:
    """The settings that change a model's labels, as this process is configured. Values the command
    line sets literally are fixed here and guarded by a test; the rest come from the same environment
    variables, with the same defaults, as the runners."""
    env = os.environ if env is None else env
    if model == "ePAI":
        return {"folds": "all",
                "step_size": float(env.get("EPAI_STEP_SIZE", "0.5") or "0.5"),
                "disable_tta": _truthy(env.get("EPAI_DISABLE_TTA", "0")),
                "tta_axes": (env.get("EPAI_TTA_AXES") or "").strip() or None,
                "checkpoint_name": checkpoint_name(model, env),
                "tensorrt_plan": (env.get("EPAI_TRT_PLAN_PATH") or "").strip() or None}
    if model == "Atlas-Net":
        # The runner passes only "-f all"; step size and test-time augmentation are nnU-Net's defaults.
        return {"folds": "all", "step_size": 0.5, "disable_tta": False, "nnunet_defaults": True,
                "checkpoint_name": DEFAULT_CHECKPOINT_NAME}
    if model == "LesionSegmenter":
        return {"step_size": 0.7, "disable_tta": True, "checkpoint_name": DEFAULT_CHECKPOINT_NAME,
                # the recall-oriented operating point applied when the labels are exported
                "lesion_threshold": float(env.get("LESIONSEG_LESION_THRESHOLD", "0.05") or "0.05"),
                "lesion_channel": int(env.get("LESIONSEG_LESION_CHANNEL", "40") or "40")}
    return None


def code_version(repo_dir: Optional[str] = None, env=None) -> dict:
    """The web app's git commit, resolved once per process (deploy.sh restarts the process after
    it moves the checkout, so this is the code that is running). BODYMAPS_CODE_VERSION overrides it
    for deployments without a git checkout."""
    env = os.environ if env is None else env
    explicit = (env.get("BODYMAPS_CODE_VERSION") or "").strip()
    if explicit:
        return {"commit": explicit, "dirty": None, "source": "BODYMAPS_CODE_VERSION"}
    repo_dir = repo_dir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with _version_lock:
        if repo_dir in _version_cache:
            return _version_cache[repo_dir]

    def git(*args):
        return subprocess.run(["git", "-C", repo_dir, *args], capture_output=True, text=True, timeout=5)
    try:
        head = git("rev-parse", "HEAD")
        if head.returncode != 0 or not head.stdout.strip():
            raise RuntimeError(head.stderr.strip() or "git failed")
        status = git("status", "--porcelain", "--untracked-files=no")
        info = {"commit": head.stdout.strip(),
                "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None, "source": "git"}
    except Exception as e:
        info = {"commit": None, "dirty": None, "source": f"unavailable:{type(e).__name__}"}
    with _version_lock:
        _version_cache[repo_dir] = info
    return info


def provenance(model: str, env=None) -> dict:
    return {"schema": SCHEMA, "model": model,
            "checkpoint": checkpoint_fingerprint(model, env),
            "settings": inference_settings(model, env),
            "code_version": code_version(env=env),
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "limits": "Read from the web process's environment and disk when the scan was collected. A remote GPU "
                      "worker or warm server can be configured differently; the checkpoint hash is only present "
                      "when the files were readable here."}


def label_support(model: str, label_names: dict, lesion_labels: Iterable[int] = ()) -> dict:
    """Which viewer labels `model` can output. Absent in a mask means 'not found' only for these;
    for every label in `cannot_produce` the model never looked."""
    try:
        from services.auto_segmentor import MODEL_TO_VIEWER
    except Exception as e:      # the runners table is unavailable (e.g. a stripped test environment)
        return {"known": False, "reason": f"label map unavailable:{type(e).__name__}"}
    mapping = MODEL_TO_VIEWER.get(model)
    if not mapping:
        return {"known": False, "reason": "no label map for this model"}
    produced = sorted({int(v) for v in mapping.values()})
    outside = [i for i in produced if i not in label_names]
    if outside:
        # e.g. the vertebrae model reuses ids 33-56, where this dataset's names 33-35 are lesion classes.
        # Naming them with these labels would be wrong, so say nothing rather than mislabel.
        return {"known": False, "reason": f"model uses label ids outside this dataset's label scheme: {outside}"}
    lesions = [int(l) for l in lesion_labels]
    return {"known": True, "source": "services.auto_segmentor.MODEL_TO_VIEWER",
            "produces": [label_names.get(i, f"label_{i}") for i in produced],
            "produces_ids": produced,
            "cannot_produce": [name for i, name in sorted(label_names.items()) if i not in set(produced)],
            "lesion_labels_assessed": [label_names.get(i, f"label_{i}") for i in lesions if i in set(produced)],
            "lesion_labels_not_assessed": [label_names.get(i, f"label_{i}") for i in lesions if i not in set(produced)]}


def describe(model: str, label_names: dict, lesion_labels: Iterable[int] = (), env=None) -> dict:
    """Both blocks for one case's metadata. Never raises: provenance must not stop a scan from being
    kept, so a failure is recorded as an error string in the block it belongs to."""
    out = {}
    for key, build in (("provenance", lambda: provenance(model, env)),
                       ("label_support", lambda: label_support(model, label_names, lesion_labels))):
        try:
            out[key] = build()
        except Exception as e:
            out[key] = {"error": f"{type(e).__name__}: {e}"}
    return out
