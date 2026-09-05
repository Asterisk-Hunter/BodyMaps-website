import os
import sys
import uuid
import signal
import subprocess
import re
import csv
import shlex
import shutil
import threading
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Only one model inference runs at a time to avoid GPU OOM
_gpu_lock = threading.Lock()

# ── Per-session subprocess tracking (for user-initiated cancel) ──
# Each session's worker thread binds its session id thread-locally; _tracked_run
# then registers the live Popen under that id so /api/cancel-inference/<sid>
# can kill exactly that session's process group and nobody else's.
_session_procs = {}
_session_procs_lock = threading.Lock()
_thread_session = threading.local()


def bind_session(session_id):
    """Associate the calling worker thread with a session id."""
    _thread_session.sid = session_id


def _tracked_run(cmd, check=False, capture_output=False, **kwargs):
    """Drop-in for subprocess.run that makes the child killable per-session.

    Starts the child in its own process group (start_new_session) and registers
    it under the thread's bound session id for cancel_session(). Mirrors the
    subprocess.run semantics used in this module (check / capture_output /
    shell / executable / cwd / stdout / stderr / text).
    """
    if capture_output:
        kwargs.setdefault("stdout", subprocess.PIPE)
        kwargs.setdefault("stderr", subprocess.PIPE)
    kwargs.setdefault("start_new_session", True)
    sid = getattr(_thread_session, "sid", None)
    proc = subprocess.Popen(cmd, **kwargs)
    if sid:
        with _session_procs_lock:
            _session_procs[sid] = proc
    try:
        stdout, stderr = proc.communicate()
    finally:
        if sid:
            with _session_procs_lock:
                if _session_procs.get(sid) is proc:
                    _session_procs.pop(sid, None)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def cancel_session(session_id):
    """Best-effort kill of one session's inference subprocess (SIGTERM the
    process group, SIGKILL 5s later if it ignores that). Returns True if a
    live process was signalled. Safe to call for queued/unknown sessions."""
    with _session_procs_lock:
        proc = _session_procs.get(session_id)
    if not proc or proc.poll() is not None:
        return False
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)

        def _force_kill():
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except Exception:
                    pass

        threading.Thread(target=_force_kill, daemon=True).start()
        return True
    except Exception as e:
        print(f"[cancel] failed to kill process for session {session_id}: {e}")
        return False


def cancel_all_inference():
    """Kill every tracked inference subprocess (admin 'stop everything').
    Prefer cancel_session() for a single user's job; this is the blunt
    kill-all kept for the global /cancel-inference endpoint."""
    with _session_procs_lock:
        sids = list(_session_procs.keys())
    for sid in sids:
        cancel_session(sid)

def get_least_used_gpu(default_gpu=None):
    if default_gpu is None:
        try:
            available_gpus_str = os.getenv("AVAILABLE_GPUS", "")
            available_gpus = [int(x) for x in available_gpus_str.split(",") if x.strip().isdigit()]
            if not available_gpus:
                raise ValueError("No available GPUs specified.")

            result = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                universal_newlines=True
            )
            mem_usages = [int(x) for x in result.strip().split("\n")]
            least_used_gpu = min(available_gpus, key=lambda i: mem_usages[i])
            return str(least_used_gpu)
        except Exception as e:
            print("⚠️ Failed to get GPU info, defaulting to 0:", e)
            return "0"
    else:
        return str(default_gpu)


def _resolve_conda_exe():
    """Locate the conda binary.

    gunicorn on the server runs without a login shell, so it does not pick up
    the PATH that conda's shell init exports. shutil.which("conda") therefore
    returns nothing there even though conda is installed and working.

    Half the runners in this file already worked around that with a hardcoded
    fallback and half raised instead, which is why ePAI, Atlas-Net and
    LesionSegmenter failed while OpenVAE and MedFormer kept working. Same box,
    same conda, different error handling.

    Override with CONDA_EXE_PATH if conda lives somewhere not listed here.
    """
    explicit = os.path.expanduser(os.getenv("CONDA_EXE_PATH", "").strip())
    if explicit and os.path.exists(explicit):
        return explicit

    found = shutil.which("conda")
    if found:
        return found

    for candidate in (
        "/home/apps/anaconda3/condabin/conda",
        "/home/visitor/miniconda3/condabin/conda",
        "/home/visitor/anaconda3/condabin/conda",
        "/opt/conda/condabin/conda",
        "/opt/anaconda3/condabin/conda",
        "/root/miniconda3/condabin/conda",
    ):
        if os.path.exists(candidate):
            return candidate
    return ""


def _env_command(env_name, binary="python"):
    """Shell-safe prefix that runs `binary` inside conda env `env_name`.

    Prefers the env's own binary (~/.conda/envs/<env>/bin/<binary>). That needs
    neither conda on PATH nor an env activation, and it is why LesionSegmenter
    kept working on the server while every other model failed with "Could not
    find conda": gunicorn runs without a login shell, so it never inherits the
    PATH conda's init exports.

    Falls back to `conda run -n <env> <binary>` when the binary is not where
    conda conventionally puts it, so a differently-configured box degrades to
    the old behaviour instead of breaking.

    Set CONDA_ENVS_DIR if envs do not live under ~/.conda/envs.
    """
    envs_dir = os.path.expanduser(
        os.getenv("CONDA_ENVS_DIR", "").strip() or "~/.conda/envs"
    )
    # Windows: envs/suprem/python.exe or Scripts/python.exe, not bin/python
    if os.name == "nt":
        for cand in [os.path.join(envs_dir, env_name, binary),
                     os.path.join(envs_dir, env_name, f"{binary}.exe"),
                     os.path.join(envs_dir, env_name, "Scripts", binary),
                     os.path.join(envs_dir, env_name, "Scripts", f"{binary}.exe"),
                     os.path.join(envs_dir, env_name, "bin", binary),
                     os.path.join(envs_dir, env_name, "bin", f"{binary}.exe")]:
            if os.path.exists(cand):
                return shlex.quote(cand)
    direct = os.path.join(envs_dir, env_name, "bin", binary)
    if os.path.exists(direct):
        return shlex.quote(direct)

    conda_exe = _resolve_conda_exe()
    if not conda_exe:
        raise RuntimeError(
            f"Could not run '{binary}' in conda env '{env_name}'. Looked for "
            f"{direct} and could not find conda on PATH either. Set "
            f"CONDA_ENVS_DIR or CONDA_EXE_PATH."
        )
    return f"{shlex.quote(conda_exe)} run -n {shlex.quote(env_name)} {shlex.quote(binary)}"


