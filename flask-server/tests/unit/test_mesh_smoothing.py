"""Organ meshes are smoothed and stored with normals; CancerVerse tumor meshes are not."""
from __future__ import annotations

import io
import json
import struct

import nibabel as nib
import numpy as np
import pytest
import trimesh
from flask import Flask

import api.api_blueprint as api_routes
from constants import Constants
from services import mesh_generation
from services.label_scheme import VIEWER_LABELS

IDENTITY = np.eye(4)


def ball(radius: int) -> np.ndarray:
    size = 2 * radius + 6
    z, y, x = np.mgrid[:size, :size, :size]
    middle = (size - 1) / 2
    return (((x - middle) ** 2 + (y - middle) ** 2 + (z - middle) ** 2) <= radius**2).astype(np.int32)


def build(data: np.ndarray, label_id: int = 1, smooth: bool = True):
    center = mesh_generation.compute_global_center(data, IDENTITY)
    mesh = mesh_generation._build_organ_mesh(data, IDENTITY, label_id, center, smooth=smooth)
    return mesh, center


def on_voxel_steps(vertices: np.ndarray, center: np.ndarray) -> bool:
    """Marching cubes over a 0/1 mask puts every vertex on a half-voxel grid."""
    doubled = (np.asarray(vertices, dtype=np.float64) + center) * 2
    return bool(np.allclose(doubled, np.round(doubled), atol=1e-4))


def glb_attributes(payload: bytes) -> dict:
    length = struct.unpack("<I", payload[12:16])[0]
    return json.loads(payload[20 : 20 + length])["meshes"][0]["primitives"][0]["attributes"]


def glb_vertices(payload: bytes) -> np.ndarray:
    scene = trimesh.load(io.BytesIO(payload), file_type="glb")
    return np.vstack([geometry.vertices for geometry in scene.geometry.values()])


@pytest.mark.parametrize("radius", [4, 8])
def test_smoothing_takes_off_the_voxel_steps_and_keeps_the_volume(radius):
    raw, center = build(ball(radius), smooth=False)
    smoothed, _ = build(ball(radius))
    assert on_voxel_steps(raw.vertices, center)
    assert not on_voxel_steps(smoothed.vertices, center)
    assert abs(smoothed.volume / raw.volume - 1) < 0.005
    assert (len(smoothed.vertices), len(smoothed.faces)) == (len(raw.vertices), len(raw.faces))


@pytest.mark.parametrize("extent", [1, 2])
def test_a_label_of_a_voxel_or_two_stays_small(extent):
    data = np.zeros((8, 8, 8), dtype=np.int32)
    data[2 : 2 + extent, 2 : 2 + extent, 2 : 2 + extent] = 1
    raw, _ = build(data, smooth=False)
    smoothed, _ = build(data)
    assert np.isfinite(smoothed.vertices).all()
    assert (smoothed.extents < raw.extents * 1.5).all()


def write_mask(path, data: np.ndarray):
    image = nib.Nifti1Image(data.astype(np.uint8), IDENTITY)
    image.set_data_dtype(np.uint8)
    nib.save(image, str(path))
    return path


def tumor_volume() -> np.ndarray:
    data = np.zeros((40, 24, 24), dtype=np.int32)
    data[4:16, 4:18, 4:18] = 33  # liver lesion
    data[22:34, 6:16, 6:16] = 36  # stomach lesion, a CancerVerse tumor type
    return data


def test_organ_glbs_carry_normals_and_cancerverse_tumor_types_keep_their_surface(tmp_path):
    data = tumor_volume()
    data[2:4, 2:10, 2:10] = 1
    mask = write_mask(tmp_path / "labels.nii.gz", data)
    center = mesh_generation.compute_global_center(data, IDENTITY)

    organ = mesh_generation.generate_organ_glb_bytes(VIEWER_LABELS[1]["key"], str(mask))
    assert "NORMAL" in glb_attributes(organ)
    assert not on_voxel_steps(glb_vertices(organ), center)

    assert mesh_generation.UNSMOOTHED_LABELS == set(range(36, 45))
    tumor = mesh_generation.generate_organ_glb_bytes("stomach_lesion", str(mask))
    assert "NORMAL" not in glb_attributes(tumor)
    assert on_voxel_steps(glb_vertices(tumor), center)

    unsmoothed = mesh_generation.generate_organ_glb_bytes("liver_lesion", str(mask), smooth=False)
    assert "NORMAL" not in glb_attributes(unsmoothed)
    assert on_voxel_steps(glb_vertices(unsmoothed), center)


def test_cancerverse_mesh_routes_bake_and_regenerate_unsmoothed(tmp_path, monkeypatch):
    case = "CV_00000007"
    mask = write_mask(tmp_path / "combined_labels.nii.gz", tumor_volume())
    center = mesh_generation.compute_global_center(tumor_volume(), IDENTITY)
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    monkeypatch.setattr(api_routes, "_cancerverse_mask", lambda _case_id: (case, str(mask)))
    app = Flask(__name__)
    app.register_blueprint(api_routes.api_blueprint, url_prefix="/api")
    client = app.test_client()

    manifest = client.get(f"/api/cases/{case}/mesh-manifest")
    assert manifest.status_code == 200, manifest.get_data(as_text=True)[:300]
    organs = manifest.get_json()["organs"]
    assert {organ["id"] for organ in organs} == {33, 36}
    for organ in organs:
        glb = client.get(organ["url"]).get_data()
        assert "NORMAL" not in glb_attributes(glb)
        assert on_voxel_steps(glb_vertices(glb), center)

    (tmp_path / "meshes" / case / "liver_lesion.glb").unlink()
    regenerated = client.get(f"/api/cases/{case}/render_only/liver_lesion.glb")
    assert regenerated.status_code == 200
    assert "NORMAL" not in glb_attributes(regenerated.get_data())
    assert on_voxel_steps(glb_vertices(regenerated.get_data()), center)
