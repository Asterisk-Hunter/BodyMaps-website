"""scripts/bake_dataset_meshes.py: bake every case's 3D meshes ahead of time, resumably, without hurting the disk."""
import json
import os
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

pytest.importorskip("trimesh")
pytest.importorskip("skimage")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import bake_dataset_meshes as B  # noqa: E402
from services.label_scheme import SCHEME, to_viewer  # noqa: E402


def labels(*ids):
    data = np.zeros((12, 12, 12), dtype=np.uint8)
    for i, label in enumerate(ids):
        data[1 + 3 * i:3 + 3 * i, 1:5, 1:5] = label
    return data


def save_mask(root: Path, case: str, data: np.ndarray):
    path = root / "mask_only" / case / B.MASK_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))
    return path


@pytest.fixture()
def world(tmp_path):
    pants, cv, at = tmp_path / "pants", tmp_path / "cv", tmp_path / "at"
    save_mask(pants, "PanTS_00000001", labels(1, 14))
    save_mask(pants, "PanTS_00000002", labels(14))
    (pants / "mask_only" / "PanTS_00000003").mkdir(parents=True)          # no mask file
    (pants / "mask_only" / "notes").mkdir(parents=True)                    # not a case
    save_mask(cv, "CV_00000001", labels(33))
    save_mask(at, "BDMAP_00000001", labels(14, 33))
    return {"pants": pants, "cv": cv, "at": at, "mesh": tmp_path / "mesh"}


def run(world, dataset="pants", *extra, data="pants"):
    return B.main(["--dataset", dataset, "--data-root", str(world[data]), "--mesh-root", str(world["mesh"]),
                   "--min-free-gb", "0", *extra])


def manifest(world, case):
    return json.loads((world["mesh"] / case / "manifest.json").read_text())


def test_cases_are_the_folders_that_have_a_mask_file(world):
    assert B.list_cases("pants", str(world["pants"])) == ["PanTS_00000001", "PanTS_00000002"]
    assert B.list_cases("pants", str(world["pants"]), ["PanTS_00000002", "PanTS_00000009"]) == ["PanTS_00000002"]
    assert B.list_cases("cancerverse", str(world["cv"])) == ["CV_00000001"]
    assert B.list_cases("abdomenatlas", str(world["at"])) == ["BDMAP_00000001"]
    assert B.list_cases("cancerverse", str(world["pants"])) == []         # ids are matched per dataset


def test_a_pants_case_gets_viewer_numbered_meshes_a_manifest_and_leaves_no_scratch_behind(world):
    assert run(world) == 0
    raw = labels(1, 14)
    want = sorted(int(v) for v in np.unique(to_viewer(raw)) if v)
    m = manifest(world, "PanTS_00000001")
    assert m["labelScheme"] == SCHEME and sorted(o["id"] for o in m["organs"]) == want
    assert "bounds" in m and m["caseId"] == "PanTS_00000001"
    for organ in m["organs"]:
        assert (world["mesh"] / "PanTS_00000001" / os.path.basename(organ["url"])).read_bytes()[:4] == b"glTF"
        assert organ["url"].startswith("/api/cases/PanTS_00000001/render_only/")
    assert manifest(world, "PanTS_00000002")["organs"]
    assert not [p for p in (world["mesh"] / ".bake-tmp").iterdir()] if (world["mesh"] / ".bake-tmp").exists() else True


def test_a_second_run_skips_finished_cases_and_force_rebakes_them(world, capsys):
    run(world)
    path = world["mesh"] / "PanTS_00000001" / "manifest.json"
    first = path.stat().st_mtime_ns
    capsys.readouterr()
    assert run(world) == 0
    assert "baked=0 skipped=2 error=0" in capsys.readouterr().out
    assert path.stat().st_mtime_ns == first
    assert run(world, "pants", "--force") == 0
    assert path.stat().st_mtime_ns > first


def test_an_incomplete_case_is_rebaked_and_a_legacy_one_only_when_asked(world, capsys):
    run(world)
    folder = world["mesh"] / "PanTS_00000001"
    victim = next(p for p in folder.iterdir() if p.suffix == ".glb")
    victim.unlink()
    assert B.manifest_state(str(folder), str(world["pants"] / "mask_only" / "PanTS_00000001" / B.MASK_NAME), False) == "incomplete"
    capsys.readouterr()
    run(world)
    assert victim.exists() and "baked=1 skipped=1" in capsys.readouterr().out

    legacy = manifest(world, "PanTS_00000002")
    legacy.pop("labelScheme")
    (world["mesh"] / "PanTS_00000002" / "manifest.json").write_text(json.dumps(legacy))
    run(world)
    assert "labelScheme" not in manifest(world, "PanTS_00000002")                  # the site relabels these: left alone
    run(world, "pants", "--refresh-legacy")
    assert manifest(world, "PanTS_00000002")["labelScheme"] == SCHEME


