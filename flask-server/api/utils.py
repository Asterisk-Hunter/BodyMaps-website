from flask import Blueprint, send_file, make_response, request, jsonify
from services.nifti_processor import NiftiProcessor
from services.session_manager import generate_uuid
from services.auto_segmentor import run_auto_segmentation
from services.case_quality import load_case_quality_manifest, merge_case_quality
from services.manufacturer_normalization import canonicalize_manufacturer
from services.site_normalization import split_site_codes
from services import cancerverse_catalog as cv_catalog
from services import abdomenatlas_catalog as at_catalog
from models.application_session import ApplicationSession
from models.combined_labels import CombinedLabels
from models.base import db
from constants import Constants
from services.label_scheme import PANTS_LABELS, VIEWER_IDS, viewer_labelmap_path


from io import BytesIO
from datetime import datetime
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from typing import Any, Dict, Optional, Set, List, Tuple

import os
import uuid
import re
import time
import math
import numpy as np
import nibabel as nib
from scipy.ndimage import distance_transform_edt
from collections import defaultdict
from services.npz_processor import NpzProcessor
from PIL import Image
from openpyxl import load_workbook
import requests
import pandas as pd
# Track last session validation time
last_session_check = datetime.now()

# Progress tracking structure: {session_id: (start_time, expected_total_seconds)}
progress_tracker = {}

CV_SORT_OFFSET = 100_000_000   # keeps CancerVerse ids after PanTS ids when sorting by id
AT_SORT_OFFSET = 200_000_000   # and AbdomenAtlas ids after CancerVerse ids

def id_is_training(index):
    return index < 9000



def combine_label_npz(index: int):
    npz_processor = NpzProcessor()
    npz_processor.combine_labels(index)
    return
def get_panTS_id(index):
    index_str = re.sub(r"^PanTS_?", "", str(index).strip(), flags=re.IGNORECASE)
    if not re.fullmatch(r"\d+", index_str):
        raise ValueError("Invalid case id: numeric value expected")

    cur_case_id = index_str
    iter = max(0, 8 - len(index_str))
    for _ in range(iter):
        cur_case_id = "0" + cur_case_id
    cur_case_id = "PanTS_" + cur_case_id
    return cur_case_id

def get_cancerverse_id(index):
    """CV_%08d id from a numeric index (accepts an optional 'CV_' prefix)."""
    index_str = re.sub(r"^CV_?", "", str(index).strip(), flags=re.IGNORECASE)
    if not re.fullmatch(r"\d+", index_str):
        raise ValueError("Invalid case id: numeric value expected")
    return "CV_" + index_str.zfill(8)

def get_abdomenatlas_id(index):
    """BDMAP_%08d id from a numeric index (accepts an optional 'BDMAP_' prefix)."""
    return at_catalog.abdomenatlas_id(index)


def get_dataset_from_case_id(case_str):
    """Dispatch on the id prefix: 'CancerVerse' for CV ids, 'AbdomenAtlas' for BDMAP ids, else 'PanTS'."""
    prefix = str(case_str).strip().upper()
    if prefix.startswith("CV"):
        return "CancerVerse"
    if prefix.startswith("BDMAP"):
        return "AbdomenAtlas"
    return "PanTS"

def get_folder_id(case_id):
    """Canonical on-disk folder id for either dataset from an incoming request id."""
    dataset = get_dataset_from_case_id(case_id)
    if dataset == "CancerVerse":
        return get_cancerverse_id(case_id)
    if dataset == "AbdomenAtlas":
        return get_abdomenatlas_id(case_id)
    return get_panTS_id(case_id)

def get_case_nifti_paths(case_id):
    """Resolve the CT / mask / low-res paths for a case, dispatching on dataset.

    CancerVerse has no organ masks, only tumor masks for the scans with an annotated tumor
    (built into the overlay), so for CV cases ``mask`` is that file or None and
    ``masks_available`` says which.
    """
    dataset = get_dataset_from_case_id(case_id)
    if dataset == "CancerVerse":
        folder = get_cancerverse_id(case_id)
        # Overlay (updated scans) first, then the dataset in either on-disk layout.
        image = cv_catalog.resolve_ct_path(
            folder, Constants.CANCERVERSE_PATH, Constants.CANCERVERSE_OVERLAY_PATH
        )
        if cv_catalog.is_under(image, Constants.CANCERVERSE_OVERLAY_PATH):
            # The old low-res copy was made from the CT this one replaced: never serve it.
            lowres = f"{Constants.CANCERVERSE_OVERLAY_PATH}/lowres/image_only/{folder}/ct_lowres.nii.gz"
        else:
            lowres = f"{Constants.CANCERVERSE_LOWRES_PATH}/image_only/{folder}/ct_lowres.nii.gz"
        mask = cv_catalog.resolve_mask_path(folder, Constants.CANCERVERSE_OVERLAY_PATH)
        return {
            "dataset": dataset,
            "folder_id": folder,
            "image": image,
            "lowres_image": lowres,
            "mask": mask,
            "masks_available": mask is not None,
        }
    if dataset == "AbdomenAtlas":
        folder = get_abdomenatlas_id(case_id)
        image = at_catalog.resolve_ct_path(folder, Constants.ABDOMENATLAS_PATH)
        mask = at_catalog.resolve_mask_path(folder, Constants.ABDOMENATLAS_OVERLAY_PATH)
        overlay = Constants.ABDOMENATLAS_OVERLAY_PATH
        return {
            "dataset": dataset,
            "folder_id": folder,
            "image": image,
            "lowres_image": os.path.join(overlay, "lowres", "image_only", folder, "ct_lowres.nii.gz") if overlay else "",
            "mask": mask,
            "masks_available": mask is not None,
        }
    folder = get_panTS_id(case_id)
    pants_lowres = os.environ.get("PANTS_LOWRES_PATH", "/home/visitor/pants_lowres")
    return {
        "dataset": dataset,
        "folder_id": folder,
        "image": f"{Constants.PANTS_PATH}/image_only/{folder}/{Constants.MAIN_NIFTI_FILENAME}",
        "lowres_image": f"{pants_lowres}/image_only/{folder}/ct_lowres.nii.gz",
        "mask": f"{Constants.PANTS_PATH}/mask_only/{folder}/{Constants.COMBINED_LABELS_NIFTI_FILENAME}",
        "masks_available": True,
    }

def clean_nan(obj):
    """Recursively replace NaN with None for JSON serialization."""
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_nan(elem) for elem in obj]
    elif isinstance(obj, float) and math.isnan(obj):
        return None
    else:
        return obj

def format_value(value):
    """Format values for display, replacing 999999 or None with 'N/A'."""
    return "N/A" if value in [999999, None] else str(value)

def organname_to_name(filename):
    """Convert a NIfTI file name to a human-readable organ name."""
    name = filename.replace(".nii.gz", "").replace("_", " ")
    return name.title()

def get_mask_data_internal(id, fallback=False):
    """Retrieve or compute organ metadata from NIfTI and mask paths for a session."""
    try:
        numeric_id = int(id)
        pants_id = get_panTS_id(numeric_id)
        main_nifti_path = os.path.join(Constants.PANTS_PATH, "image_only", pants_id, Constants.MAIN_NIFTI_FILENAME)
        combined_labels_path = os.path.join(Constants.PANTS_PATH, "mask_only", pants_id, Constants.COMBINED_LABELS_NIFTI_FILENAME)
        print(f"[INFO] Processing NIFTI for id {id}")

        # The mask is read in viewer ids, so the organ table is fixed: the organs a
        # PanTS mask can hold, at their viewer ids. A per-case organ_intensities.json
        # is never used, because its ids followed the order of the segmentations/
        # directory listing, not the mask's own numbering.
        organ_intensities = {key: VIEWER_IDS[key] for key in PANTS_LABELS.values()}
        nifti_processor = NiftiProcessor(main_nifti_path, viewer_labelmap_path(combined_labels_path))
        nifti_processor.set_organ_intensities(organ_intensities)
        organ_metadata = nifti_processor.calculate_metrics()
        organ_metadata = clean_nan(organ_metadata)

        return organ_metadata

    except Exception as e:
        print(f"[ERROR] get_mask_data_internal: {e}")
        return {"error": str(e)}