def _resolve_conda_activate_path():
    candidates = [
        os.path.expanduser(os.getenv("CONDA_ACTIVATE_PATH", "").strip()),
        "/root/miniconda3/etc/profile.d/conda.sh",
        "/root/anaconda3/etc/profile.d/conda.sh",
        "/home/visitor/miniconda3/etc/profile.d/conda.sh",
        "/home/visitor/anaconda3/etc/profile.d/conda.sh",
        "/opt/conda/etc/profile.d/conda.sh",
        "/opt/anaconda3/etc/profile.d/conda.sh",
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return ""


def run_auto_segmentation(input_path, session_dir, model, session_id=None, on_start=None):
    """
    Dispatch to the appropriate model inference function.
    Serialized via _gpu_lock so concurrent requests queue instead of OOM-ing.
    Returns the output directory path on success, raises on failure.

    session_id: binds this worker thread so _tracked_run/cancel_session can
        target its subprocesses. on_start: called once the GPU slot is
        acquired (i.e. the job leaves the queue); returning False aborts the
        run (used when the user cancelled while the job was still queued) and
        makes this function return None.
    """
    with _gpu_lock:
        if on_start is not None:
            try:
                if on_start() is False:
                    return None
            except Exception as e:
                print(f"[on_start] callback error for {session_id}: {e}")
        if session_id:
            bind_session(session_id)
        if model == 'ePAI':
            conda_path = _resolve_conda_activate_path()
            return _run_epai_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                epai_env_name=os.getenv("CONDA_ENV_EPAI", "epai"),
                fallback_script_path=os.getenv("EPAI_SCRIPT_PATH", ""),
            )
        elif model == 'SuPreM':
            return _run_suprem_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'OpenVAE':
            return _run_openvae_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'MedFormer':
            return _run_medformer_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'R-Super':
            return _run_rsuper_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'Atlas-Net':
            conda_path = _resolve_conda_activate_path()
            return _run_atlasnet_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                atlasnet_env_name=os.getenv("CONDA_ENV_ATLASNET", "epai"),
            )
        elif model == 'ShapeKit':
            return _run_shapekit_inference(input_dir=input_path, session_dir=session_dir)
        elif model == 'LesionSegmenter':
            conda_path = _resolve_conda_activate_path()
            return _run_lesionsegmenter_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                lesionseg_env_name=os.getenv("CONDA_ENV_LESIONSEG", "epai"),
            )
        else:
            raise ValueError(f"Unknown model: {model}")


# Viewer label scheme (constants.ts segmentation_categories, 1-indexed)
_VIEWER_LABELS = {
    "adrenal_gland_left": 1, "adrenal_gland_right": 2, "aorta": 3,
    "bladder": 4, "celiac_artery": 5, "colon": 6, "common_bile_duct": 7,
    "duodenum": 8, "femur_left": 9, "femur_right": 10, "gall_bladder": 11,
    "kidney_left": 12, "kidney_right": 13, "liver": 14,
    "lung_left": 15, "lung_right": 16, "pancreas": 17,
    "pancreas_body": 18, "pancreas_head": 19, "pancreas_tail": 20,
    "pancreatic_duct": 21, "pancreatic_lesion": 22, "postcava": 23,
    "prostate": 24, "spleen": 25, "stomach": 26,
    "superior_mesenteric_artery": 27, "veins": 28,
    # extended labels for full ePAI output
    "intestine": 29, "renal_vein_left": 30, "renal_vein_right": 31, "cbd_stent": 32,
    # LesionSegmenter extra lesion classes (pancreatic_lesion already at 22)
    "liver_lesion": 33, "kidney_lesion": 34, "colon_lesion": 35,
}

# ePAI model label → viewer label (all 25 classes from dataset.json)
_EPAI_TO_VIEWER = {
    1:  _VIEWER_LABELS["aorta"],
    2:  _VIEWER_LABELS["adrenal_gland_left"],
    3:  _VIEWER_LABELS["adrenal_gland_right"],
    4:  _VIEWER_LABELS["common_bile_duct"],
    5:  _VIEWER_LABELS["celiac_artery"],
    6:  _VIEWER_LABELS["colon"],
    7:  _VIEWER_LABELS["duodenum"],
    8:  _VIEWER_LABELS["gall_bladder"],
    9:  _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["kidney_left"],
    11: _VIEWER_LABELS["kidney_right"],
    12: _VIEWER_LABELS["liver"],
    13: _VIEWER_LABELS["pancreas"],
    14: _VIEWER_LABELS["pancreatic_duct"],
    15: _VIEWER_LABELS["superior_mesenteric_artery"],
    16: _VIEWER_LABELS["intestine"],
    17: _VIEWER_LABELS["spleen"],
    18: _VIEWER_LABELS["stomach"],
    19: _VIEWER_LABELS["veins"],
    20: _VIEWER_LABELS["renal_vein_left"],
    21: _VIEWER_LABELS["renal_vein_right"],
    22: _VIEWER_LABELS["cbd_stent"],
    23: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pdac
    24: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_cyst
    25: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pnet
}

# Atlas-Net model label → viewer label (from dataset.json)
_ATLASNET_TO_VIEWER = {
    1: _VIEWER_LABELS["aorta"],
    2: _VIEWER_LABELS["adrenal_gland_left"],
    3: _VIEWER_LABELS["adrenal_gland_right"],
    4: _VIEWER_LABELS["common_bile_duct"],
    5: _VIEWER_LABELS["celiac_artery"],       # celiac_aa
    6: _VIEWER_LABELS["colon"],
    7: _VIEWER_LABELS["duodenum"],
    8: _VIEWER_LABELS["gall_bladder"],
    9: _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["kidney_left"],
    11: _VIEWER_LABELS["kidney_right"],
    12: _VIEWER_LABELS["liver"],
    13: _VIEWER_LABELS["pancreas"],
    14: _VIEWER_LABELS["pancreatic_duct"],
    15: _VIEWER_LABELS["superior_mesenteric_artery"],
    16: _VIEWER_LABELS["colon"],              # intestine (small intestine)
    17: _VIEWER_LABELS["spleen"],
    18: _VIEWER_LABELS["stomach"],
    19: _VIEWER_LABELS["veins"],
    20: _VIEWER_LABELS["veins"],              # renal_vein_left
    21: _VIEWER_LABELS["veins"],              # renal_vein_right
    # 22: cbd_stent — no viewer equivalent
    23: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pdac
    24: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_cyst
    25: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pnet
}

# SuPreM model label → viewer label (32-class AbdomenAtlas1.1, liver 6→14 anchor)
# Raw 5 esophagus has no viewer slot → omitted (treated as background).
_SUPREM_TO_VIEWER = {
    1: _VIEWER_LABELS["spleen"],
    2: _VIEWER_LABELS["kidney_right"],
    3: _VIEWER_LABELS["kidney_left"],
    4: _VIEWER_LABELS["gall_bladder"],
    6: _VIEWER_LABELS["liver"],  # anchor: raw 6 must be present to be SuPreM raw
    7: _VIEWER_LABELS["stomach"],
    8: _VIEWER_LABELS["aorta"],
    9: _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["veins"],  # portal vein and splenic vein → veins
    11: _VIEWER_LABELS["pancreas"],
    12: _VIEWER_LABELS["adrenal_gland_right"],
    13: _VIEWER_LABELS["adrenal_gland_left"],
    14: _VIEWER_LABELS["duodenum"],
    15: _VIEWER_LABELS["veins"],  # hepatic vessel → veins
    16: _VIEWER_LABELS["lung_right"],
    17: _VIEWER_LABELS["lung_left"],
    18: _VIEWER_LABELS["colon"],
    19: _VIEWER_LABELS["intestine"],
    20: _VIEWER_LABELS["colon"],  # rectum → colon (no viewer rectum)
    21: _VIEWER_LABELS["bladder"],
    22: _VIEWER_LABELS["prostate"],
    23: _VIEWER_LABELS["femur_left"],
    24: _VIEWER_LABELS["femur_right"],
    25: _VIEWER_LABELS["celiac_artery"],
    26: _VIEWER_LABELS["kidney_lesion"],      # kidney tumor → kidney_lesion
    27: _VIEWER_LABELS["liver_lesion"],       # liver tumor → liver_lesion
    28: _VIEWER_LABELS["pancreatic_lesion"],  # pancreas tumor → pancreatic_lesion
    29: _VIEWER_LABELS["liver_lesion"],       # hepatic vessel tumor → liver_lesion
    30: _VIEWER_LABELS["liver_lesion"],       # lung tumor → liver_lesion (no viewer lung lesion)
    31: _VIEWER_LABELS["colon_lesion"],       # colon tumor → colon_lesion
    32: _VIEWER_LABELS["kidney_lesion"],      # kidney cyst → kidney_lesion
}