def test_a_case_whose_mask_is_newer_than_its_meshes_is_baked_again(world):
    run(world)
    mask = world["pants"] / "mask_only" / "PanTS_00000001" / B.MASK_NAME
    path = world["mesh"] / "PanTS_00000001" / "manifest.json"
    past = path.stat().st_mtime - 100
    os.utime(path, (past, past))
    state = B.manifest_state(str(path.parent), str(mask), False)
    assert state == "stale"
    run(world)
    assert path.stat().st_mtime > past + 50


def test_cancerverse_tumors_stay_unsmoothed_and_the_others_are_smoothed(world, monkeypatch):
    seen = []

    def record(case, source, out_dir, route_base="cases", smooth=True):
        seen.append((case, route_base, smooth))
        os.makedirs(out_dir, exist_ok=True)
        (Path(out_dir) / "manifest.json").write_text(json.dumps({"organs": [], "bounds": {}, "labelScheme": SCHEME}))
        return {"organs": []}

    import services.mesh_generation as mesh_generation
    monkeypatch.setattr(mesh_generation, "bake_case_meshes", record)
    run(world, "cancerverse", data="cv")
    run(world, "abdomenatlas", data="at")
    run(world, "pants")
    assert ("CV_00000001", "cases", False) in seen and ("BDMAP_00000001", "cases", True) in seen
    assert {case for case, _, smooth in seen if case.startswith("PanTS") and smooth} == {"PanTS_00000001", "PanTS_00000002"}


def test_a_broken_mask_is_reported_and_the_rest_are_still_baked(world, capsys):
    (world["pants"] / "mask_only" / "PanTS_00000001" / B.MASK_NAME).write_bytes(b"not a nifti")
    capsys.readouterr()
    assert run(world) == 1
    out = capsys.readouterr().out
    assert "[error] PanTS_00000001" in out and "baked=1" in out and "error=1" in out
    assert (world["mesh"] / "PanTS_00000002" / "manifest.json").exists()


def test_the_run_stops_when_the_disk_is_nearly_full_and_resumes_later(world, monkeypatch, capsys):
    monkeypatch.setattr(B, "free_gb", lambda path: 5.0)
    assert B.main(["--dataset", "pants", "--data-root", str(world["pants"]), "--mesh-root", str(world["mesh"]),
                   "--min-free-gb", "100"]) == 2
    out = capsys.readouterr().out
    assert "STOPPED" in out and "baked=0" in out
    assert not (world["mesh"] / "PanTS_00000001" / "manifest.json").exists()


def test_a_stop_file_halts_the_run_cleanly_and_removing_it_resumes(world, tmp_path, capsys):
    stop = tmp_path / "STOP"
    stop.write_text("")
    assert run(world, "pants", "--stop-file", str(stop)) == 3
    out = capsys.readouterr().out
    assert "STOPPED by" in out and "baked=0" in out
    assert not (world["mesh"] / "PanTS_00000001" / "manifest.json").exists()
    stop.unlink()
    assert run(world, "pants", "--stop-file", str(stop)) == 0
    assert (world["mesh"] / "PanTS_00000001" / "manifest.json").exists()


def test_dry_run_lists_the_work_and_writes_nothing(world, capsys):
    assert run(world, "pants", "--dry-run") == 0
    out = capsys.readouterr().out
    assert "would bake 2 of 2" in out and "PanTS_00000001" in out
    assert not world["mesh"].exists()
    run(world)
    capsys.readouterr()
    run(world, "pants", "--dry-run")
    assert "would bake 0 of 2" in capsys.readouterr().out


def test_limit_and_only_narrow_the_run(world):
    run(world, "pants", "--limit", "1")
    assert (world["mesh"] / "PanTS_00000001" / "manifest.json").exists()
    assert not (world["mesh"] / "PanTS_00000002").exists()
    run(world, "pants", "--only", "PanTS_00000002")
    assert (world["mesh"] / "PanTS_00000002" / "manifest.json").exists()


@pytest.mark.skipif(os.name == "nt", reason="the pool imports this module in a spawned process; CI runs on Linux")
def test_several_workers_bake_the_same_set(world, capsys):
    assert run(world, "pants", "--workers", "2") == 0
    assert "baked=2 skipped=0 error=0" in capsys.readouterr().out


def test_a_dataset_without_a_configured_folder_asks_for_one(monkeypatch):
    from constants import Constants
    monkeypatch.setattr(Constants, "ABDOMENATLAS_OVERLAY_PATH", "")
    with pytest.raises(SystemExit):
        B.mask_root("abdomenatlas", None)


# ------------------------------------------------- AbdomenAtlas: the second map (liver segments, hepatic vessels)
def save_parts(root: Path, case: str, data: np.ndarray, affine=None):
    path = root / "mask_only" / case / B.PARTS_MASK
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(data, np.eye(4) if affine is None else affine), str(path))
    return path


def parts_labels():
    data = np.zeros((12, 12, 12), dtype=np.uint8)
    data[1:4, 6:10, 6:10] = 51      # liver segment 1
    data[5:8, 6:10, 6:10] = 50      # hepatic vessel
    return data