def get_session_mask_data(session_id, job):
    """Organ metadata for a freshly-uploaded/auto-segmented scan, keyed by the
    session's own UUID rather than a PanTS catalog id.

    get_mask_data_internal() assumes a numeric PanTS catalog id (int(id) is the
    first thing it does) and has no fallback for a session id, so every fresh
    auto_segment result hit that exception and the viewer never saw real organ
    stats -- only whatever the frontend showed in the absence of any data.
    This reuses the session's own completed-job record (ct_path,
    output_mask_dir, model) instead of the PanTS catalog, and picks the label
    map for whichever model actually produced the segmentation.

    `job` is the dict api_blueprint._get_inference_job(session_id) returns --
    the in-memory/disk-mirrored auto_segment job record (SESSIONS_DIR =
    .../tmp), not services.job_store's DB-backed job (that table has no rows
    for this code path -- verified directly against the real DB, not assumed).
    Caller passes it in instead of this module doing its own lookup, since
    _get_inference_job lives in api_blueprint.py and importing it back here
    would be circular (api_blueprint already does `from .utils import *`).
    """
    from services.auto_segmentor import MODEL_TO_VIEWER
    from services.label_scheme import VIEWER_LABELS

    try:
        if not job:
            return {"error": f"No job found for session {session_id}"}
        if job.get("status") != "completed":
            return {"error": f"Job for session {session_id} is not completed (status={job.get('status')!r})"}

        ct_path = job.get("ct_path")
        output_mask_dir = job.get("output_mask_dir")
        model = job.get("model")
        if not ct_path or not output_mask_dir or not model:
            return {"error": "Completed job is missing ct_path, output_mask_dir, or model"}

        viewer_map = MODEL_TO_VIEWER.get(model)
        if viewer_map is None:
            return {"error": f"No organ label map known for model {model!r}"}

        combined_labels_path = os.path.join(output_mask_dir, Constants.COMBINED_LABELS_NIFTI_FILENAME)
        if not os.path.exists(ct_path) or not os.path.exists(combined_labels_path):
            return {"error": "Session output files are missing on disk"}

        # _remap_combined_labels rewrote this mask into viewer ids when the
        # model finished, so each organ is read at the viewer id the model's
        # map sends it to, never at the model's own number. Raw classes that
        # share an id (ePAI's three pancreatic lesion subtypes) are one organ
        # in the mask as well.
        organ_intensities = {}
        for viewer_id in sorted(set(viewer_map.values())):
            meta = VIEWER_LABELS.get(viewer_id)
            if meta:
                organ_intensities[meta["key"]] = viewer_id

        nifti_processor = NiftiProcessor(ct_path, combined_labels_path, organ_intensities)
        organ_metadata = nifti_processor.calculate_metrics()
        return clean_nan(organ_metadata)

    except Exception as e:
        print(f"[ERROR] get_session_mask_data: {e}")
        return {"error": str(e)}


def generate_distinct_colors(n):
    """Generate n visually distinct RGB colors."""
    import colorsys
    HSV_tuples = [(x / n, 0.7, 0.9) for x in range(n)]
    RGB_tuples = [tuple(int(c * 255) for c in colorsys.hsv_to_rgb(*hsv)) for hsv in HSV_tuples]
    return RGB_tuples

def fill_voids_with_nearest_label(label_array):
    """Fill all 0-valued voxels with the nearest non-zero label."""
    mask = label_array == 0
    if not np.any(mask):
        return label_array

    nonzero_coords = np.array(np.nonzero(label_array)).T
    distances, indices = distance_transform_edt(mask, return_indices=True)
    filled_array = label_array.copy()
    filled_array[mask] = label_array[tuple(indices[:, mask])]
    return filled_array

def build_adjacency_graph(label_array):
    """Build adjacency graph of label connectivity in 6 directions."""
    adjacency = defaultdict(set)
    offsets = [(-1, 0, 0), (1, 0, 0),
               (0, -1, 0), (0, 1, 0),
               (0, 0, -1), (0, 0, 1)]

    for dx, dy, dz in offsets:
        shifted = np.roll(label_array, shift=(dx, dy, dz), axis=(0, 1, 2))
        mask = (label_array != shifted) & (label_array != 0) & (shifted != 0)
        l1 = label_array[mask]
        l2 = shifted[mask]
        for a, b in zip(l1, l2):
            if a != b:
                adjacency[a].add(b)
                adjacency[b].add(a)
    return adjacency

def assign_colors_with_high_contrast(label_ids, adjacency_graph, min_initial_colors=20, max_total_colors=50):
    """
    Assign colors to labels such that adjacent labels have different colors,
    maximizing contrast and balance.
    """
    import colorsys

    def generate_distinct_colors(n):
        HSV_tuples = [(x / n, 0.7, 0.9) for x in range(n)]
        RGB_tuples = [tuple(int(c * 255) for c in colorsys.hsv_to_rgb(*hsv)) for hsv in HSV_tuples]
        return RGB_tuples

    def can_use_color(label, color_idx, assignments, adjacency_graph):
        for neighbor in adjacency_graph[label]:
            if assignments.get(neighbor) == color_idx:
                return False
        return True

    label_ids = sorted(label_ids)
    assignments = {}
    num_colors = min_initial_colors
    color_usage_count = {i: 0 for i in range(num_colors)}

    while True:
        colors = generate_distinct_colors(num_colors)
        assignments.clear()
        color_usage_count = {i: 0 for i in range(num_colors)}
        success = True

        for label in label_ids:
            color_order = sorted(range(num_colors), key=lambda c: (color_usage_count[c], c))
            for color_idx in color_order:
                if can_use_color(label, color_idx, assignments, adjacency_graph):
                    assignments[label] = color_idx
                    color_usage_count[color_idx] += 1
                    break
            else:
                success = False
                break

        if success:
            break
        elif num_colors >= max_total_colors:
            print(f"⚠️ Warning: reached max color count {max_total_colors}, some neighbors may share color")
            break
        else:
            num_colors += 1

    final_colors = generate_distinct_colors(num_colors)
    print(f"✅ Final color count used: {len(set(assignments.values()))}")

    color_map = {
        str(round(label)): {
            "R": final_colors[color_idx][0],
            "G": final_colors[color_idx][1],
            "B": final_colors[color_idx][2],
            "A": 128
        }
        for label, color_idx in assignments.items()
    }

    return color_map, color_usage_count

def wait_for_file(filepath, timeout=30, check_interval=0.5):
    """Wait until a file exists, or timeout is reached."""
    start_time = time.time()
    while not os.path.exists(filepath):
        if time.time() - start_time > timeout:
            raise TimeoutError(f"Timeout: File {filepath} not found after {timeout} seconds.")
        time.sleep(check_interval)