def _is_suprem_raw(nii_path: str) -> bool:
    """Guards SuPreM remap: raw SuPreM always has liver=6 (viewer liver=14)."""
    try:
        import nibabel as nib
        import numpy as np
        img = nib.load(nii_path)
        uniq = set(map(int, np.unique(np.asarray(img.dataobj).astype(int, copy=False))))
        return 6 in uniq
    except Exception:
        return False


def remap_suprem_file(nii_path: str) -> bool:
    """Remap a single combined_labels.nii.gz if it is still SuPreM raw. Returns True if remapped."""
    if not os.path.exists(nii_path):
        return False
    if not _is_suprem_raw(nii_path):
        return False
    _remap_combined_labels(nii_path, _SUPREM_TO_VIEWER)
    # mtime bump so downstream cache/mesh invalidation sees a change
    try:
        os.utime(nii_path, None)
    except Exception:
        pass
    return True


def fix_all_suprem_labels(root_dir: str = None) -> int:
    """Walk sessions and remap any lingering SuPreM raw combined_labels. Returns count remapped."""
    import glob
    if root_dir is None:
        # sessions dir next to flask-server or from env
        root_dir = os.getenv("SESSIONS_DIR_PATH", "sessions")
        # try relative to this file
        cand = os.path.join(os.path.dirname(os.path.dirname(__file__)), root_dir)
        if os.path.isdir(cand):
            root_dir = cand
    count = 0
    for nii_path in glob.glob(os.path.join(root_dir, "**", "combined_labels.nii.gz"), recursive=True):
        try:
            if remap_suprem_file(nii_path):
                count += 1
        except Exception as e:
            print(f"[fix_all_suprem_labels] failed {nii_path}: {e}")
    # also cover suprem native outputs
    for nii_path in glob.glob(os.path.join(root_dir, "**", "suprem", "**", "combined_labels.nii.gz"), recursive=True):
        try:
            if remap_suprem_file(nii_path):
                count += 1
        except Exception as e:
            print(f"[fix_all_suprem_labels] failed {nii_path}: {e}")
    return count

# LesionSegmenter model label -> viewer label (43-class PanTS label space).
# Only classes with a confident 1:1 match in the viewer's scheme are mapped.
# NOT mapped (no viewer category exists yet, left as background rather than
# guessing at a slot and risking a mislabeled structure): esophagus, rectum,
# vertebrae_* (10 classes), trachea, heart, hip_left, hip_right, sacrum,
# uterus. pancreatic_lesion maps onto the same viewer slot ePAI and Atlas-Net
# use for their PDAC/cyst/PNET subtypes. liver_lesion/kidney_lesion/colon_lesion
# get their own viewer slots (33/34/35) -- this single model already computes all
# four lesions in one forward pass, so surfacing the other three is free at
# runtime. NOTE: only pancreatic_lesion has ground-truth validation on PanTS;
# the other three are surfaced but flagged experimental in the UI.
_LESIONSEG_TO_VIEWER = {
    1: _VIEWER_LABELS["aorta"],
    2: _VIEWER_LABELS["gall_bladder"],
    3: _VIEWER_LABELS["kidney_left"],
    4: _VIEWER_LABELS["kidney_right"],
    5: _VIEWER_LABELS["liver"],
    6: _VIEWER_LABELS["pancreas_body"],
    7: _VIEWER_LABELS["pancreas_head"],
    8: _VIEWER_LABELS["pancreas_tail"],
    9: _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["spleen"],
    11: _VIEWER_LABELS["stomach"],
    12: _VIEWER_LABELS["adrenal_gland_left"],
    13: _VIEWER_LABELS["adrenal_gland_right"],
    14: _VIEWER_LABELS["bladder"],
    15: _VIEWER_LABELS["celiac_artery"],  # celiac_trunk -> celiac_artery
    16: _VIEWER_LABELS["colon"],
    17: _VIEWER_LABELS["duodenum"],
    19: _VIEWER_LABELS["prostate"],
    21: _VIEWER_LABELS["lung_left"],
    22: _VIEWER_LABELS["lung_right"],
    39: _VIEWER_LABELS["liver_lesion"],
    40: _VIEWER_LABELS["pancreatic_lesion"],
    41: _VIEWER_LABELS["kidney_lesion"],
    42: _VIEWER_LABELS["colon_lesion"],
}


def _remap_combined_labels(nii_path: str, label_map: dict) -> None:
    """Remap integer labels in a NIfTI file in-place to match the viewer's scheme. Idempotent."""
    import nibabel as nib
    import numpy as np
    # SuPreM guard: don't double-remap viewer data
    if label_map is _SUPREM_TO_VIEWER and not _is_suprem_raw(nii_path):
        return
    img = nib.load(nii_path)
    data = np.asarray(img.dataobj)
    # generic idempotency: if none of the src labels are present, already remapped
    try:
        uniq = set(map(int, np.unique(data.astype(int, copy=False))))
    except Exception:
        uniq = set()
    if not any(src in uniq for src in label_map):
        return
    data_copy = np.asarray(img.dataobj).copy()
    remapped = np.zeros_like(data_copy)
    for src, dst in label_map.items():
        remapped[data_copy == src] = dst
    out = nib.Nifti1Image(remapped, img.affine, img.header)
    nib.save(out, nii_path)
    try:
        os.utime(nii_path, None)
    except Exception:
        pass


def _resample_seg_to_ct_grid(seg_path: str, ct_path: str) -> None:
    """Resample a segmentation NIfTI to match the CT's voxel grid (in-place).

    SuPreM's MONAI pipeline resamples the CT to 1.5mm isotropic spacing and
    crops the foreground before inference. MONAI's Invertd fails silently in
    SuPreM for dynamically added keys, so the output NIfTI has the cropped
    1.5mm grid but is incorrectly stamped with the original CT affine.

    Because of CropForegroundd, a simple zoom() is incorrect (the origin shifts).
    We must reconstruct the transform trace by running a forward pass on the CT,
    wrap the segmentation in a MetaTensor, and run Invertd.
    """
    import nibabel as nib
    import numpy as np

    if not os.path.exists(seg_path) or not os.path.exists(ct_path):
        return

    seg_nii = nib.load(seg_path)
    ct_nii = nib.load(ct_path)

    seg_shape = seg_nii.shape[:3]
    ct_shape = ct_nii.shape[:3]

    if seg_shape == ct_shape:
        return  # already aligned, nothing to do

    print(f"[resample] Seg {seg_shape} != CT {ct_shape}, resampling to CT grid via MONAI Invertd")

    import torch
    from monai.transforms import Compose, LoadImaged, Orientationd, Spacingd, CropForegroundd, ScaleIntensityRanged, EnsureChannelFirstd, Invertd
    from monai.data import MetaTensor
    
    val_transforms = Compose([
        LoadImaged(keys=['image']),
        EnsureChannelFirstd(keys=['image'], channel_dim='no_channel'),
        Orientationd(keys=['image'], axcodes='RAS'),
        Spacingd(keys=['image'], pixdim=(1.5, 1.5, 1.5), mode='bilinear'),
        ScaleIntensityRanged(keys=['image'], a_min=-175, a_max=250, b_min=0.0, b_max=1.0, clip=True),
        CropForegroundd(keys=['image'], source_key='image'),
    ])
    
    data = {'image': ct_path}
    transformed = val_transforms(data)
    
    seg_data = np.asarray(seg_nii.dataobj).astype(np.uint8)
    
    # Check if sizes match the crop
    cropped_shape = transformed['image'].shape[1:]
    if seg_data.shape != cropped_shape:
        print(f"[resample] WARNING: seg shape {seg_data.shape} != cropped CT shape {cropped_shape}")
        # Crop or pad to match
        padded = np.zeros(cropped_shape, dtype=np.uint8)
        mx = min(seg_data.shape[0], cropped_shape[0])
        my = min(seg_data.shape[1], cropped_shape[1])
        mz = min(seg_data.shape[2], cropped_shape[2])
        padded[:mx, :my, :mz] = seg_data[:mx, :my, :mz]
        seg_data = padded
    
    pseudo_label = MetaTensor(
        torch.from_numpy(seg_data).unsqueeze(0),
        affine=transformed['image'].affine,
        applied_operations=transformed['image'].applied_operations
    )
    transformed['pseudo_label'] = pseudo_label
    
    invertd_transforms = Compose([
        Invertd(keys='pseudo_label', transform=val_transforms, orig_keys='image', nearest_interp=True)
    ])
    
    inverted = invertd_transforms(transformed)
    inverted_tensor = inverted['pseudo_label']
    
    if isinstance(inverted_tensor, torch.Tensor):
        inverted_tensor = inverted_tensor.cpu().numpy()
        
    out_nii = nib.Nifti1Image(inverted_tensor[0].astype(np.uint8), inverted['pseudo_label'].affine.numpy())
    nib.save(out_nii, seg_path)
    print(f"[resample] Resampled seg saved: {out_nii.shape}, unique labels: {np.unique(inverted_tensor)}")