def test_the_parts_meshes_join_the_manifest_on_the_same_centre(world):
    save_parts(world["at"], "BDMAP_00000001", parts_labels())
    assert run(world, "abdomenatlas", data="at") == 0
    m = manifest(world, "BDMAP_00000001")
    by_key = {o["key"]: o for o in m["organs"]}
    assert {"liver", "liver_lesion", "liver_segment_1", "hepatic_vessel"} <= set(by_key)
    assert by_key["liver_segment_1"]["id"] == 51 and by_key["hepatic_vessel"]["id"] == 50
    assert [o["id"] for o in m["organs"]] == sorted(o["id"] for o in m["organs"])
    assert m["partsBaked"] is True and m["labelScheme"] == SCHEME
    for key in ("liver_segment_1", "hepatic_vessel"):
        glb = world["mesh"] / "BDMAP_00000001" / os.path.basename(by_key[key]["url"])
        assert glb.read_bytes()[:4] == b"glTF"
        assert by_key[key]["url"].startswith("/api/cases/BDMAP_00000001/render_only/")
    # the centre is the main map's, so the parts line up with the liver mesh
    main_only = world["mesh"].parent / "main_only"
    other = {"at": world["at"], "mesh": main_only}
    (main_only / "BDMAP_00000001").mkdir(parents=True)
    from services.mesh_generation import bake_case_meshes
    ref = bake_case_meshes("BDMAP_00000001", str(world["at"] / "mask_only" / "BDMAP_00000001" / B.MASK_NAME),
                           str(main_only / "BDMAP_00000001"))
    assert m["center"] == ref["center"] and other


def test_parts_are_added_to_a_case_that_is_already_baked_without_touching_its_other_meshes(world, capsys):
    assert run(world, "abdomenatlas", data="at") == 0
    liver_glb = world["mesh"] / "BDMAP_00000001" / "liver.glb"
    before = liver_glb.stat().st_mtime_ns
    assert "partsBaked" not in manifest(world, "BDMAP_00000001")
    save_parts(world["at"], "BDMAP_00000001", parts_labels())
    capsys.readouterr()
    assert run(world, "abdomenatlas", data="at") == 0
    assert "baked=1 skipped=0" in capsys.readouterr().out
    assert liver_glb.stat().st_mtime_ns == before, "the main meshes are not rebaked for the parts"
    assert {"liver_segment_1", "hepatic_vessel"} <= {o["key"] for o in manifest(world, "BDMAP_00000001")["organs"]}
    capsys.readouterr()
    assert run(world, "abdomenatlas", data="at") == 0
    assert "baked=0 skipped=1" in capsys.readouterr().out, "and a third run has nothing left to do"


def test_a_rebaked_main_map_gets_its_parts_again(world):
    save_parts(world["at"], "BDMAP_00000001", parts_labels())
    assert run(world, "abdomenatlas", data="at") == 0
    assert run(world, "abdomenatlas", "--force", data="at") == 0
    keys = {o["key"] for o in manifest(world, "BDMAP_00000001")["organs"]}
    assert {"liver_segment_1", "hepatic_vessel"} <= keys


def test_a_parts_map_on_another_grid_is_an_error_and_the_case_keeps_a_valid_manifest(world, capsys):
    shifted = np.eye(4)
    shifted[0, 3] = 3.0
    save_parts(world["at"], "BDMAP_00000001", parts_labels(), affine=shifted)
    capsys.readouterr()
    assert run(world, "abdomenatlas", data="at") == 1
    assert "[error] BDMAP_00000001" in capsys.readouterr().out
    m = manifest(world, "BDMAP_00000001")                       # the main meshes were baked before the parts failed
    assert {"liver", "liver_lesion"} <= {o["key"] for o in m["organs"]}
    assert "partsBaked" not in m


def test_other_datasets_never_look_for_a_parts_map(world):
    save_parts(world["pants"], "PanTS_00000001", np.zeros((12, 12, 12), dtype=np.uint8) + 50)
    assert run(world) == 0
    assert "partsBaked" not in manifest(world, "PanTS_00000001")


def test_the_parts_meshes_are_placed_with_the_main_meshes_centre(world):
    """Not just the manifest: the vertices of a parts mesh must be those a main-map bake would give, i.e. measured from the same centre."""
    import trimesh
    from services import mesh_generation as M

    data = parts_labels()
    save_parts(world["at"], "BDMAP_00000001", data)
    assert run(world, "abdomenatlas", data="at") == 0
    m = manifest(world, "BDMAP_00000001")
    by_key = {o["key"]: o for o in m["organs"]}
    glb = world["mesh"] / "BDMAP_00000001" / os.path.basename(by_key["liver_segment_1"]["url"])
    got = trimesh.load(str(glb), file_type="glb", force="mesh").bounds
    want = M._build_organ_mesh(data.astype(np.int32), np.eye(4), 51, np.asarray(m["center"]), smooth=True).bounds
    assert np.allclose(got, want, atol=1e-3)
    own_centre = M.compute_global_center(data.astype(np.int32), np.eye(4))
    other = M._build_organ_mesh(data.astype(np.int32), np.eye(4), 51, own_centre, smooth=True).bounds
    assert not np.allclose(got, other, atol=1e-3), "the test must tell the main centre from the parts map's own"