def volume_to_png(volume, axis=2, index=None):
    if index is None:
        index = volume.shape[axis] // 2
    
    slice_ = np.take(volume, index, axis=axis)
    # window_center = 40 
    # window_width = 400 
    # min_val = window_center - window_width / 2
    # max_val = window_center + window_width / 2

    # slice_clipped = np.clip(slice_, min_val, max_val)
    # slice_norm = 255 * (slice_clipped - min_val) / (max_val - min_val)
    slice_norm = 255 * (slice_ - np.min(slice_)) / (np.max(slice_) - np.min(slice_))
    slice_norm = slice_norm.astype(np.uint8)
    
    slice_norm = np.rot90(slice_norm, k=1)
    slice_norm = np.flip(slice_norm, axis=0)

    pil_img = Image.fromarray(slice_norm)
    buf = BytesIO()
    pil_img.save(buf, format="PNG")
    buf.seek(0)
    return buf
def generate_pdf_with_template(
    output_pdf, folder_name, ct_path, mask_path, template_pdf, temp_pdf_path,
    id, extracted_data=None, column_headers=None,
):
    """Compatibility entry point; never ask an LLM to diagnose from measurements."""
    from .api_blueprint import _build_report_data, _draw_report_pdf

    report_data = _build_report_data(id)
    if "error" in report_data:
        raise ValueError(report_data["error"])
    _draw_report_pdf(report_data, temp_pdf_path, output_pdf)


# Helper Function to Process CT and Mask
def get_most_labeled_slice(ct_path, mask_path, output_png, contrast_min=-150, contrast_max=250):
    """
    Load CT and mask, ensure RAS orientation, find the most labeled slice, and generate an overlay image.
    """

    try:
        import SimpleITK as sitk
        import matplotlib
        matplotlib.use('Agg')  # ✅ 关键：不再尝试调用 GUI

        import matplotlib.pyplot as plt

        # Load the CT scan and mask
        ct_scan = sitk.ReadImage(ct_path)
        print('543',mask_path)
        mask = sitk.ReadImage(mask_path)
        print(mask_path)
        # Reorient to RAS
        ct_scan = sitk.DICOMOrient(ct_scan, 'RAS')
        mask = sitk.DICOMOrient(mask, 'RAS')

        # Convert to numpy arrays
        ct_array = sitk.GetArrayFromImage(ct_scan)
        mask_array = sitk.GetArrayFromImage(mask)

        # Check for shape mismatches
        if ct_array.shape != mask_array.shape:
            raise ValueError(f"Shape mismatch: CT shape {ct_array.shape}, Mask shape {mask_array.shape}")

        # Find the slice with the most labels
        slice_sums = np.sum(mask_array, axis=(1, 2))
        most_labeled_slice_index = np.argmax(slice_sums)

        # Get the CT and mask slices
        ct_slice = ct_array[most_labeled_slice_index]
        mask_slice = mask_array[most_labeled_slice_index]

        # Apply mirroring
        ct_slice = np.fliplr(ct_slice)
        mask_slice = np.fliplr(mask_slice)

        # Apply contrast adjustment
        ct_slice = np.clip(ct_slice, contrast_min, contrast_max)
        ct_slice = (ct_slice - contrast_min) / (contrast_max - contrast_min) * 255
        ct_slice = ct_slice.astype(np.uint8)

        # Overlay mask contours on CT slice
        plt.figure(figsize=(6, 6))
        plt.imshow(ct_slice, cmap='gray', origin='lower')
        plt.contour(mask_slice, colors='red', linewidths=1)  # Use red contours for the mask
        plt.axis('off')
        plt.savefig(output_png, bbox_inches="tight", pad_inches=0)
        plt.close()
        print('586')
        return True
    except:
        return False

def create_overlay_image(ct_path, mask_path, output_path, color="red"):
    """
    Generate overlay images for most labeled slices using the unified RAS orientation logic.
    """
    return get_most_labeled_slice(ct_path, mask_path, output_path)


# Helper Function to Zoom into Labeled Area
def zoom_into_labeled_area(ct_path, mask_path, output_path, color="red"):
    """
    Create a zoomed-in view of the largest labeled area with consistent RAS orientation.
    """
    import SimpleITK as sitk
    import matplotlib.pyplot as plt
    try:
        # Load the CT scan and mask
        ct_scan = sitk.ReadImage(ct_path)
        mask = sitk.ReadImage(mask_path)

        # Reorient to RAS
        ct_scan = sitk.DICOMOrient(ct_scan, 'RAS')
        mask = sitk.DICOMOrient(mask, 'RAS')

        # Convert to numpy arrays
        ct_array = sitk.GetArrayFromImage(ct_scan)
        mask_array = sitk.GetArrayFromImage(mask)

        # Check for shape mismatches
        if ct_array.shape != mask_array.shape:
            raise ValueError(f"Shape mismatch: CT shape {ct_array.shape}, Mask shape {mask_array.shape}")

        # Find the slice with the most labels
        slice_sums = np.sum(mask_array, axis=(1, 2))
        largest_slice_idx = np.argmax(slice_sums)
        if slice_sums[largest_slice_idx] == 0:
            raise ValueError("No labeled area found in the mask.")

        # Get the mask slice and calculate the bounding box
        mask_slice = mask_array[largest_slice_idx]
        coords = np.array(np.where(mask_slice))
        min_row, max_row = np.min(coords[0]), np.max(coords[0])
        min_col, max_col = np.min(coords[1]), np.max(coords[1])
        padding = 20
        min_row = max(min_row - padding, 0)
        max_row = min(max_row + padding, mask_slice.shape[0])
        min_col = max(min_col - padding, 0)
        max_col = min(max_col + padding, mask_slice.shape[1])

        # Extract the zoomed region
        zoomed_image = ct_array[largest_slice_idx][min_row:max_row, min_col:max_col]
        zoomed_mask = mask_array[largest_slice_idx][min_row:max_row, min_col:max_col]

        # Apply mirroring
        zoomed_image = np.fliplr(zoomed_image)
        zoomed_mask = np.fliplr(zoomed_mask)

        # Apply contrast adjustment to the zoomed CT slice
        zoomed_image = np.clip(zoomed_image, -150, 250)
        zoomed_image = (zoomed_image + 150) / 400 * 255
        zoomed_image = zoomed_image.astype(np.uint8)

        # Save the zoomed-in image with overlay
        plt.figure(figsize=(6, 6))
        plt.imshow(zoomed_image, cmap="gray", origin="lower")
        plt.contour(zoomed_mask, colors=color, linewidths=1)
        plt.axis("off")
        plt.savefig(output_path, bbox_inches="tight")
        plt.close()
        return True
    except Exception as e:
        return False

def get_pdac_staging(clabel_id):
    try:
        main_nifti_path = f"{Constants.PANTS_PATH}/image_only/{get_panTS_id(clabel_id)}/{Constants.MAIN_NIFTI_FILENAME}"
        combined_labels_path = f"{Constants.PANTS_PATH}/mask_only/{get_panTS_id(clabel_id)}/{Constants.COMBINED_LABELS_NIFTI_FILENAME}"
        
        nifti_processor = NiftiProcessor(main_nifti_path, combined_labels_path)
        staging_result = nifti_processor.calculate_pdac_sma_staging()

        return {"staging_description": staging_result}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": f"PDAC staging failed: {str(e)}"}