def _stage_nifti_gz(input_path: str, dest_path: str) -> None:
    """Point dest_path (always *_0000.nii.gz or ct.nii.gz) at input_path.

    input_path is usually already gzip-compressed, so a symlink is enough --
    cheap, no copy of a multi-hundred-MB CT. But uploads that arrive as a
    bare .nii (e.g. the local-NIfTI picker) are NOT gzipped; symlinking one
    of those under a .gz-suffixed name promises gzip bytes that aren't
    there, and every reader (nibabel, SimpleITK) fails with "not a gzip
    file" the moment a model tries to load it. Detect that case and
    actually convert instead of just renaming.
    """
    if os.path.lexists(dest_path):
        os.remove(dest_path)
    if input_path.endswith(".gz"):
        try:
            os.symlink(os.path.abspath(input_path), dest_path)
        except OSError as e:
            # Windows without symlink privilege (WinError 1314) -> copy
            import shutil
            # errno 1314 or WinError 1314
            if getattr(e, "winerror", None) == 1314 or "1314" in str(e):
                shutil.copy2(input_path, dest_path)
            else:
                raise
    else:
        import nibabel as nib
        nib.save(nib.load(input_path), dest_path)


def _normalize_case_id(input_path_or_filename: str) -> str:
    normalized_input = os.path.normpath(input_path_or_filename or "")
    parent_dir = os.path.basename(os.path.dirname(normalized_input))
    leaf_name = os.path.basename(normalized_input)

    if leaf_name.lower() in {"ct.nii", "ct.nii.gz"} and re.match(r"^BDMAP_\d+$", parent_dir):
        return parent_dir

    filename_no_ext = re.sub(r"(\.nii(\.gz)?)$", "", leaf_name, flags=re.IGNORECASE)
    if re.match(r"^BDMAP_\d+$", filename_no_ext):
        return filename_no_ext
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", filename_no_ext).strip("_")
    if cleaned:
        return f"CASE_{cleaned}"
    return f"CASE_{uuid.uuid4().hex[:8]}"


