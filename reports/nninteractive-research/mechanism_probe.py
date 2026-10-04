"""CPU synthetic probes of upstream code; no model inference.
Run from the BodyMaps repository: python reports/nninteractive-research/mechanism_probe.py --workspace-root /path/to/workspace
"""
import argparse
import ast
import hashlib
import importlib.metadata
import json
from pathlib import Path
from types import SimpleNamespace
import torch
import torch.nn.functional as F
from torch.backends import cudnn
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workspace-root', type=Path, default=Path(__file__).resolve().parents[3], help='Directory containing the audited nnInteractive checkout')
ROOT = parser.parse_args().workspace_root.resolve()
OUT = Path(__file__).resolve().parent

def extract(relative_path, name, namespace):
    path = ROOT / relative_path
    source = path.read_text(encoding="utf-8")
    node = next(n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef) and n.name == name)
    module = ast.Module(body=[node], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace[name], {"path": relative_path, "function": name,
        "start_line": node.lineno, "end_line": node.end_lineno,
        "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "function_source_sha256": hashlib.sha256(ast.get_source_segment(source, node).encode("utf-8")).hexdigest()}

def cpu_empty_cache(device):
    # nnunetv2 is absent. Cache management has no pooling semantics;
    # permit this documented no-op substitution only on CPU.
    if device.type != "cpu":
        raise RuntimeError("This probe is CPU-only")

def version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None

def main():
    torch.set_num_threads(2)
    detect, detector_source = extract("nnInteractive/nnInteractive/inference/inference_session.py",
        "_detect_change_at_border", {"torch": torch})
    pool, pool_source = extract("nnInteractive/nnInteractive/utils/erosion_dilation.py",
        "iterative_3x3_same_padding_pool3d",
        {"torch": torch, "F": F, "cudnn": cudnn, "empty_cache": cpu_empty_cache})
    border_results = []
    coords = [(y, z) for y in range(1, 31) for z in range(1, 31)]
    for occupancy in (1, 25, 100, 101, 900):
        pred = torch.zeros((32, 32, 32), dtype=torch.uint8)
        for y, z in coords[:occupancy]:
            pred[0, y, z] = 1
        for condition, previous in (("empty_to_occupied", torch.zeros_like(pred)), ("unchanged_occupied", pred.clone())):
            result = bool(detect(SimpleNamespace(verbose=False), pred, previous))
            expected = condition == "empty_to_occupied" and occupancy > 100
            assert result == expected, (condition, occupancy, result)
            border_results.append({"condition": condition, "occupied_face_pixels": occupancy,
                "changed_face_pixels": occupancy if condition == "empty_to_occupied" else 0,
                "triggered_autozoom": result, "expected": expected})
    opening_results = []
    for axis in range(3):
        for width in range(1, 7):
            x = torch.zeros((1, 1, 32, 32, 32), dtype=torch.float16)
            slices = [slice(12, 12 + width)] * 3
            slices[axis] = slice(None)
            x[(0, 0, *slices)] = 1
            eroded = pool(x, kernel_size=5, use_min_pool=True)
            opened = pool(eroded, kernel_size=5, use_min_pool=False)
            before, after = int(x.sum()), int(opened.sum())
            assert after == (0 if width < 5 else before), (axis, width, before, after)
            opening_results.append({"shape": "straight_tube_full_axis", "axis": axis,
                "cross_section_width_voxels": width, "before_voxels": before, "after_voxels": after,
                "retained_fraction": after / before})
    cube = torch.zeros((1, 1, 32, 32, 32), dtype=torch.float16)
    cube[0, 0, 12:20, 12:20, 12:20] = 1
    opened_cube = pool(pool(cube, kernel_size=5, use_min_pool=True), kernel_size=5, use_min_pool=False)
    assert int(cube.sum()) == int(opened_cube.sum()) == 512
    opening_results.append({"shape": "compact_cube_equal_volume_to_width4_tube", "side_voxels": 8,
        "before_voxels": 512, "after_voxels": 512, "retained_fraction": 1.0})
    result = {"scope": "CPU synthetic code-mechanism probes, no model inference",
        "limitations": ["Tests prove predicate/operator behavior on controlled arrays only.",
            "No evidence of real-case frequency, segmentation harm, or proposed-method superiority.",
            "Opening removes change-map voxels, not directly segmentation voxels; downstream fallback/refinement can compensate.",
            "nnunetv2 absent: empty_cache substituted with CPU-only no-op; tensor operations unchanged."],
        "versions": {"torch": torch.__version__, "numpy": version("numpy"), "nnunetv2": version("nnunetv2"),
            "nnInteractive_installed": version("nnInteractive")},
        "device": "cpu", "detector_dtype": "uint8", "opening_dtype": "float16",
        "source_functions": [detector_source, pool_source],
        "detector_call": "_detect_change_at_border(SimpleNamespace(verbose=False), pred, previous)",
        "opening_calls": ["iterative_3x3_same_padding_pool3d(x, kernel_size=5, use_min_pool=True)",
            "iterative_3x3_same_padding_pool3d(eroded, kernel_size=5, use_min_pool=False)"],
        "border_results": border_results, "opening_results": opening_results, "assertions_passed": True}
    (OUT / "mechanism-probe-results.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"assertions_passed": True, "border_cases": len(border_results),
        "opening_cases": len(opening_results), "device": "cpu"}))

if __name__ == "__main__":
    main()