import json
def download_clean_folder(root):
    """
    如果文件正好匹配4个目标名，则删除其中两个，并将combined_labels.nii.gz根据dataset.json分割为独立器官文件。
    """
    target_files = {
        "combined_labels.nii.gz",
        "dataset.json",
        "plans.json",
        "predict_from_raw_data_args.json"
    }

    actual_files = set(os.listdir(root))
    if actual_files == target_files:
        # 删除 plans.json 和 predict_from_raw_data_args.json
        for fname in ["plans.json", "predict_from_raw_data_args.json"]:
            fpath = os.path.join(root, fname)
            if os.path.exists(fpath):
                os.remove(fpath)
                print(f"🗑️ Removed during zip: {fpath}")

        # 读取 dataset.json
        dataset_json_path = os.path.join(root, "dataset.json")
        with open(dataset_json_path, 'r') as f:
            dataset_info = json.load(f)

        labels = dataset_info["labels"]  # 获取标签名与ID的映射

        # 读取 combined_labels.nii.gz
        combined_path = os.path.join(root, "combined_labels.nii.gz")
        combined_img = nib.load(combined_path)
        combined_data = combined_img.get_fdata()
        affine = combined_img.affine

        # 创建 segmentations 文件夹
        seg_folder = os.path.join(root, "segmentations")
        os.makedirs(seg_folder, exist_ok=True)

        # 为每个标签生成单独的 mask 文件
        for label_name, label_value in labels.items():
            mask = (combined_data == label_value).astype(np.uint8)
            label_img = nib.Nifti1Image(mask, affine)
            out_path = os.path.join(seg_folder, f"{label_name}.nii.gz")
            nib.save(label_img, out_path)
            print(f"✅ Saved: {out_path}")
        os.remove(dataset_json_path)
    else:
        print("ℹ️ Folder content does not match the expected file set. Skipping cleanup and split.")
        