def _ensure_output_csv_template(output_csv_path: str, case_id: str):
    header_path = os.getenv("EPAI_OUTPUT_CSV_TEMPLATE", "/home/visitor/inference/output.csv")
    header = None
    if os.path.exists(header_path):
        with open(header_path, "r", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, None)

    if not header:
        header = [
            "bdmap_id", "shape", "spacing", "pancreas_pr", "pancreas_pr_component_count", "pancreas_pr_voxel_size",
            "pancreas_pr_volume_size", "duct_pr", "duct_pr_component_count", "duct_pr_voxel_size", "duct_pr_volume_size",
            "PDAC_pr", "PDAC_pr_component_count", "PDAC_pr_voxel_size", "PDAC_pr_volume_size",
            "PDAC_pr_largest_component_largest_logit", "cyst_pr", "cyst_pr_component_count", "cyst_pr_voxel_size",
            "cyst_pr_volume_size", "cyst_pr_largest_component_largest_logit", "PNET_pr", "PNET_pr_component_count",
            "PNET_pr_voxel_size", "PNET_pr_volume_size", "PNET_pr_largest_component_largest_logit"
        ]

    with open(output_csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerow([case_id] + [""] * (len(header) - 1))


def _run_epai_inference(input_path: str, session_dir: str, conda_path: str, epai_env_name: str, fallback_script_path: str):
    case_id = _normalize_case_id(input_path)

    epai_workspace = os.path.join(session_dir, "epai")
    input_dir = os.path.join(epai_workspace, "eval")
    save_dir = os.path.join(epai_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    input_csv_path = os.path.join(epai_workspace, "input.csv")
    output_csv_path = os.path.join(epai_workspace, "output.csv")
    with open(input_csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["BDMAP ID"])
        writer.writerow([case_id])

    _ensure_output_csv_template(output_csv_path, case_id)

    ckpt_path = os.getenv(
        "EPAI_CKPT_PATH",
        "/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("EPAI_NNUNET_RAW", "/home/visitor/ePAI/nnUNet/raw")
    nnunet_preprocessed = os.getenv("EPAI_NNUNET_PREPROCESSED", "/home/visitor/ePAI/nnUNet/preprocessed")
    nnunet_results = os.getenv("EPAI_NNUNET_RESULTS", "/home/visitor/ePAI/nnUNet/results")

    if _is_truthy(os.getenv("EPAI_REMOTE_ENABLED", "false")):
        _run_epai_remote_inference(
            case_id=case_id,
            input_path=input_path,
            input_csv_path=input_csv_path,
            output_csv_path=output_csv_path,
            save_dir=save_dir,
            ckpt_path=ckpt_path,
            nnunet_raw=nnunet_raw,
            nnunet_preprocessed=nnunet_preprocessed,
            nnunet_results=nnunet_results,
            epai_env_name=epai_env_name,
        )
    else:
        selected_gpu = get_least_used_gpu()

        if fallback_script_path and os.path.exists(fallback_script_path):
            script_cmd = [
                "bash", fallback_script_path, session_dir, case_id,
                input_dir, save_dir, input_csv_path, output_csv_path, ckpt_path,
            ]
            run_payload = f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} " + " ".join(shlex.quote(x) for x in script_cmd)
        else:
            run_payload = (
                f"export nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} && "
                f"export nnUNet_raw={shlex.quote(nnunet_raw)} && "
                f"export nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} && "
                f"export nnUNet_results={shlex.quote(nnunet_results)} && "
                f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                f"nnUNetv2_predict_from_modelfolder "
                f"-i {shlex.quote(input_dir)} "
                f"-o {shlex.quote(save_dir)} "
                f"-m {shlex.quote(ckpt_path)} "
                f"-f all "
                f"--input_csv {shlex.quote(input_csv_path)} "
                f"--output_csv {shlex.quote(output_csv_path)} "
                f"--continue_prediction "
                f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
                f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
                f"-num_parts 1 "
                f"-part_id 0 "
                f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
            )

        if conda_path and os.path.exists(conda_path):
            full_cmd = (
                f"source {shlex.quote(conda_path)} && "
                f"conda activate {shlex.quote(epai_env_name)} && "
                f"{run_payload}"
            )
        else:
            if fallback_script_path and os.path.exists(fallback_script_path):
                conda_exe = _resolve_conda_exe()
                if not conda_exe:
                    raise RuntimeError(
                        "Could not find conda, needed to run the ePAI fallback script. "
                        "Set CONDA_EXE_PATH."
                    )
                script_cmd = [
                    "bash", fallback_script_path, session_dir, case_id,
                    input_dir, save_dir, input_csv_path, output_csv_path, ckpt_path,
                ]
                full_cmd = (
                    f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                    f"{shlex.quote(conda_exe)} run -n {shlex.quote(epai_env_name)} "
                    + " ".join(shlex.quote(x) for x in script_cmd)
                )
            else:
                full_cmd = (
                    f"nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} "
                    f"nnUNet_raw={shlex.quote(nnunet_raw)} "
                    f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
                    f"nnUNet_results={shlex.quote(nnunet_results)} "
                    f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                    f"{_env_command(epai_env_name, 'nnUNetv2_predict_from_modelfolder')} "
                    f"-i {shlex.quote(input_dir)} "
                    f"-o {shlex.quote(save_dir)} "
                    f"-m {shlex.quote(ckpt_path)} "
                    f"-f all "
                    f"--input_csv {shlex.quote(input_csv_path)} "
                    f"--output_csv {shlex.quote(output_csv_path)} "
                    f"--continue_prediction "
                    f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
                    f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
                    f"-num_parts 1 "
                    f"-part_id 0 "
                    f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
                )

        print(f"[INFO] Running ePAI command for case {case_id}")
        print(full_cmd)
        try:
            _tracked_run(
                full_cmd,
                shell=True,
                executable="/bin/bash",
                check=True,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                "ePAI inference command failed"
                f"\nCommand: {full_cmd}"
                f"\nExit code: {e.returncode}"
            ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected ePAI output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    shutil.copy2(output_csv_path, os.path.join(output_ct_dir, "output.csv"))
    _remap_combined_labels(combined_label_path, _EPAI_TO_VIEWER)

    return output_ct_dir


def _run_suprem_inference(input_path: str, session_dir: str) -> str:
    """
    Run SuPreM segmentation natively using the extracted inference.py.

    Input layout:
        <session_dir>/suprem/inputs/ct/ct.nii.gz

    Output layout written by inference.py:
        <session_dir>/suprem/outputs/ct/combined_labels.nii.gz
        <session_dir>/suprem/outputs/ct/segmentations/*.nii.gz
    """
    suprem_workspace = os.path.join(session_dir, "suprem")
    input_case_dir = os.path.join(suprem_workspace, "inputs", "ct")
    output_dir = os.path.join(suprem_workspace, "outputs")
    os.makedirs(input_case_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    # inference.py expects the file named ct.nii.gz inside a case subfolder
    ct_link = os.path.join(input_case_dir, "ct.nii.gz")
    _stage_nifti_gz(input_path, ct_link)

    suprem_src = os.getenv("SUPREM_SRC_PATH", "/home/visitor/suprem_native/workspace/SuPreM")
    checkpoint = os.getenv(
        "SUPREM_CHECKPOINT_PATH",
        "/home/visitor/suprem_native/workspace/SuPreM/pretrained_checkpoints/supervised_suprem_unet_2100.pth",
    )
    conda_env = os.getenv("CONDA_ENV_SUPREM", "suprem")
    selected_gpu = get_least_used_gpu()
    inputs_dir = os.path.join(suprem_workspace, "inputs")

    # Windows or SUPREM_USE_DIRECT_PYTHON=true -> use direct python, not conda
    use_direct_python = os.name == "nt" or os.getenv("SUPREM_USE_DIRECT_PYTHON", "false").lower() == "true"
    if use_direct_python:
        inference_args = [
            "-W", "ignore", os.path.join(suprem_src, "inference.py"),
            "--data_root_path", inputs_dir,
            "--save_dir", output_dir,
            "--checkpoint", checkpoint,
            "--backbone", "unet",
            "--suprem",
            "--store_result",
        ]
        full_cmd = [sys.executable, *inference_args]
        print(f"[INFO] Running SuPreM native inference (direct python)")
        print(full_cmd)
        try:
            child_env = os.environ.copy()
            child_env["CUDA_VISIBLE_DEVICES"] = selected_gpu
            _tracked_run(full_cmd, check=True, cwd=suprem_src, env=child_env)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"SuPreM inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
            ) from e
        # direct path done, skip conda branch
        case_output = os.path.join(output_dir, "ct")
        if not os.path.isdir(case_output):
            raise RuntimeError(f"SuPreM output directory not found: {case_output}")
        combined_label_path = os.path.join(case_output, "combined_labels.nii.gz")
        if os.path.exists(combined_label_path):
            flask_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            script_path = os.path.join(flask_dir, "scripts", "postprocess_suprem.py")
            _tracked_run(
                [sys.executable, script_path, combined_label_path, ct_link, flask_dir],
                check=True
            )
        return case_output

    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"-W ignore {shlex.quote(os.path.join(suprem_src, 'inference.py'))} "
        f"--data_root_path {shlex.quote(inputs_dir)} "
        f"--save_dir {shlex.quote(output_dir)} "
        f"--resume {shlex.quote(checkpoint)} "
        f"--backbone unet "
        f"--store_result"
    )

    print(f"[INFO] Running SuPreM native inference")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True,
                     cwd=suprem_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"SuPreM inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_output = os.path.join(output_dir, "ct")
    if not os.path.isdir(case_output):
        raise RuntimeError(f"SuPreM output directory not found: {case_output}")

    combined_label_path = os.path.join(case_output, "combined_labels.nii.gz")
    if os.path.exists(combined_label_path):
        flask_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        script_path = os.path.join(flask_dir, "scripts", "postprocess_suprem.py")
        _tracked_run(
            [sys.executable, script_path, combined_label_path, ct_link, flask_dir],
            check=True
        )

    return case_output


def _run_openvae_inference(input_path: str, session_dir: str) -> str:
    """
    Run OpenVAE 3D reconstruction via sliding-window patch inference.

    Output layout:
        <session_dir>/openvae/reconstructed_ct.nii.gz
    """
    output_dir = os.path.join(session_dir, "openvae")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "reconstructed_ct.nii.gz")

    openvae_src = os.getenv("OPENVAE_SRC_PATH", "/home/visitor/openvae")
    checkpoint = os.getenv("OPENVAE_CHECKPOINT_PATH",
                           "/home/visitor/openvae/ckpt/OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt")
    conda_env = os.getenv("CONDA_ENV_OPENVAE", "openvae")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    inference_script = os.path.join(openvae_src, "test", "test_3dvae.py")

    # Use fine-tuned OpenVAE weights if present; fall back to public MAISI checkpoint
    use_maisi_fallback = not os.path.exists(checkpoint)
    if use_maisi_fallback:
        print(f"[INFO] OpenVAE checkpoint not found at {checkpoint}; using --maisi_ckpt (public MONAI MAISI autoencoder)")
        ckpt_arg = "--maisi_ckpt"
        patch_arg = "--patch_size 80 80 80"
    else:
        ckpt_arg = f"--checkpoint {shlex.quote(checkpoint)}"
        patch_arg = "--patch_size 64 64 64"

    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--input {shlex.quote(os.path.abspath(input_path))} "
        f"{ckpt_arg} "
        f"--output {shlex.quote(output_path)} "
        f"{patch_arg} "
        f"--amp"
    )
    print(f"[INFO] Running OpenVAE inference\n{full_cmd}")
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True, cwd=openvae_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"OpenVAE inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    if not os.path.exists(output_path):
        raise RuntimeError(f"OpenVAE output not found: {output_path}")

    return output_dir


