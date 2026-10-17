"""Unit tests for services/model_provenance.py: checkpoint identity, settings, label support, code version.

The drift guards read services/auto_segmentor.py and scripts/*_predict.py as text: provenance repeats a few
literals from them (checkpoint defaults, step size, TTA), and a stale copy would record settings that were
not the ones used.
"""
import hashlib
import os
import re
import subprocess
from pathlib import Path

import pytest

import services.model_provenance as mp

SERVER = Path(__file__).resolve().parents[2]
SEGMENTOR = (SERVER / "services" / "auto_segmentor.py").read_text(encoding="utf-8")


def real_names():
    from services.auto_segmentor import _VIEWER_LABELS
    return {v: k for k, v in _VIEWER_LABELS.items()}


def _function_source(text, name):
    m = re.search(rf"^def {name}\(.*?(?=^def |\Z)", text, re.S | re.M)
    assert m, f"{name} not found"
    return m.group(0)


# ----------------------------- drift guards -----------------------------
@pytest.mark.parametrize("model,runner", [("ePAI", "_run_epai_inference"), ("Atlas-Net", "_run_atlasnet_inference"),
                                           ("LesionSegmenter", "_run_lesionsegmenter_inference")])
def test_checkpoint_env_and_default_match_the_runner(model, runner):
    var, default = mp.MODEL_CHECKPOINT[model]
    body = _function_source(SEGMENTOR, runner)
    assert re.search(rf'os\.getenv\(\s*"{var}",\s*"{re.escape(default)}"\s*,?\s*\)', body), \
        f"{runner} no longer reads {var} with this default"


def test_fixed_command_line_settings_match_the_runners():
    lesion = _function_source(SEGMENTOR, "_run_lesionsegmenter_inference")
    s = mp.inference_settings("LesionSegmenter", env={})
    assert f'-step_size {s["step_size"]} ' in lesion and ("--disable_tta" in lesion) == s["disable_tta"]
    assert '-chk checkpoint_final.pth' in lesion
    atlas = _function_source(SEGMENTOR, "_run_atlasnet_inference")
    assert "-f all" in atlas and "-chk checkpoint_final.pth" in atlas
    assert "-step_size" not in atlas and "--disable_tta" not in atlas      # so nnU-Net's defaults apply
    s = mp.inference_settings("Atlas-Net", env={})
    assert s["step_size"] == 0.5 and s["disable_tta"] is False and s["nnunet_defaults"] is True
    epai = _function_source(SEGMENTOR, "_run_epai_inference")
    assert "-f all" in epai and "EPAI_CHECKPOINT_NAME" in epai


def test_environment_defaults_match_the_predict_scripts():
    epai = (SERVER / "scripts" / "epai_predict.py").read_text(encoding="utf-8")
    for var, default in (("EPAI_STEP_SIZE", "0.5"), ("EPAI_DISABLE_TTA", "0"), ("EPAI_CHECKPOINT_NAME", "checkpoint_final.pth")):
        assert re.search(rf'os\.getenv\("{var}",\s*"{re.escape(default)}"', epai), var
    warm = (SERVER / "scripts" / "epai_warm_server.py").read_text(encoding="utf-8")
    assert re.search(r'os\.environ\.get\("EPAI_TRT_PLAN_PATH",\s*""', warm)     # the engine path the ePAI runner uses
    lesion = (SERVER / "scripts" / "lesionseg_predict.py").read_text(encoding="utf-8")
    for var, default in (("LESIONSEG_LESION_THRESHOLD", "0.05"), ("LESIONSEG_LESION_CHANNEL", "40")):
        assert re.search(rf'os\.environ\.get\("{var}",\s*"{re.escape(default)}"', lesion), var
    s = mp.inference_settings("ePAI", env={})
    assert (s["step_size"], s["disable_tta"], s["checkpoint_name"]) == (0.5, False, "checkpoint_final.pth")
    s = mp.inference_settings("LesionSegmenter", env={})
    assert (s["lesion_threshold"], s["lesion_channel"]) == (0.05, 40)


# ----------------------------- settings -----------------------------
def test_settings_follow_the_environment():
    s = mp.inference_settings("ePAI", env={"EPAI_STEP_SIZE": "0.7", "EPAI_DISABLE_TTA": "yes", "EPAI_TTA_AXES": " 0,1 ",
                                           "EPAI_CHECKPOINT_NAME": "checkpoint_best.pth", "EPAI_TRT_PLAN_PATH": "/p/plan.trt"})
    assert s == {"folds": "all", "step_size": 0.7, "disable_tta": True, "tta_axes": "0,1",
                 "checkpoint_name": "checkpoint_best.pth", "tensorrt_plan": "/p/plan.trt"}
    s = mp.inference_settings("LesionSegmenter", env={"LESIONSEG_LESION_THRESHOLD": "0.2", "LESIONSEG_LESION_CHANNEL": "41"})
    assert s["lesion_threshold"] == 0.2 and s["lesion_channel"] == 41
    assert mp.inference_settings("SuPreM", env={}) is None