async def store_files(combined_labels_id):

    def download(url, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        headers = {"User-Agent": "Mozilla/5.0"}
        res = requests.get(url, stream=True, headers=headers, allow_redirects=True)
        if res.status_code == 200:
            with open(path, "wb") as f:
                for chunk in res.iter_content(1024):
                    f.write(chunk)
            print(f"Saved: {path}")
        else:
            print(f"Failed: {url} ({res.status_code})")

    # main CT
    image_url = f"https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/{get_panTS_id(combined_labels_id)}/ct.nii.gz"
    image_path = f"{Constants.PANTS_PATH}/image_only/{get_panTS_id(combined_labels_id)}/ct.nii.gz"
    download(image_url, image_path)

    # labels
    for label in list(PANTS_LABELS.values()):
        mask_url = f"https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/{get_panTS_id(combined_labels_id)}/segmentations/{label}.nii.gz"
        mask_path = f"{Constants.PANTS_PATH}/mask_only/{get_panTS_id(combined_labels_id)}/segmentations/{label}.nii.gz"
        download(mask_url, mask_path)
        
def _metadata_file_path() -> str:
    """Resolve the PanTS workbook in either supported dataset layout.

    Production checkouts have historically used both ``<root>/metadata.xlsx``
    and ``<root>/data/metadata.xlsx``.  The API blueprint already accepts both;
    search must use the same resolution or it silently boots with an empty
    catalog while the volume files are present.
    """
    root = Constants.PANTS_PATH
    if not root:
        return ""
    candidates = (
        os.path.join(root, "metadata.xlsx"),
        os.path.join(root, "data", "metadata.xlsx"),
    )
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    # Keep a useful path in the startup warning when the dataset is not mounted.
    return candidates[0]


META_FILE = _metadata_file_path()
# ---------------------------
# Helpers
# ---------------------------
def _arg(name: str, default=None):
    return request.args.get(name, default)

def to_int(x) -> Optional[int]:
    try:
        return int(x)
    except Exception:
        return None

def _to_float(x) -> Optional[float]:
    try:
        return float(x)
    except Exception:
        return None

def _to01_query(x) -> Optional[int]:
    if x is None: return None
    s = str(x).strip().lower()
    if s in ("1","true","yes","y"): return 1
    if s in ("0","false","no","n"): return 0
    return None

def _collect_list_params(names: List[str]) -> List[str]:
    out: List[str] = []
    for n in names:
        if n in request.args:
            out += request.args.getlist(n)
    tmp: List[str] = []
    for s in out:
        if "," in s:
            tmp += [t.strip() for t in s.split(",") if t.strip()]
        else:
            tmp.append(s.strip())
    return [t for t in tmp if t]

def _nan2none(v):
    try:
        if v is None: return None
        if pd.isna(v): return None
    except Exception:
        pass
    return v

def clean_json_list(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def _clean(v):
        if isinstance(v, (np.integer,)):  return int(v)
        if isinstance(v, (np.floating,)): return float(v)
        if isinstance(v, (np.bool_,)):    return bool(v)
        return v
    return [{k: _clean(v) for k, v in d.items()} for d in items]

def _canon_letters_digits(s: str) -> str:
    # 把 "LightSpeed16" 變成 "LightSpeed 16"
    s2 = re.sub(r"([A-Za-z])(\d)", r"\1 \2", s)
    s2 = re.sub(r"(\d)([A-Za-z])", r"\1 \2", s2)
    return re.sub(r"\s+", " ", s2).strip()

def canon_model(s: str) -> str:
    if not s: return ""
    base = str(s).strip()
    # 標準化空白/底線/大小寫
    low = re.sub(r"[_\-]+", " ", base).strip().lower()
    low = _canon_letters_digits(low)
    # 套用別名表
    if low in Constants.MODEL_ALIASES:
        return Constants.MODEL_ALIASES[low]
    # 沒有在別名表時：維持「字母數字分隔 + 每字首大寫」的安全格式
    spaced = _canon_letters_digits(base)
    # 常見廠牌固定大寫
    spaced = re.sub(r"(?i)^somatom", "SOMATOM", spaced)
    spaced = re.sub(r"(?i)^iqon", "IQon", spaced)
    return spaced

# ---------------------------
# Load & normalize
# ---------------------------
def _norm_cols(df_raw: pd.DataFrame) -> pd.DataFrame:
    """標準化欄位，產出搜尋/排序需要的衍生欄位。"""
    df = df_raw.copy()

    # ---- Case ID ----
    case_cols = ["PanTS ID", "PanTS_ID", "CancerVerse ID", "BDMAP ID", "case_id", "id", "case", "CaseID"]
    def _first_nonempty(row, cols):
        for c in cols:
            if c in row.index and pd.notna(row[c]) and str(row[c]).strip():
                return str(row[c]).strip(), c
        return "", None

    cases, mapping = [], []
    for _, r in df.iterrows():
        s, c = _first_nonempty(r, case_cols)
        cases.append(s); mapping.append({"case": c} if c else {})
    df["__case_str"] = cases
    df["_orig_cols"] = mapping

    # ---- Tumor -> __tumor01 ----
    def _canon(s: str) -> str: return re.sub(r"[^a-z]+", "", str(s).lower())
    tumor_names = [c for c in df.columns if "tumor" in _canon(c)] or []
    # The yes/no flag is the column literally named "tumor" ("tumor?"), never a
    # descriptive one such as "tumor type", whatever order the columns come in.
    tumor_flags = [c for c in tumor_names if _canon(c) == "tumor"]
    tcol = (tumor_flags or tumor_names or [None])[0]

    def _to01_v(v):
        if pd.isna(v): return np.nan
        s = str(v).strip().lower()
        if s in ("1","yes","y","true","t"): return 1
        if s in ("0","no","n","false","f"): return 0
        try:
            iv = int(float(s))
            return 1 if iv == 1 else (0 if iv == 0 else np.nan)
        except Exception:
            return np.nan

    df["__tumor01"] = (df[tcol].map(_to01_v) if tcol else pd.Series([np.nan]*len(df), index=df.index))
    if tcol:
        df["_orig_cols"] = [{**(df["_orig_cols"].iat[i] or {}), "tumor": tcol} for i in range(len(df))]

    # ---- Dataset + tumor type -> __dataset / __tumor_types ----
    # Search treats PanTS and CancerVerse as one collection. PanTS is a pancreatic-tumor
    # dataset, so every PanTS tumor is pancreatic; CancerVerse supplies its own types
    # (organs with an annotated lesion) in a "tumor type" column, ';'-separated.
    ds_from_id = df["__case_str"].map(get_dataset_from_case_id)
    if "dataset" in df.columns:
        given = df["dataset"].fillna("").astype(str).str.strip()
        df["__dataset"] = given.where(given != "", ds_from_id)
    else:
        df["__dataset"] = ds_from_id
    given_types = (df["tumor type"].map(cv_catalog.split_tumor_types) if "tumor type" in df.columns
                   else pd.Series([()] * len(df), index=df.index, dtype=object))
    df["__tumor_types"] = [
        t if t else ((cv_catalog.PANTS_TUMOR_TYPE,) if (d == "PanTS" and v == 1) else ())
        for t, d, v in zip(given_types, df["__dataset"], df["__tumor01"])
    ]

    # ---- Sex -> __sex ----
    df["__sex"] = df.get("sex", pd.Series([""]*len(df))).astype(str).str.strip().str.upper()
    df["__sex"] = df["__sex"].where(df["__sex"].isin(["F","M"]), "")

    # ---- Generic column finder ----
    def _find_col(prefer, keyword_sets=None):
        for c in prefer:
            if c in df.columns: return c
        if keyword_sets:
            canon_map = {c: re.sub(r"[^a-z0-9]+", "", str(c).lower()) for c in df.columns}
            for c, cs in canon_map.items():
                for ks in keyword_sets:
                    if all(k in cs for k in ks): return c
        return None

    # ---- CT phase -> __ct / __ct_lc ----
    ct_col = _find_col(
        prefer=["ct phase","CT phase","ct_phase","CT_phase","ct"],
        keyword_sets=[["ct","phase"],["phase"]],
    )
    if ct_col:
        df["__ct"] = df[ct_col].astype(str).str.strip()
        df["__ct_lc"] = df["__ct"].str.lower()
        df["_orig_cols"] = [{**(df["_orig_cols"].iat[i] or {}), "ct_phase": ct_col} for i in range(len(df))]
    else:
        df["__ct"], df["__ct_lc"] = "", ""

    # ---- Manufacturer -> __mfr / __mfr_lc ----
    mfr_col = _find_col(
        prefer=["manufacturer","Manufacturer","mfr","MFR","vendor","Vendor","manufacturer name","Manufacturer Name"],
        keyword_sets=[["manufactur"],["vendor"],["brand"],["maker"]],
    )
    if mfr_col:
        df["__mfr"] = df[mfr_col].map(canonicalize_manufacturer)
        df["__mfr_lc"] = df["__mfr"].str.lower()
        df["_orig_cols"] = [{**(df["_orig_cols"].iat[i] or {}), "manufacturer": mfr_col} for i in range(len(df))]
    else:
        df["__mfr"], df["__mfr_lc"] = "", ""

        # ---- Manufacturer model -> model / __model_lc ----
    model_col = _find_col(
        prefer=["manufacturer model", "Manufacturer model", "model", "Model"],
        keyword_sets=[["model"]],
    )
    if model_col:
        # 保留原始字串以便追蹤
        df["model_raw"] = df[model_col].astype(str).str.strip()
        # 規則化為標準型號（大小寫、空白、數字黏在一起等）
        df["model"] = df["model_raw"].map(canon_model)
        df["__model_lc"] = df["model"].str.lower()
        df["_orig_cols"] = [
            {**(df["_orig_cols"].iat[i] or {}), "model": model_col}
            for i in range(len(df))
        ]
    else:
        # 以免前端讀不到欄位
        df["model_raw"] = ""
        df["model"] = ""
        df["__model_lc"] = ""

    # ---- Year -> __year_int ----
    year_col = _find_col(prefer=["study year", "Study year", "study_year", "year", "Year"],
                         keyword_sets=[["year"]])
    df["__year_int"] = (
        pd.to_numeric(df[year_col], errors="coerce")
        if year_col else pd.Series([np.nan] * len(df), index=df.index)
    )
    if year_col:
        df["_orig_cols"] = [
            {**(df["_orig_cols"].iat[i] or {}), "year": year_col}
            for i in range(len(df))
        ]

    # ---- Age -> __age ----
    age_col = _find_col(prefer=["age", "Age"], keyword_sets=[["age"]])
    df["__age"] = (
        pd.to_numeric(df[age_col], errors="coerce")
        if age_col else pd.Series([np.nan] * len(df), index=df.index)
    )
    if age_col:
        df["_orig_cols"] = [
            {**(df["_orig_cols"].iat[i] or {}), "age": age_col}
            for i in range(len(df))
        ]

    # ---- Study type -> study_type / __st_lc ----
    st_col = _find_col(
        prefer=["study type", "Study type", "study_type", "Study_type"],
        keyword_sets=[["study", "type"]],
    )
    if st_col:
        df["study_type"] = df[st_col].astype(str)
        df["__st_lc"] = df["study_type"].astype(str).str.strip().str.lower()
        df["_orig_cols"] = [
            {**(df["_orig_cols"].iat[i] or {}), "study_type": st_col}
            for i in range(len(df))
        ]
    else:
        df["study_type"] = ""
        df["__st_lc"] = ""

    # ---- Site nationality -> site_nationality / __sn_lc ----
    sn_col = _find_col(
        prefer=[
            "site nationality", "Site nationality", "site_nationality", "Site_nationality",
            "nationality", "Nationality", "site country", "Site country", "country", "Country"
        ],
        keyword_sets=[["site", "national"], ["nationality"], ["site", "country"], ["country"]],
    )
    if sn_col:
        df["site_nationality"] = df[sn_col].astype(str)
        df["__sn_tokens"] = df["site_nationality"].map(split_site_codes)
        df["__sn_lc"] = df["site_nationality"].astype(str).str.strip().str.lower()
        df["_orig_cols"] = [
            {**(df["_orig_cols"].iat[i] or {}), "site_nationality": sn_col}
            for i in range(len(df))
        ]
    else:
        df["site_nationality"] = ""
        df["__sn_tokens"] = [()] * len(df)
        df["__sn_lc"] = ""

    return df


def _safe_float(x) -> Optional[float]:
    try:
        if x is None: return None
        if isinstance(x, float) and np.isnan(x): return None
        if isinstance(x, str):
            s = x.strip().replace(",", " ")
            if not s: return None
            return float(s)
        return float(x)
    except Exception:
        return None

def _take_first_str(row, cols: List[str]) -> str:
    for c in cols:
        if c in row and pd.notna(row[c]) and str(row[c]).strip():
            return str(row[c]).strip()
    return ""

def _case_key(row) -> int:
    s = _take_first_str(row, ["PanTS ID","PanTS_ID","case_id","id","__case_str"])
    if not s: return 0
    m = re.search(r"(\d+)", str(s))
    n = int(m.group(1)) if m else 0
    # CancerVerse sorts after every PanTS id and AbdomenAtlas after CancerVerse (otherwise PanTS 12,
    # CV 12 and BDMAP 12 would interleave).
    dataset = get_dataset_from_case_id(s)
    if dataset == "CancerVerse":
        return n + CV_SORT_OFFSET
    return n + AT_SORT_OFFSET if dataset == "AbdomenAtlas" else n

def _parse_3tuple_from_row(row, name_candidates: List[str]) -> List[Optional[float]]:
    # 3 個獨立欄
    for base in name_candidates:
        cx, cy, cz = f"{base}_x", f"{base}_y", f"{base}_z"
        if cx in row and cy in row and cz in row:
            xs = [_safe_float(row[c]) for c in (cx, cy, cz)]
            if all(v is not None for v in xs):
                return xs
    # 單欄字串
    seps = [",", "x", " ", "×", "X", ";", "|"]
    str_cols = []
    for base in name_candidates:
        str_cols += [base, f"{base}_str", base.replace(" ", "_")]
    for c in str_cols:
        if c in row and pd.notna(row[c]):
            s = str(row[c]).strip()
            if not s: continue
            s2 = re.sub(r"[\[\]\(\)\{\}]", " ", s)
            for sep in seps:
                s2 = s2.replace(sep, " ")
            parts = [p for p in s2.split() if p]
            vals = [_safe_float(p) for p in parts[:3]]
            if len(vals) == 3 and all(v is not None for v in vals):
                return vals
    return [None, None, None]

def _spacing_sum(row) -> Optional[float]:
    vals = _parse_3tuple_from_row(row, ["spacing","voxel_spacing","voxel_size","pixel_spacing"])
    if any(v is None for v in vals): return None
    return float(vals[0] + vals[1] + vals[2])

def _shape_sum(row) -> Optional[float]:
    vals = _parse_3tuple_from_row(row, ["shape","dim","size","image_shape","resolution"])
    if any(v is None for v in vals): return None
    return float(vals[0] + vals[1] + vals[2])

def _tuple_product(row, name_candidates: List[str]) -> Optional[float]:
    vals = _parse_3tuple_from_row(row, name_candidates)
    if any(v is None or v <= 0 for v in vals): return None
    return float(vals[0] * vals[1] * vals[2])

def _voxel_count(row) -> Optional[float]:
    return _tuple_product(row, ["shape","dim","size","image_shape","resolution"])

def _spacing_volume(row) -> Optional[float]:
    return _tuple_product(row, ["spacing","voxel_spacing","voxel_size","pixel_spacing"])

_SPACING_NAMES = ["spacing", "voxel_spacing", "voxel_size", "pixel_spacing"]
_SHAPE_NAMES = ["shape", "dim", "size", "image_shape", "resolution"]


def _sum3(vals) -> Optional[float]:
    return None if any(v is None for v in vals) else float(vals[0] + vals[1] + vals[2])


def _prod3(vals) -> Optional[float]:
    return None if any(v is None or v <= 0 for v in vals) else float(vals[0] * vals[1] * vals[2])


def ensure_sort_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Add the sort/rank helper columns that are missing (idempotent, edits ``df`` in place).

    Deriving them is row by row and costs seconds for tens of thousands of rows, so the
    catalog tables get them once at startup; /search then finds them already there.
    """
    if "__case_sortkey" not in df.columns:
        df["__case_sortkey"] = df.apply(_case_key, axis=1) if len(df) else pd.Series(dtype="int64")
    # Spacing and shape each feed two columns: parse every row once, not twice.
    for names, wanted in ((_SPACING_NAMES, (("__spacing_sum", _sum3), ("__spacing_volume", _prod3))),
                          (_SHAPE_NAMES, (("__shape_sum", _sum3), ("__voxel_count", _prod3)))):
        missing = [(col, fn) for col, fn in wanted if col not in df.columns]
        if not missing:
            continue
        parsed = df.apply(lambda r: _parse_3tuple_from_row(r, names), axis=1) if len(df) else None
        for col, fn in missing:
            df[col] = parsed.map(fn) if parsed is not None else pd.Series(dtype="float64")

    # Completeness remains useful to keep shuffle candidates fully described.
    need_cols = ["__spacing_sum", "__shape_sum", "__sex", "__age"]
    complete = pd.Series(True, index=df.index)
    for c in need_cols:
        if c not in df.columns:
            complete &= False
        elif c == "__sex":
            complete &= (df[c].astype(str).str.strip() != "")
        else:
            complete &= df[c].notna()
    df["__complete"] = complete
    return df

# load meta — OPTIONAL in local dev. metadata.xlsx powers the case library and
# search; without it those simply return nothing. The viewer (loads a case by
# id) and the AI assistant (organ volumes come straight from the NIfTI masks /
# HuggingFace) both still work, so a missing file must NOT crash the backend.
if os.path.exists(META_FILE):
    try:
        DF_RAW = pd.read_excel(META_FILE)
    except Exception as _meta_err:
        print(f"[WARN] Could not read metadata {META_FILE}: {_meta_err} — case library will be empty.")
        DF_RAW = pd.DataFrame()
else:
    print(f"[WARN] metadata not found: {META_FILE} — case library/search will be empty. "
          "Set PANTS_PATH in flask-server/.env to your dataset to enable it.")
    DF_RAW = pd.DataFrame()

_CASE_QUALITY = load_case_quality_manifest(Constants.CASE_QUALITY_MANIFEST)
try:
    DF = merge_case_quality(_norm_cols(DF_RAW), _CASE_QUALITY)
except Exception as _norm_err:
    print(f"[WARN] metadata normalization failed: {_norm_err} — using empty catalog.")
    DF = pd.DataFrame()

# CancerVerse metadata (second dataset). The CSV is rewritten into the PanTS spreadsheet's
# columns (cv_catalog.normalize_metadata) and then goes through the SAME _norm_cols, so
# search/sort/row_to_item treat both datasets identically. Optional: if no CSV is found
# (e.g. local dev) DF_CV stays None and the catalog is PanTS only; it never raises.
# Where the CSV / tumor case index are looked for: explicit env paths, then the writable
# update overlay (CANCERVERSE_OVERLAY_PATH), then beside/inside the dataset folder.
CANCERVERSE_META_FILE = cv_catalog.resolve_metadata_file(
    Constants.CANCERVERSE_META_FILE, Constants.CANCERVERSE_OVERLAY_PATH, Constants.CANCERVERSE_PATH
)
CANCERVERSE_INDEX_FILE = cv_catalog.resolve_index_file(
    Constants.CANCERVERSE_INDEX_FILE, Constants.CANCERVERSE_OVERLAY_PATH
)
DF_CV = None
if CANCERVERSE_META_FILE:
    try:
        _cv_index = cv_catalog.load_case_index(CANCERVERSE_INDEX_FILE)
        if _cv_index is None:
            print("[WARN] No CancerVerse case index: tumor status/type shows as unknown for "
                  "CancerVerse (build one with scripts/build_cancerverse_index.py).")
        DF_CV = merge_case_quality(
            _norm_cols(cv_catalog.normalize_metadata(
                pd.read_csv(CANCERVERSE_META_FILE, low_memory=False), _cv_index,
            )),
            _CASE_QUALITY,
        )
    except Exception as _cv_err:
        print(f"[WARN] Could not load CancerVerse metadata: {_cv_err}")
        DF_CV = None

# AbdomenAtlas metadata (third dataset), the same way: the CSV is rewritten into the PanTS columns
# (at_catalog.normalize_metadata) and goes through the same _norm_cols. Optional too: with no CSV
# (ABDOMENATLAS_META_FILE, or <ABDOMENATLAS_PATH>/AbdomenAtlas3.0MiniWithMeta.csv) DF_AT stays None.
ABDOMENATLAS_META_FILE = at_catalog.resolve_metadata_file(
    Constants.ABDOMENATLAS_META_FILE, Constants.ABDOMENATLAS_PATH
)
DF_AT = None
if ABDOMENATLAS_META_FILE:
    try:
        DF_AT = merge_case_quality(
            _norm_cols(at_catalog.normalize_metadata(pd.read_csv(ABDOMENATLAS_META_FILE, low_memory=False))),
            _CASE_QUALITY,
        )
    except Exception as _at_err:
        print(f"[WARN] Could not load AbdomenAtlas metadata: {_at_err}")
        DF_AT = None

# The sort/rank helper columns are derived row by row (seconds for ~43k rows). Do that once
# here: /search used to redo it on every request (about 5 s for PanTS alone).
if len(DF):
    DF = ensure_sort_cols(DF)
if DF_CV is not None and len(DF_CV):
    DF_CV = ensure_sort_cols(DF_CV)
if DF_AT is not None and len(DF_AT):
    DF_AT = ensure_sort_cols(DF_AT)

# One catalog for users: PanTS first, then CancerVerse, then AbdomenAtlas.
_ALL_FRAMES = [frame for frame in (DF, DF_CV, DF_AT) if frame is not None]
DF_ALL = pd.concat(_ALL_FRAMES, ignore_index=True) if len(_ALL_FRAMES) > 1 else DF

def select_dataset_df() -> pd.DataFrame:
    """Base DataFrame for search, facets and random.

    Users do not choose a dataset: the default (and 'all'/'both') is the combined catalog.
    ?dataset=pants, ?dataset=cancerverse or ?dataset=abdomenatlas still narrows it for API clients.
    """
    ds = (request.args.get("dataset") or "").strip().lower()
    if ds == "pants":
        return DF
    if ds in ("cancerverse", "cv"):
        return DF_CV if DF_CV is not None else DF.iloc[0:0]
    if ds in ("abdomenatlas", "atlas", "bdmap"):
        return DF_AT if DF_AT is not None else DF.iloc[0:0]
    return DF_ALL

def _is_number(text: str) -> bool:
    """ASCII digits only: str.isdigit() also accepts '²' and '٣', which int() then rejects."""
    return text.isascii() and text.isdigit()


def _exact_case_mask(df: pd.DataFrame, cid: str) -> pd.Series:
    """Rows whose case id is exactly ``cid``. A bare number means a PanTS case."""
    s = df["__case_str"].astype(str).str.strip()
    if _is_number(cid):
        n = int(cid)
        nums = pd.to_numeric(s.str.extract(r"(\d+)")[0], errors="coerce")
        is_pants = (df["__dataset"] == "PanTS") if "__dataset" in df.columns else True
        return (nums == n) & is_pants
    norm = cid.upper()
    m = re.fullmatch(r"(CV|PANTS|BDMAP)_?(\d+)", norm)
    if m:
        norm = m.group(1) + "_" + m.group(2).zfill(8)
    return s.str.upper() == norm


def apply_filters(base: pd.DataFrame, exclude: Optional[Set[str]] = None) -> pd.DataFrame:
    exclude = exclude or set()
    df = base

    # --- Case ID / keyword（精準匹配） ---
    # q      keyword search across BOTH datasets ("77" finds PanTS 77 and CancerVerse 77).
    # caseid exact lookup of one case: a bare number is a PanTS id (as it always was in the
    #        UI) and CancerVerse ids keep their "CV_" prefix, so merging the two datasets
    #        cannot make the viewer's metadata lookup for PanTS 8854 return CV 8854.
    q = (_arg("q") or "").strip()
    cid = (_arg("caseid") or "").strip()
    if cid and not q and "caseid" not in exclude and "__case_str" in df.columns:
        exact = _exact_case_mask(df, cid)
        if exact.any() or _is_number(cid):
            df = df[exact]
        else:   # not a full id: keep the old substring behaviour for API clients
            df = df[df["__case_str"].astype(str).str.contains(re.escape(cid), na=False, case=False, regex=False)]
    elif q and "caseid" not in exclude and "__case_str" in df.columns:
        s = df["__case_str"].astype(str)
        if _is_number(q):
            # 把每列所有數字 token 抓出來，做數值等號；77 不會吃 177/077（前導 0 忽略）
            qq = int(q)
            nums = s.str.findall(r"\d+")
            mask_num = nums.apply(lambda xs: any(int(x) == qq for x in xs))
            # 備援：允許 "Case 77"（不必留可刪）
            patt = rf"(?i)\b(?:case\s*)?{re.escape(q)}\b"
            mask_regex = s.str.contains(patt, na=False, regex=True)
            df = df[mask_num | mask_regex]
        else:
            # 一般文字搜尋（忽略大小寫；避免把查詢當正則）
            df = df[s.str.contains(re.escape(q), na=False, case=False, regex=False)]

    # --- Tumor ---
    tv = _to01_query(_arg("tumor"))
    tnull = _to01_query(_arg("tumor_is_null"))
    if (_arg("tumor", "").strip().lower() == "unknown"):
        tnull, tv = 1, None
    if "__tumor01" in df.columns and "tumor" not in exclude:
        if tnull in (0, 1) and "tumor_is_null" not in exclude:
            df = df[df["__tumor01"].isna()] if tnull == 1 else df[df["__tumor01"].notna()]
        elif tv in (0, 1):
            df = df[df["__tumor01"] == tv]

    # --- Tumor type (organ of the tumor; PanTS tumors are pancreatic) ---
    wanted_types = {
        part.strip().lower()
        for value in _collect_list_params(["tumor_type", "tumor_type[]"])
        for part in re.split(r"[;|]+", value)       # commas are already split by the collector
        if part.strip()
    }
    if wanted_types and "__tumor_types" in df.columns and "tumor_type" not in exclude:
        df = df[df["__tumor_types"].map(
            lambda ts: bool(wanted_types.intersection(ts)) if isinstance(ts, (tuple, list, set)) else False
        )]

    # --- Sex（多選 + Unknown）---
    sv_list = _collect_list_params(["sex", "sex[]"])
    snull = _to01_query(_arg("sex_is_null"))
    if not sv_list:
        sv = (_arg("sex", "") or "").strip().upper()
        if sv:
            sv_list = [sv]
    sv_norm = []
    for s_ in sv_list:
        s2 = (s_ or "").strip().upper()
        if s2 in ("M", "F"):
            sv_norm.append(s2)
        elif s2 in ("U", "UNKNOWN"):
            sv_norm.append("UNKNOWN")
    if "__sex" in df.columns and "sex" not in exclude and (sv_norm or snull in (0, 1)):
        ser = df["__sex"].fillna("").str.strip().str.upper()
        take = pd.Series(False, index=df.index)
        vals = [s for s in sv_norm if s in ("F", "M")]
        if vals:
            take |= ser.isin(vals)
        if ("UNKNOWN" in sv_norm) or (snull == 1):
            take |= (ser == "")
        df = df[take]

    # --- Age：支援 age_bin[]（含 90+ / UNKNOWN），否則回退 age_from/age_to ---
    bins = _collect_list_params(["age_bin", "age_bin[]"])
    age_null = _to01_query(_arg("age_is_null"))
    if "__age" in df.columns and bins:
        age_series = pd.to_numeric(df["__age"], errors="coerce")
        mask = pd.Series(False, index=df.index)
        for b in bins:
            s = (b or "").strip()
            m_plus = re.match(r"^\s*(\d+)\s*\+\s*$", s)
            if m_plus:
                lo = int(m_plus.group(1))
                mask |= (age_series >= lo)
                continue
            m_rng = re.match(r"^\s*(\d+)\s*[-–—]\s*(\d+)\s*$", s)
            if m_rng:
                lo, hi = int(m_rng.group(1)), int(m_rng.group(2))
                mask |= age_series.between(lo, hi, inclusive="both")
        if (age_null == 1) or any((t or "").strip().upper() == "UNKNOWN" for t in bins):
            mask |= age_series.isna() | (df["__age"].astype(str).str.strip().str.upper() == "UNKNOWN")
        df = df[mask]
    elif "__age" in df.columns:
        af = _to_float(_arg("age_from")); at = _to_float(_arg("age_to"))
        age_series = pd.to_numeric(df["__age"], errors="coerce")
        if "age_from" not in exclude and af is not None:
            df = df[age_series >= af]
        if "age_to" not in exclude and at is not None:
            df = df[age_series <= at]

    # --- CT phase ---
    ct = (_arg("ct_phase", "") or "").strip().lower()
    ct_list = _collect_list_params(["ct_phase", "ct_phase[]"])
    if ct == "unknown" or any((s or "").lower() == "unknown" for s in ct_list):
        if "__ct" in df.columns:
            s_ct = df["__ct"].astype(str).str.strip().str.lower()
            tokens_null_ct = {'', 'unknown', 'nan', 'n/a', 'na', 'none', '(blank)', '(null)'}
            df = df[df["__ct"].isna() | s_ct.isin(tokens_null_ct)]
    elif (ct or ct_list) and "__ct_lc" in df.columns:
        parts = []
        if ct:
            parts += [p.strip() for p in re.split(r"[;,/]+", ct) if p.strip()]
        parts += [p.strip().lower() for p in ct_list if p.strip()]
        patt = "|".join(re.escape(p) for p in parts)
        df = df[df["__ct_lc"].str.contains(patt, na=False)]

    # --- Manufacturer ---
    m_list = _collect_list_params(["manufacturer", "manufacturer[]", "mfr"])
    m_raw = (_arg("manufacturer", "") or "").strip()
    if m_raw and not m_list:
        m_list = [p.strip() for p in m_raw.split(",") if p.strip()]
    if m_list and "__mfr_lc" in df.columns:
        m_lc = [canonicalize_manufacturer(value) for value in m_list]
        m_lc = [value.lower() for value in m_lc if value]
        df = df[df["__mfr_lc"].isin(m_lc)]

    # --- Model（canonical；可 fuzzy）---
    model_list = _collect_list_params(["model", "model[]", "manufacturer_model"])
    model_raw = (_arg("model", "") or "").strip()
    if model_raw and not model_list:
        model_list = [p.strip() for p in re.split(r"[;,/|]+", model_raw) if p.strip()]
    if model_list and "__model_lc" in df.columns and "model" not in exclude:
        wants = [canon_model(p).lower() for p in model_list if p]
        wants = [w for w in wants if w]
        fuzzy = str(_arg("model_fuzzy", "0")).lower() in ("1", "true", "yes")
        if fuzzy:
            patt = "|".join(re.escape(w) for w in wants)
            df = df[df["__model_lc"].str.contains(patt, na=False)]
        else:
            df = df[df["__model_lc"].isin(set(wants))]

    # --- Study type ---
    st_list = _collect_list_params(["study_type", "study_type[]"])
    st_raw = (_arg("study_type", "") or "").strip()
    if st_raw and not st_list:
        st_list = [p.strip() for p in re.split(r"[;,/|]+", st_raw) if p.strip()]
    if st_list and "__st_lc" in df.columns and "study_type" not in exclude:
        parts = [p.lower() for p in st_list]
        patt = "|".join(re.escape(p) for p in parts)
        df = df[df["__st_lc"].str.contains(patt, na=False)]

    # --- Site nationality ---
    nat_list = _collect_list_params(["site_nat", "site_nat[]", "site_nationality", "site_nationality[]"])
    nat_raw = (_arg("site_nationality", "") or _arg("site_nat", "") or "").strip()
    if nat_raw and not nat_list:
        nat_list = [p.strip() for p in re.split(r"[;,/|]+", nat_raw) if p.strip()]
    if nat_list and "__sn_tokens" in df.columns and "site_nationality" not in exclude:
        wanted_codes = {
            code
            for value in nat_list
            for code in split_site_codes(value)
        }
        if wanted_codes:
            df = df[
                df["__sn_tokens"].map(
                    lambda codes: bool(wanted_codes.intersection(codes))
                )
            ]

    # --- Year（新增）---
    # 支援 year / year[]（多選精確）、year_from / year_to（範圍）與 year_is_null（Unknown）
    if "year" not in exclude:
        _year_cols_pref = ["__year_int", "study_year", "Study year", "study year", "Year", "year"]
        _found_cols = [c for c in _year_cols_pref if c in df.columns]
        if _found_cols:
            yser = pd.to_numeric(df[_found_cols[0]], errors="coerce")

            # 1) 多選年份
            year_list = _collect_list_params(["year", "year[]"])
            year_raw = (_arg("year", "") or "").strip()
            if year_raw and not year_list:
                year_list = [p.strip() for p in re.split(r"[;,/|]+", year_raw) if p.strip()]

            # 2) 範圍
            y_from = to_int(_arg("year_from"))
            y_to   = to_int(_arg("year_to"))

            # 3) Unknown / Null
            y_is_null = _to01_query(_arg("year_is_null"))
            _unk_tokens = {"unknown", "nan", "none", "n/a", "na", "(blank)", "(null)"}
            wants_unknown = (y_is_null == 1) or any(
                (s or "").strip().lower() in _unk_tokens for s in year_list
            )

            mask = pd.Series(True, index=df.index)

            # 多選精確年份
            exact_years = []
            for s in year_list:
                try:
                    exact_years.append(int(s))
                except Exception:
                    pass
            if exact_years:
                mask &= yser.isin(set(exact_years))

            # 範圍條件
            if y_from is not None:
                mask &= (yser >= y_from)
            if y_to is not None:
                mask &= (yser <= y_to)

            # Unknown 合併進來
            if wants_unknown:
                mask = mask | yser.isna()

            df = df[mask]


    return df

def row_to_item(row: pd.Series) -> Dict[str, Any]:
    cols = row.get("_orig_cols")
    cols = cols if isinstance(cols, dict) else {}

    def pick(k, fallback=None):
        col = cols.get(k)
        if col and col in row.index:
            return row[col]
        return fallback

    types = row.get("__tumor_types")
    types = list(types) if isinstance(types, (tuple, list, set)) else []

    return {
        "PanTS ID": _nan2none(pick("case") or row.get("__case_str")),
        "case_id":  _nan2none(pick("case") or row.get("__case_str")),
        "dataset":  _nan2none(row.get("__dataset")),
        "tumor":    (int(row.get("__tumor01")) if pd.notna(row.get("__tumor01")) else None),
        # Organ(s) with a tumor, e.g. ["pancreas"] or ["liver", "kidney"], and a display string.
        "tumor types": types,
        "tumor label": ", ".join(cv_catalog.tumor_type_label(t) for t in types) or None,
        "sex":      _nan2none(row.get("__sex")),
        "age":      _nan2none(row.get("__age")),
        "ct phase": _nan2none(pick("ct_phase") or row.get("__ct")),
        "manufacturer": _nan2none(pick("manufacturer") or row.get("__mfr")),
        "manufacturer model": _nan2none(pick("model") or row.get("model")),
        "study year": _nan2none(row.get("__year_int")),
        "study type": _nan2none(pick("study_type") or row.get("study_type")),
        "site nationality": _nan2none(pick("site_nationality") or row.get("site_nationality")),
        # 排序輔助輸出
        "spacing_sum": _nan2none(row.get("__spacing_sum")),
        "shape_sum":   _nan2none(row.get("__shape_sum")),
        "complete":    bool(row.get("__complete")) if "__complete" in row else None,
    }