def _combine_medformer_masks(raw_save_path: str, bdmap_id: str, output_path: str):
    """
    Combine MedFormer's per-organ binary masks into a single combined_labels.nii.gz
    using the viewer's integer label scheme.
    """
    import glob
    import nibabel as nib
    import numpy as np

    # MedFormer appends dataset/model_name to save_path; use glob to find predictions dir
    pred_dirs = glob.glob(os.path.join(raw_save_path, "**", bdmap_id, "predictions"), recursive=True)
    if not pred_dirs:
        raise RuntimeError(f"No predictions directory found under {raw_save_path}")

    pred_dir = pred_dirs[0]
    mask_files = glob.glob(os.path.join(pred_dir, "*.nii.gz"))
    if not mask_files:
        raise RuntimeError(f"No mask files found in {pred_dir}")

    ref_img = nib.load(mask_files[0])
    combined = np.zeros(ref_img.shape, dtype=np.uint8)

    for mask_file in mask_files:
        organ_name = os.path.basename(mask_file).replace(".nii.gz", "")
        label_int = _VIEWER_LABELS.get(organ_name)
        if label_int is None:
            continue
        mask_data = np.asarray(nib.load(mask_file).dataobj)
        combined[mask_data > 0] = label_int

    nib.save(nib.Nifti1Image(combined, ref_img.affine, ref_img.header), output_path)