# ----------------------------- checkpoint identity -----------------------------
def _model_folder(tmp_path, weights=b"w" * 1000, plans=b'{"plans": 1}'):
    root = tmp_path / "model"
    (root / "fold_all").mkdir(parents=True)
    (root / "fold_all" / "checkpoint_final.pth").write_bytes(weights)
    (root / "plans.json").write_bytes(plans)
    (root / "dataset.json").write_bytes(b"{}")
    return root


def test_checkpoint_fingerprint_hashes_weights_and_plans(tmp_path):
    root = _model_folder(tmp_path)
    fp = mp.checkpoint_fingerprint("LesionSegmenter", env={"LESIONSEG_CKPT_PATH": str(root)})
    assert fp["hashed"] is True and fp["path"] == str(root)
    assert fp["files"]["fold_all/checkpoint_final.pth"] == {"sha256": hashlib.sha256(b"w" * 1000).hexdigest(), "size_bytes": 1000}
    assert fp["files"]["plans.json"]["sha256"] == hashlib.sha256(b'{"plans": 1}').hexdigest()
    assert set(fp["files"]) == {"fold_all/checkpoint_final.pth", "plans.json", "dataset.json"}


def test_checkpoint_in_the_model_folder_itself_is_found(tmp_path):
    root = tmp_path / "flat"; root.mkdir()
    (root / "checkpoint_final.pth").write_bytes(b"x")
    fp = mp.checkpoint_fingerprint("Atlas-Net", env={"ATLASNET_CKPT_PATH": str(root)})
    assert fp["hashed"] is True and list(fp["files"]) == ["checkpoint_final.pth"]


def test_hash_is_cached_until_the_file_changes(tmp_path, monkeypatch):
    root = _model_folder(tmp_path)
    env = {"LESIONSEG_CKPT_PATH": str(root)}
    calls = []
    real = mp._sha256_file
    monkeypatch.setattr(mp, "_sha256_file", lambda p, *a, **k: calls.append(p) or real(p, *a, **k))
    mp._hash_cache.clear()
    first = mp.checkpoint_fingerprint("LesionSegmenter", env=env)
    assert len(calls) == 3
    again = mp.checkpoint_fingerprint("LesionSegmenter", env=env)
    assert len(calls) == 3 and again == first                     # no re-read for the next scan
    weights = root / "fold_all" / "checkpoint_final.pth"
    weights.write_bytes(b"retrained weights")                      # a new checkpoint under the same name
    changed = mp.checkpoint_fingerprint("LesionSegmenter", env=env)
    assert len(calls) == 4
    assert changed["files"]["fold_all/checkpoint_final.pth"]["sha256"] == hashlib.sha256(b"retrained weights").hexdigest()
    assert changed["files"]["fold_all/checkpoint_final.pth"]["sha256"] != first["files"]["fold_all/checkpoint_final.pth"]["sha256"]
    assert len([k for k in mp._hash_cache if k[0] == str(weights)]) == 1       # the stale entry is dropped


def test_checkpoint_that_cannot_be_read_says_why(tmp_path):
    fp = mp.checkpoint_fingerprint("ePAI", env={"EPAI_CKPT_PATH": str(tmp_path / "missing")})
    assert fp["hashed"] is False and "not found" in fp["reason"]
    empty = tmp_path / "empty"; empty.mkdir()
    fp = mp.checkpoint_fingerprint("ePAI", env={"EPAI_CKPT_PATH": str(empty)})
    assert fp["hashed"] is False and "checkpoint_final.pth not found" in fp["reason"]
    fp = mp.checkpoint_fingerprint("ePAI", env={"EPAI_CKPT_PATH": str(empty), "EPAI_CHECKPOINT_NAME": "best.pth"})
    assert "best.pth not found" in fp["reason"]                              # honours the configured file name
    assert mp.checkpoint_fingerprint("SuPreM", env={}) == {"hashed": False, "reason": "no checkpoint rule for this model"}


