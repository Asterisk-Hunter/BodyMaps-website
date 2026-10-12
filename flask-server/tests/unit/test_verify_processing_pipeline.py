"""Isolated review CLI: tiny real NIfTI files, injected model execution only."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
from types import SimpleNamespace
from unittest.mock import Mock
import zipfile

import nibabel as nib
import numpy as np
import pytest

from services import inference_pipeline as pipeline


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/verify_processing_pipeline.py"
spec = importlib.util.spec_from_file_location("verify_processing_pipeline", SCRIPT)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def volume(path, data, affine=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(data, np.eye(4) if affine is None else affine), str(path))
    return path


@pytest.fixture
def rig(tmp_path, monkeypatch):
    # The CLI intentionally configures its own process; do not let an injected
    # in-process review alter the rest of the test suite's environment.
    monkeypatch.setattr(os, "environ", dict(os.environ))
    monkeypatch.setattr(sys, "dont_write_bytecode", sys.dont_write_bytecode)
    monkeypatch.setattr(pipeline, "stage_availability", lambda model: (True, None))
    original = volume(tmp_path / "approved.nii.gz", np.full((4, 5, 6), -100, np.float32))
    original_bytes = original.read_bytes()
    calls = []
    masks = np.zeros((4, 5, 6), dtype=np.uint8)
    masks[1:3, 1:4, 1:5] = 14
    masks[1, 2, 2] = 22

    def dispatch(source, session_dir, model, session_id, on_start):
        calls.append({"source": source, "session_dir": session_dir, "model": model, "session_id": session_id})
        assert on_start() is True
        destination = Path(session_dir) / "outputs"
        if model == "OpenVAE":
            volume(destination / "reconstructed_ct.nii.gz", np.full((4, 5, 6), -80, np.float32))
        else:
            volume(destination / "combined_labels.nii.gz", masks.copy())
            if model == "ePAI":
                (destination / "output.csv").write_text("raw model measurements\n")
        return str(destination)

    args = dict(input_path=original, output=tmp_path / "new-review", model="ePAI",
                preprocessing="OpenVAE", postprocessing="ShapeKit", execute=True,
                dispatch=dispatch, cancel_session=Mock(), availability=lambda model: (True, None),
                pipeline_module=pipeline)
    return args, calls, original_bytes


def test_default_preflight_does_not_dispatch_create_output_or_import_adapter(rig, monkeypatch):
    args, calls, _ = rig
    loader = Mock(side_effect=AssertionError("preflight imported the adapter"))
    monkeypatch.setattr(verifier, "_real_adapter", loader)
    args.pop("execute")
    result = verifier.review(**args)
    assert result["mode"] == "preflight" and result["available"] is True
    assert result["output_created"] is False
    assert not args["output"].exists()
    assert not calls
    loader.assert_not_called()


def test_full_pipeline_packages_real_provenance_and_preserves_original(rig):
    args, calls, original_bytes = rig
    result = verifier.review(**args)
    assert result["status"] == "completed"
    assert [call["model"] for call in calls] == ["OpenVAE", "ePAI", "ShapeKit"]
    assert len({call["session_id"] for call in calls}) == 1
    assert all(Path(call["session_dir"]).is_relative_to(args["output"]) for call in calls)
    assert Path(calls[0]["source"]) != args["input_path"]
    assert args["input_path"].read_bytes() == original_bytes
    assert result["checks"]["original_unchanged"] is True
    assert result["checks"]["staged_original_unchanged"] is True
    assert result["checks"]["protected_labels_preserved"] is True
    assert result["checks"]["protected_labels"] == [22]
    assert all(stage["status"] == "completed" for stage in result["pipeline_stages"])
    assert all(call["seconds"] >= 0 for call in result["adapter_timings_seconds"])
    assert json.loads((args["output"] / "review.json").read_text()) == result
    with zipfile.ZipFile(args["output"] / "results.zip") as archive:
        names = archive.namelist()
        assert "combined_labels.nii.gz" in names
        assert "pipeline.json" in names and "review-provenance.json" in names
        assert "segmentation_original/output.csv" in names
        assert "output.csv" not in names
        metadata = json.loads(archive.read("review-provenance.json"))
        assert metadata["accuracy_validated"] is False
        assert metadata["pipeline"]["viewer_reference"] == "original"


@pytest.mark.parametrize("model", verifier.MODELS)
def test_no_optional_stages_only_runs_selected_model(rig, model):
    args, calls, _ = rig
    args.update(model=model, preprocessing=None, postprocessing=None)
    result = verifier.review(**args)
    assert result["status"] == "completed"
    assert [call["model"] for call in calls] == [model]
    assert [stage["id"] for stage in result["pipeline_stages"]] == ["segmentation", "packaging"]


def test_existing_output_is_never_reused_or_changed(rig):
    args, calls, _ = rig
    args["output"].mkdir()
    sentinel = args["output"] / "existing.txt"
    sentinel.write_text("preserve")
    with pytest.raises(FileExistsError):
        verifier.review(**args)
    assert sentinel.read_text() == "preserve"
    assert list(args["output"].iterdir()) == [sentinel]
    assert not calls


def test_output_cannot_contain_input(rig):
    args, calls, before = rig
    args["output"] = args["input_path"].parent
    with pytest.raises(ValueError, match="cannot contain"):
        verifier.review(**args)
    assert args["input_path"].read_bytes() == before
    assert not calls


def test_unavailable_stage_preflight_and_execute_fail_without_writes(rig):
    args, calls, _ = rig
    args.update(availability=lambda model: (False, "fixture runtime unavailable"), execute=False)
    assert verifier.review(**args)["available"] is False
    args["execute"] = True
    with pytest.raises(ValueError, match="Preflight is unavailable"):
        verifier.review(**args)
    assert not calls and not args["output"].exists()


def test_changed_protected_label_fails_without_result_archive(rig):
    args, _, _ = rig
    real = args["dispatch"]
    def corrupt(*a, **kw):
        output = real(*a, **kw)
        if kw["model"] == "ShapeKit":
            image = nib.load(str(Path(output) / "combined_labels.nii.gz"))
            data = np.asanyarray(image.dataobj).copy()
            data[data == 22] = 14
            volume(Path(output) / "combined_labels.nii.gz", data)
        return output
    args["dispatch"] = corrupt
    result = verifier.review(**args)
    assert result["status"] == "failed" and "protected viewer label 22" in result["error"]
    assert not (args["output"] / "results.zip").exists()
    assert result["pipeline_stages"][-1]["status"] == "failed"


def test_shifted_segmentation_is_rejected(rig):
    args, _, _ = rig
    real = args["dispatch"]
    def shifted(*a, **kw):
        output = real(*a, **kw)
        if kw["model"] == "ePAI":
            affine = np.eye(4)
            affine[0, 3] = 20
            volume(Path(output) / "combined_labels.nii.gz", np.ones((4, 5, 6), np.uint8), affine)
        return output
    args["dispatch"] = shifted
    result = verifier.review(**args)
    assert result["status"] == "failed" and "geometry" in result["error"]
    assert not (args["output"] / "results.zip").exists()


def test_model_cannot_modify_staged_original_without_failing_review(rig):
    args, _, original_bytes = rig
    real = args["dispatch"]
    def mutate(source, **kw):
        if kw["model"] == "OpenVAE":
            volume(Path(source), np.ones((4, 5, 6), np.float32))
        return real(source, **kw)
    args["dispatch"] = mutate
    result = verifier.review(**args)
    assert result["status"] == "failed" and "Original CT bytes changed" in result["error"]
    assert args["input_path"].read_bytes() == original_bytes
    assert result["checks"]["staged_original_unchanged"] is False
    assert not (args["output"] / "results.zip").exists()


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_signal_cancels_only_review_session_and_records_state(rig, monkeypatch, signum):
    args, calls, original_bytes = rig
    handlers = {}
    def register(sig, handler):
        previous = handlers.get(sig, signal.SIG_DFL)
        handlers[sig] = handler
        return previous
    monkeypatch.setattr(verifier.signal, "signal", register)
    real = args["dispatch"]
    def interrupted(*a, **kw):
        output = real(*a, **kw)
        handlers[signum](signum, None)
        return output
    args["dispatch"] = interrupted
    result = verifier.review(**args)
    assert result["status"] == "cancelled"
    assert len(calls) == 1
    args["cancel_session"].assert_called_once_with(result["session_id"])
    assert result["pipeline_stages"][0]["status"] == "cancelled"
    assert handlers[signal.SIGTERM] == signal.SIG_DFL and handlers[signal.SIGINT] == signal.SIG_DFL
    assert args["input_path"].read_bytes() == original_bytes
    assert json.loads((args["output"] / "review.json").read_text())["status"] == "cancelled"
    assert not (args["output"] / "results.zip").exists()


def test_forces_local_execution_and_isolates_cache_paths(rig, monkeypatch):
    args, _, _ = rig
    monkeypatch.setenv("GPU_WORKERS_ENABLED", "true")
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", "true")
    monkeypatch.setenv("EPAI_SCRIPT_PATH", "unreviewed-wrapper.sh")
    result = verifier.review(**args)
    assert result["status"] == "completed"
    assert os.environ["GPU_WORKERS_ENABLED"] == "false"
    assert os.environ["EPAI_REMOTE_ENABLED"] == "false"
    assert os.environ["PYTHON_DOTENV_DISABLED"] == "1"
    assert os.environ["EPAI_SCRIPT_PATH"] == ""
    assert Path(os.environ["TORCH_HOME"]).is_relative_to(args["output"])
    assert Path(os.environ["EPAI_NNUNET_RAW"]).is_relative_to(args["output"])


def test_adapter_import_cannot_load_dotenv(rig, monkeypatch):
    import dotenv
    loader = Mock()
    monkeypatch.setattr(dotenv, "load_dotenv", loader)
    adapter = SimpleNamespace()
    def import_module(name):
        assert name == "services.auto_segmentor"
        assert dotenv.load_dotenv() is False
        assert os.environ["PYTHON_DOTENV_DISABLED"] == "1"
        return adapter
    monkeypatch.setattr(verifier.importlib, "import_module", import_module)
    assert verifier._real_adapter() is adapter
    assert dotenv.load_dotenv is loader
    loader.assert_not_called()


def test_artifact_outside_owned_directory_is_rejected(rig):
    args, _, _ = rig
    args["dispatch"] = lambda *a, **kw: str(args["input_path"].parent)
    result = verifier.review(**args)
    assert result["status"] == "failed" and "outside the isolated" in result["error"]
    assert not (args["output"] / "results.zip").exists()