def _run_medformer_inference(input_path: str, session_dir: str) -> str:
    """
    Run MedFormer segmentation (26 abdominal structures + pancreatic lesion).
    Outputs combined_labels.nii.gz mapped to the viewer's label scheme.
    """
    output_dir = os.path.join(session_dir, "medformer")
    os.makedirs(output_dir, exist_ok=True)

    rsuper_src = os.getenv("RSUPER_SRC_PATH", "/home/visitor/rsuper/rsuper_train")
    checkpoint = os.getenv(
        "MEDFORMER_CHECKPOINT_PATH",
        "/home/visitor/rsuper/MedFormerPanTS/pants_pancreas_release/fold_0_latest.pth",
    )
    class_list = os.getenv(
        "MEDFORMER_CLASS_LIST",
        "/home/visitor/rsuper/MedFormerPanTS/labels_pants.yaml",
    )
    conda_env = os.getenv("CONDA_ENV_MEDFORMER", "rsuper")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    # MedFormer needs the filename to contain ".nii.gz" to enter the NIfTI branch;
    # stage input as a flat BDMAP_00000001.nii.gz directly in the input dir
    bdmap_id = "BDMAP_00000001"
    staging_dir = os.path.join(output_dir, "input")
    os.makedirs(staging_dir, exist_ok=True)
    staged_ct = os.path.join(staging_dir, f"{bdmap_id}.nii.gz")
    if not os.path.exists(staged_ct):
        shutil.copy2(input_path, staged_ct)

    raw_save_path = os.path.join(output_dir, "raw_output")
    os.makedirs(raw_save_path, exist_ok=True)

    inference_script = os.path.join(rsuper_src, "predict_abdomenatlas.py")
    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--load {shlex.quote(checkpoint)} "
        f"--img_path {shlex.quote(os.path.join(output_dir, 'input'))} "
        f"--class_list {shlex.quote(class_list)} "
        f"--save_path {shlex.quote(raw_save_path)} "
        f"--gpu {shlex.quote(selected_gpu)} "
        f"--organ_mask_on_lesion"
    )
    print(f"[INFO] Running MedFormer inference\n{full_cmd}")
    try:
        _tracked_run(
            full_cmd, shell=True, executable="/bin/bash", check=True, cwd=rsuper_src,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"MedFormer inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    combined_label_path = os.path.join(output_dir, "combined_labels.nii.gz")
    _combine_medformer_masks(raw_save_path, bdmap_id, combined_label_path)

    if not os.path.exists(combined_label_path):
        raise RuntimeError(f"MedFormer combined_labels not created at {combined_label_path}")

    return output_dir


def _run_rsuper_inference(input_path: str, session_dir: str) -> str:
    """
    Run R-Super (MedFormer + report supervision) segmentation.
    Same pipeline as MedFormer, different checkpoint trained on Merlin + PanTS reports.
    """
    output_dir = os.path.join(session_dir, "rsuper")
    os.makedirs(output_dir, exist_ok=True)

    rsuper_src = os.getenv("RSUPER_SRC_PATH", "/home/visitor/rsuper/rsuper_train")
    checkpoint = os.getenv(
        "RSUPER_CHECKPOINT_PATH",
        "/home/visitor/rsuper/R-SuperPanTSMerlin/merlin_pancreas_pants_release/fold_0_latest.pth",
    )
    class_list = os.getenv(
        "MEDFORMER_CLASS_LIST",
        "/home/visitor/rsuper/MedFormerPanTS/labels_pants.yaml",
    )
    conda_env = os.getenv("CONDA_ENV_MEDFORMER", "rsuper")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    bdmap_id = "BDMAP_00000001"
    staging_dir = os.path.join(output_dir, "input")
    os.makedirs(staging_dir, exist_ok=True)
    staged_ct = os.path.join(staging_dir, f"{bdmap_id}.nii.gz")
    if not os.path.exists(staged_ct):
        shutil.copy2(input_path, staged_ct)

    raw_save_path = os.path.join(output_dir, "raw_output")
    os.makedirs(raw_save_path, exist_ok=True)

    inference_script = os.path.join(rsuper_src, "predict_abdomenatlas.py")
    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--load {shlex.quote(checkpoint)} "
        f"--img_path {shlex.quote(staging_dir)} "
        f"--class_list {shlex.quote(class_list)} "
        f"--save_path {shlex.quote(raw_save_path)} "
        f"--gpu {shlex.quote(selected_gpu)} "
        f"--organ_mask_on_lesion"
    )
    print(f"[INFO] Running R-Super inference\n{full_cmd}")
    try:
        _tracked_run(
            full_cmd, shell=True, executable="/bin/bash", check=True, cwd=rsuper_src,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"R-Super inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    combined_label_path = os.path.join(output_dir, "combined_labels.nii.gz")
    _combine_medformer_masks(raw_save_path, bdmap_id, combined_label_path)

    if not os.path.exists(combined_label_path):
        raise RuntimeError(f"R-Super combined_labels not created at {combined_label_path}")

    return output_dir


def _run_atlasnet_inference(input_path: str, session_dir: str, conda_path: str, atlasnet_env_name: str) -> str:
    case_id = _normalize_case_id(input_path)

    atlasnet_workspace = os.path.join(session_dir, "atlasnet")
    input_dir = os.path.join(atlasnet_workspace, "eval")
    save_dir = os.path.join(atlasnet_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    ckpt_path = os.getenv(
        "ATLASNET_CKPT_PATH",
        "/home/visitor/atlasnet/model/nnUNet_results/Dataset001_ATLASNet/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("ATLASNET_NNUNET_RAW", "/home/visitor/atlasnet/nnUNet/raw")
    nnunet_preprocessed = os.getenv("ATLASNET_NNUNET_PREPROCESSED", "/home/visitor/atlasnet/nnUNet/preprocessed")
    nnunet_results = os.getenv("ATLASNET_NNUNET_RESULTS", "/home/visitor/atlasnet/nnUNet/results")

    selected_gpu = get_least_used_gpu()
    conda_exe = _resolve_conda_exe()
    if not conda_exe:
        raise RuntimeError("Could not find conda. Set CONDA_ACTIVATE_PATH or ensure `conda` is on PATH.")

    full_cmd = (
        f"nnUNet_raw={shlex.quote(nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(atlasnet_env_name, 'nnUNetv2_predict_from_modelfolder')} "
        f"-i {shlex.quote(input_dir)} "
        f"-o {shlex.quote(save_dir)} "
        f"-m {shlex.quote(ckpt_path)} "
        f"-f all "
        f"-npp 2 -nps 2 "
        f"-chk checkpoint_final.pth"
    )

    print(f"[INFO] Running Atlas-Net command for case {case_id}")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Atlas-Net inference command failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected Atlas-Net output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    _remap_combined_labels(combined_label_path, _ATLASNET_TO_VIEWER)

    return output_ct_dir


def _run_lesionsegmenter_inference(input_path: str, session_dir: str, conda_path: str, lesionseg_env_name: str) -> str:
    """LesionSegmenter: nnU-Net ResidualEncoderUNet-L, 43-class PanTS label space
    including pancreatic/liver/kidney/colon lesion.

    -step_size 0.7 and --disable_tta are not defaults elsewhere in this file --
    they're here because they were validated end-to-end against real ground
    truth on 229 held-out lesion-positive cases: 1x (no mirror-TTA) at step 0.7
    is statistically indistinguishable from the slow 8x-TTA/step-0.5 default
    (paired Dice delta not significant, 95% CI crosses zero) while running
    roughly 5x faster. Dropping either flag trades speed for nothing -- do not
    remove them to "be safe", the safety case is what's cited above.

    Runs scripts/lesionseg_predict.py instead of the bare nnUNetv2_predict_from_modelfolder
    CLI every other model here uses -- that CLI has no flag for GPU-accelerated export
    resampling, and this wrapper applies it (~26-42s -> ~1-6s on the export stage, no
    accuracy cost, see the script's own docstring). Directly measured on identical
    case/flags/environment: 2m18s (bare CLI) -> 1m5s (this wrapper) end to end. Still a
    fresh subprocess per request -- NOT the warm-predictor optimization, that's separate.
    """
    case_id = _normalize_case_id(input_path)

    lesionseg_workspace = os.path.join(session_dir, "lesionsegmenter")
    input_dir = os.path.join(lesionseg_workspace, "eval")
    save_dir = os.path.join(lesionseg_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    ckpt_path = os.getenv(
        "LESIONSEG_CKPT_PATH",
        "/home/visitor/lesionsegmenter/model/nnUNet_results/Dataset_LesionSegmenter/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("LESIONSEG_NNUNET_RAW", "/home/visitor/lesionsegmenter/nnUNet/raw")
    nnunet_preprocessed = os.getenv("LESIONSEG_NNUNET_PREPROCESSED", "/home/visitor/lesionsegmenter/nnUNet/preprocessed")
    nnunet_results = os.getenv("LESIONSEG_NNUNET_RESULTS", "/home/visitor/lesionsegmenter/nnUNet/results")

    selected_gpu = get_least_used_gpu()
    predict_script = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts", "lesionseg_predict.py")

    # `conda run -n <env> python ...` re-resolves and activates the environment on every
    # single request -- measured at ~1.75s of pure overhead versus calling that env's
    # python binary directly (0.013s). Paid once per request just like the cold model
    # load, so it's worth skipping. Falls back to `conda run` if the env's binary isn't
    # where conda envs conventionally live (e.g. a differently-configured deployment),
    # so this degrades to the previous behavior rather than breaking outright.
    run_prefix = _env_command(lesionseg_env_name)

    full_cmd = (
        f"nnUNet_raw={shlex.quote(nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{run_prefix} {shlex.quote(predict_script)} "
        f"-i {shlex.quote(input_dir)} "
        f"-o {shlex.quote(save_dir)} "
        f"-m {shlex.quote(ckpt_path)} "
        f"-step_size 0.7 "
        f"--disable_tta "
        f"-chk checkpoint_final.pth"
    )

    print(f"[INFO] Running LesionSegmenter command for case {case_id}")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"LesionSegmenter inference command failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected LesionSegmenter output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    _remap_combined_labels(combined_label_path, _LESIONSEG_TO_VIEWER)

    return output_ct_dir


def _is_truthy(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _run_checked_process(cmd: list[str], error_prefix: str):
    process = _tracked_run(cmd, text=True, capture_output=True)
    if process.returncode != 0:
        raise RuntimeError(
            f"{error_prefix}"
            f"\nCommand: {' '.join(shlex.quote(x) for x in cmd)}"
            f"\nExit code: {process.returncode}"
            f"\nSTDOUT:\n{(process.stdout or '').strip()}"
            f"\nSTDERR:\n{(process.stderr or '').strip()}"
        )
    return process


def _run_epai_remote_inference(
    case_id: str,
    input_path: str,
    input_csv_path: str,
    output_csv_path: str,
    save_dir: str,
    ckpt_path: str,
    nnunet_raw: str,
    nnunet_preprocessed: str,
    nnunet_results: str,
    epai_env_name: str,
):
    remote_host = (os.getenv("EPAI_REMOTE_HOST", "") or "").strip()
    remote_user = (os.getenv("EPAI_REMOTE_USER", "") or "").strip()
    if not remote_host or not remote_user:
        raise RuntimeError("EPAI remote mode is enabled, but EPAI_REMOTE_HOST or EPAI_REMOTE_USER is missing.")

    remote_port = str((os.getenv("EPAI_REMOTE_SSH_PORT", "22") or "22").strip())
    remote_base_dir = (os.getenv("EPAI_REMOTE_BASE_DIR", "/tmp/epai_jobs") or "/tmp/epai_jobs").strip()
    remote_env = (os.getenv("EPAI_REMOTE_CONDA_ENV", epai_env_name) or epai_env_name).strip()
    remote_conda_activate_path = (os.getenv("EPAI_REMOTE_CONDA_ACTIVATE_PATH", "") or "").strip()
    remote_conda_exe = (os.getenv("EPAI_REMOTE_CONDA_EXE", "conda") or "conda").strip()

    remote_ckpt_path = (os.getenv("EPAI_REMOTE_CKPT_PATH", ckpt_path) or ckpt_path).strip()
    remote_nnunet_raw = (os.getenv("EPAI_REMOTE_NNUNET_RAW", nnunet_raw) or nnunet_raw).strip()
    remote_nnunet_preprocessed = (
        os.getenv("EPAI_REMOTE_NNUNET_PREPROCESSED", nnunet_preprocessed) or nnunet_preprocessed
    ).strip()
    remote_nnunet_results = (os.getenv("EPAI_REMOTE_NNUNET_RESULTS", nnunet_results) or nnunet_results).strip()
    remote_gpu = (os.getenv("EPAI_REMOTE_GPU", "0") or "0").strip()

    remote_job_dir = f"{remote_base_dir.rstrip('/')}/{case_id}_{uuid.uuid4().hex[:8]}"
    remote_input_dir = f"{remote_job_dir}/eval"
    remote_save_dir = f"{remote_job_dir}/out"
    remote_case_input = f"{remote_input_dir}/{case_id}_0000.nii.gz"
    remote_input_csv = f"{remote_job_dir}/input.csv"
    remote_output_csv = f"{remote_job_dir}/output.csv"
    remote_pred = f"{remote_save_dir}/{case_id}.nii.gz"

    remote_target = f"{remote_user}@{remote_host}"

    _run_checked_process(
        ["ssh", "-p", remote_port, remote_target, f"mkdir -p {shlex.quote(remote_input_dir)} {shlex.quote(remote_save_dir)}"],
        "Failed to initialize remote ePAI workspace",
    )

    _run_checked_process(
        ["scp", "-P", remote_port, input_path, f"{remote_target}:{remote_case_input}"],
        "Failed to copy CT file to remote GPU server",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, input_csv_path, f"{remote_target}:{remote_input_csv}"],
        "Failed to copy input CSV to remote GPU server",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, output_csv_path, f"{remote_target}:{remote_output_csv}"],
        "Failed to copy output CSV template to remote GPU server",
    )

    inference_cmd = (
        f"nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} "
        f"nnUNet_raw={shlex.quote(remote_nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(remote_nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(remote_nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(remote_gpu)} "
        f"nnUNetv2_predict_from_modelfolder "
        f"-i {shlex.quote(remote_input_dir)} "
        f"-o {shlex.quote(remote_save_dir)} "
        f"-m {shlex.quote(remote_ckpt_path)} "
        f"-f all "
        f"--input_csv {shlex.quote(remote_input_csv)} "
        f"--output_csv {shlex.quote(remote_output_csv)} "
        f"--continue_prediction "
        f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
        f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
        f"-num_parts 1 "
        f"-part_id 0 "
        f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
    )

    if remote_conda_activate_path:
        remote_run_cmd = (
            f"source {shlex.quote(remote_conda_activate_path)} && "
            f"conda activate {shlex.quote(remote_env)} && "
            f"{inference_cmd}"
        )
    else:
        remote_run_cmd = (
            f"{shlex.quote(remote_conda_exe)} run -n {shlex.quote(remote_env)} "
            f"bash -lc {shlex.quote(inference_cmd)}"
        )

    _run_checked_process(
        ["ssh", "-p", remote_port, remote_target, remote_run_cmd],
        "Remote ePAI inference command failed",
    )

    local_case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    _run_checked_process(
        ["scp", "-P", remote_port, f"{remote_target}:{remote_pred}", local_case_pred],
        "Failed to download remote ePAI mask output",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, f"{remote_target}:{remote_output_csv}", output_csv_path],
        "Failed to download remote ePAI CSV output",
    )

    if _is_truthy(os.getenv("EPAI_REMOTE_CLEANUP", "true")):
        _run_checked_process(
            ["ssh", "-p", remote_port, remote_target, f"rm -rf {shlex.quote(remote_job_dir)}"],
            "Failed to clean up remote ePAI workspace",
        )


def _run_shapekit_inference(input_dir: str, session_dir: str) -> str:
    """
    Run ShapeKit post-processing on a segmentation output directory.

    ShapeKit expects: input_folder/case_id/segmentations/<organ>.nii.gz
    We receive:       input_dir/combined_labels.nii.gz  (viewer label values)

    Steps:
      1. Split combined_labels.nii.gz into per-organ files in ShapeKit's layout
      2. Run ShapeKit
      3. Reassemble refined organs back into combined_labels.nii.gz with viewer label values
    """
    import numpy as np
    import nibabel as nib

    output_dir = os.path.join(session_dir, "shapekit")
    log_dir    = os.path.join(session_dir, "shapekit_logs")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(log_dir, exist_ok=True)

    shapekit_src = os.getenv("SHAPEKIT_SRC_PATH", "/home/visitor/ShapeKit")
    conda_env    = os.getenv("CONDA_ENV_SHAPEKIT", "shapekit")
    conda_exe    = _resolve_conda_exe()
    cpu_count    = os.getenv("SHAPEKIT_CPU_NUM", "16")

    if not os.path.isdir(shapekit_src):
        raise RuntimeError(
            f"ShapeKit source not found at {shapekit_src}. "
            "Install it with:\n"
            f"  git clone https://github.com/BodyMaps/ShapeKit.git {shapekit_src}\n"
            f"  conda create -n {conda_env} python=3.10 -y\n"
            f"  conda run -n {conda_env} pip install -r {shapekit_src}/requirements.txt\n"
            "Or set SHAPEKIT_SRC_PATH and CONDA_ENV_SHAPEKIT env vars to the correct paths."
        )

    # --- Step 1: split combined_labels.nii.gz into per-organ files ---
    combined_path = os.path.join(input_dir, "combined_labels.nii.gz")
    if not os.path.isfile(combined_path):
        raise RuntimeError(
            f"ShapeKit requires combined_labels.nii.gz but it was not found in: {input_dir}"
        )

    # Organs that ShapeKit's config.yaml knows how to process
    _SHAPEKIT_ORGANS = {
        "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder",
        "colon", "duodenum", "femur_left", "femur_right", "gall_bladder",
        "intestine", "kidney_left", "kidney_right", "liver",
        "lung_left", "lung_right", "pancreas", "postcava", "prostate",
        "spleen", "stomach",
    }
    # viewer label value → organ name
    _label_to_name = {v: k for k, v in _VIEWER_LABELS.items()}

    case_id      = "case001"
    sk_input_dir = os.path.join(session_dir, "shapekit_input")
    seg_dir      = os.path.join(sk_input_dir, case_id, "segmentations")
    os.makedirs(seg_dir, exist_ok=True)

    combined_img  = nib.load(combined_path)
    combined_data = np.asarray(combined_img.dataobj, dtype=np.int16)
    affine, header = combined_img.affine, combined_img.header

    for label_val, organ_name in _label_to_name.items():
        if organ_name not in _SHAPEKIT_ORGANS:
            continue
        mask = (combined_data == label_val).astype(np.int16)
        if not np.any(mask):
            continue
        nib.save(
            nib.Nifti1Image(mask, affine, header),
            os.path.join(seg_dir, f"{organ_name}.nii.gz"),
        )
    print(f"[INFO] Split {len(os.listdir(seg_dir))} organ files into {seg_dir}")

    # --- Step 2: run ShapeKit ---
    sk_raw_output = os.path.join(session_dir, "shapekit_raw")
    os.makedirs(sk_raw_output, exist_ok=True)

    full_cmd = (
        f"{_env_command(conda_env)} "
        f"-W ignore {shlex.quote(os.path.join(shapekit_src, 'main.py'))} "
        f"--input_folder {shlex.quote(os.path.abspath(sk_input_dir))} "
        f"--output_folder {shlex.quote(os.path.abspath(sk_raw_output))} "
        f"--cpu_count {cpu_count} "
        f"--log_folder {shlex.quote(os.path.abspath(log_dir))} "
        f"--continue_prediction"
    )
    print(f"[INFO] Running ShapeKit post-processing\n{full_cmd}")
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True, cwd=shapekit_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"ShapeKit post-processing failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    # --- Step 3: reassemble combined_labels.nii.gz with viewer label values ---
    refined_seg_dir = os.path.join(sk_raw_output, case_id, "segmentations")
    if not os.path.isdir(refined_seg_dir):
        raise RuntimeError(f"ShapeKit produced no segmentation output in: {refined_seg_dir}")

    # Start from the original combined labels (preserves labels ShapeKit doesn't touch)
    result_data = combined_data.copy()

    for organ_file in os.listdir(refined_seg_dir):
        if not organ_file.endswith(".nii.gz"):
            continue
        organ_name   = organ_file[: -len(".nii.gz")]
        viewer_label = _VIEWER_LABELS.get(organ_name)
        if viewer_label is None:
            continue
        organ_data = np.asarray(nib.load(os.path.join(refined_seg_dir, organ_file)).dataobj)
        # Clear old pixels for this organ, write refined mask
        result_data[result_data == viewer_label] = 0
        result_data[organ_data > 0] = viewer_label

    nib.save(
        nib.Nifti1Image(result_data, affine, header),
        os.path.join(output_dir, "combined_labels.nii.gz"),
    )
    print(f"[INFO] ShapeKit refined combined_labels saved to {output_dir}")
    return output_dir