def test_epai_tensorrt_engine_is_fingerprinted_when_configured(tmp_path):
    root = _model_folder(tmp_path)
    plan = tmp_path / "epai_fp16.plan"; plan.write_bytes(b"engine-bytes")
    env = {"EPAI_CKPT_PATH": str(root), "EPAI_TRT_PLAN_PATH": str(plan)}
    fp = mp.checkpoint_fingerprint("ePAI", env=env)
    assert fp["files"]["tensorrt_plan"] == {"sha256": hashlib.sha256(b"engine-bytes").hexdigest(), "size_bytes": 12, "path": str(plan)}
    assert "fold_all/checkpoint_final.pth" in fp["files"] and "tensorrt_plan_missing" not in fp
    gone = mp.checkpoint_fingerprint("ePAI", env={**env, "EPAI_TRT_PLAN_PATH": str(tmp_path / "gone.plan")})
    assert gone["hashed"] is True and "tensorrt_plan" not in gone["files"] and gone["tensorrt_plan_missing"].endswith("gone.plan")
    assert "tensorrt_plan" not in mp.checkpoint_fingerprint("ePAI", env={"EPAI_CKPT_PATH": str(root)})["files"]
    # only ePAI has an engine: the setting is ignored for the other models
    other = mp.checkpoint_fingerprint("Atlas-Net", env={"ATLASNET_CKPT_PATH": str(root), "EPAI_TRT_PLAN_PATH": str(plan)})
    assert "tensorrt_plan" not in other["files"]


def test_remote_epai_is_not_claimed_as_the_local_checkpoint(tmp_path):
    root = _model_folder(tmp_path)
    fp = mp.checkpoint_fingerprint("ePAI", env={"EPAI_CKPT_PATH": str(root), "EPAI_REMOTE_ENABLED": "true",
                                                "EPAI_REMOTE_CKPT_PATH": "/remote/ckpt"})
    assert fp["hashed"] is False and fp["path"] == "/remote/ckpt" and "remote host" in fp["reason"]


# ----------------------------- label support -----------------------------
def test_label_support_separates_not_found_from_never_looked_for():
    atlas = mp.label_support("Atlas-Net", real_names(), (22, 33, 34, 35))
    assert atlas["known"] is True
    assert atlas["lesion_labels_assessed"] == ["pancreatic_lesion"]
    assert atlas["lesion_labels_not_assessed"] == ["liver_lesion", "kidney_lesion", "colon_lesion"]
    lesion = mp.label_support("LesionSegmenter", real_names(), (22, 33, 34, 35))
    assert lesion["lesion_labels_assessed"] == ["pancreatic_lesion", "liver_lesion", "kidney_lesion", "colon_lesion"]
    assert lesion["lesion_labels_not_assessed"] == []
    assert set(lesion["produces"]).isdisjoint(lesion["cannot_produce"])
    assert sorted(lesion["produces_ids"]) == lesion["produces_ids"] and lesion["source"].endswith("MODEL_TO_VIEWER")


def test_label_support_uses_the_runners_own_table():
    from services.auto_segmentor import MODEL_TO_VIEWER
    names = real_names()
    for model in ("ePAI", "Atlas-Net", "LesionSegmenter"):
        got = mp.label_support(model, names, (22, 33, 34, 35))
        assert got["produces_ids"] == sorted(set(MODEL_TO_VIEWER[model].values()))
    atlas = mp.label_support("Atlas-Net", names)
    assert "pancreas_head" in atlas["cannot_produce"] and "pancreas" in atlas["produces"]


def test_label_support_refuses_to_mislabel_models_with_their_own_ids():
    names = real_names()
    got = mp.label_support("MedIA-Agentic-Vertebrae", names, (22, 33, 34, 35))
    assert got["known"] is False and "outside" in got["reason"] and "produces" not in got
    assert mp.label_support("NoSuchModel", names)["known"] is False


# ----------------------------- code version -----------------------------
def test_code_version_override_and_git(tmp_path, monkeypatch):
    # Keep a developer home-directory checkout from enclosing the non-repo fixture.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    assert mp.code_version(env={"BODYMAPS_CODE_VERSION": "release-7"}) == {
        "commit": "release-7", "dirty": None, "source": "BODYMAPS_CODE_VERSION"}
    if subprocess.run(["git", "--version"], capture_output=True).returncode != 0:
        pytest.skip("git not available")
    repo = tmp_path / "repo"; repo.mkdir()
    run = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, text=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    (repo / "f.txt").write_text("1"); run("add", "."); run("commit", "-q", "-m", "one")
    head = run("rev-parse", "HEAD").stdout.strip()
    mp._version_cache.clear()
    v = mp.code_version(str(repo), env={})
    assert v == {"commit": head, "dirty": False, "source": "git"}
    (repo / "f.txt").write_text("2")                                   # a later edit does not change the cached answer
    assert mp.code_version(str(repo), env={}) is v
    mp._version_cache.clear()
    assert mp.code_version(str(repo), env={})["dirty"] is True
    mp._version_cache.clear()
    elsewhere = tmp_path / "not_a_repo"; elsewhere.mkdir()
    assert mp.code_version(str(elsewhere), env={})["commit"] is None


def test_describe_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk on fire")
    monkeypatch.setattr(mp, "provenance", boom)
    out = mp.describe("LesionSegmenter", real_names(), (22,))
    assert out["provenance"] == {"error": "RuntimeError: disk on fire"}
    assert out["label_support"]["known"] is True
