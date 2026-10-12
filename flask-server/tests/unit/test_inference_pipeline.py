"""Actual tiny NIfTI artifacts; model execution is deliberately stubbed."""
import copy
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from services import inference_pipeline as pipeline


def volume(path, labels=False, affine=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ones((3, 4, 5), dtype=np.uint8) if labels else np.full((3, 4, 5), -100, dtype=np.float32)
    nib.save(nib.Nifti1Image(data, np.eye(4) if affine is None else affine), path)
    return path


@pytest.fixture
def rig(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "stage_availability", lambda model: (True, None))
    original = volume(tmp_path / "original.nii.gz")
    before = original.read_bytes()
    updates, calls = [], []
    cancelled = [False]

    def dispatch(source, session_dir, model, session_id, on_start):
        calls.append((source, session_dir, model, session_id))
        if on_start() is False:
            return None
        output = Path(session_dir) / "output"
        output.mkdir(parents=True, exist_ok=True)
        volume(output / ("reconstructed_ct.nii.gz" if model == "OpenVAE" else "combined_labels.nii.gz"), labels=model != "OpenVAE")
        if model == "ePAI":
            (output / "output.csv").write_text("original measurements")
        return str(output)

    args = dict(input_path=str(original), session_dir=str(tmp_path), session_id="owned-session",
                pipeline=pipeline.selection("ePAI", "OpenVAE", "ShapeKit"), dispatch=dispatch,
                publish=lambda **fields: updates.append(copy.deepcopy(fields)),
                cancelled=lambda: cancelled[0], on_start=lambda: True)
    return args, updates, calls, cancelled, before


def test_three_stages_use_one_session_and_preserve_original_and_raw_metrics(rig):
    args, updates, calls, _, before = rig
    final, reconstruction, stages = pipeline.run_pipeline(**args)
    assert [call[2] for call in calls] == ["OpenVAE", "ePAI", "ShapeKit"]
    assert {call[3] for call in calls} == {"owned-session"}
    assert calls[1][0] == reconstruction
    assert calls[2][0] == str(Path(calls[1][1]) / "output")
    assert Path(args["input_path"]).read_bytes() == before
    assert not (Path(final) / "output.csv").exists()
    assert (Path(final) / "segmentation_original/output.csv").read_text() == "original measurements"
    assert (Path(final) / "segmentation_original/combined_labels.nii.gz").is_file()
    assert [s["status"] for s in stages] == ["completed", "completed", "completed", "running"]
    assert pipeline.finish_packaging(stages)[-1]["status"] == "completed"
    assert updates[-1]["pipeline_stages"][-1]["status"] == "running"


@pytest.mark.parametrize("pre,post,models", [(None, None, ["ePAI"]), ("OpenVAE", None, ["OpenVAE", "ePAI"]), (None, "ShapeKit", ["ePAI", "ShapeKit"])])
def test_only_selected_stages_run(rig, pre, post, models):
    args, _, calls, _, _ = rig
    args["pipeline"] = pipeline.selection("ePAI", pre, post)
    pipeline.run_pipeline(**args)
    assert [call[2] for call in calls] == models


@pytest.mark.parametrize("stop_model", ["OpenVAE", "ePAI", "ShapeKit"])
def test_cancellation_between_stages_stops_whole_chain(rig, stop_model):
    args, updates, calls, cancelled, _ = rig
    real = args["dispatch"]
    def dispatch(*a, **kw):
        result = real(*a, **kw)
        if kw["model"] == stop_model:
            cancelled[0] = True
        return result
    args["dispatch"] = dispatch
    with pytest.raises(pipeline.PipelineCancelled):
        pipeline.run_pipeline(**args)
    assert calls[-1][2] == stop_model
    assert updates[-1]["pipeline_stages"][len(calls)-1]["status"] == "cancelled"
    assert updates[-1]["pipeline_stages"][-1]["status"] == "queued"


def test_queued_cancellation_does_not_start_adapter(rig):
    args, _, calls, cancelled, _ = rig
    cancelled[0] = True
    with pytest.raises(pipeline.PipelineCancelled):
        pipeline.run_pipeline(**args)
    assert not calls


def test_cancel_after_completed_stage_keeps_its_completed_status(rig):
    args, updates, calls, cancelled, _ = rig
    save = args["publish"]
    def publish(**fields):
        save(**fields)
        if fields["pipeline_stages"][0]["status"] == "completed":
            cancelled[0] = True
    args["publish"] = publish
    with pytest.raises(pipeline.PipelineCancelled):
        pipeline.run_pipeline(**args)
    assert [c[2] for c in calls] == ["OpenVAE"]
    assert updates[-1]["pipeline_stages"][0]["status"] == "completed"
    assert updates[-1]["pipeline_stages"][1]["status"] == "queued"


def test_cancellation_after_gpu_wait_prevents_subprocess(rig):
    args, _, calls, cancelled, _ = rig
    def waiting(source, **kw):
        cancelled[0] = True
        assert kw["on_start"]() is False
        return None
    args["dispatch"] = waiting
    with pytest.raises(pipeline.PipelineCancelled):
        pipeline.run_pipeline(**args)


@pytest.mark.parametrize("invalid", ["missing", "geometry", "nan", "labels"])
def test_invalid_stage_output_is_never_published(rig, invalid):
    args, updates, calls, _, _ = rig
    real = args["dispatch"]
    def dispatch(*a, **kw):
        result = real(*a, **kw)
        if kw["model"] == "ePAI":
            path = Path(result) / "combined_labels.nii.gz"
            if invalid == "missing":
                path.unlink()
            else:
                affine = np.eye(4)
                data = np.ones((3, 4, 5), dtype=np.float32)
                if invalid == "geometry": affine[0, 3] = 12
                if invalid == "nan": data[0, 0, 0] = np.nan
                if invalid == "labels": data[0, 0, 0] = 56
                nib.save(nib.Nifti1Image(data, affine), path)
        return result
    args["dispatch"] = dispatch
    with pytest.raises((pipeline.PipelineError, FileNotFoundError)):
        pipeline.run_pipeline(**args)
    assert [c[2] for c in calls] == ["OpenVAE", "ePAI"]
    assert updates[-1]["pipeline_stages"][1]["status"] == "failed"


def test_retries_use_new_artifact_directories(rig):
    args, _, _, _, _ = rig
    first = pipeline.run_pipeline(**args)[0]
    second = pipeline.run_pipeline(**args)[0]
    assert first != second


@pytest.mark.parametrize("pre,post", [("MAISI", None), (True, None), ([], None), (None, "anything")])
def test_unknown_choices_are_rejected(pre, post):
    with pytest.raises(pipeline.PipelineError):
        pipeline.selection("ePAI", pre, post)


def test_incompatible_label_schemes_are_rejected(rig):
    with pytest.raises(pipeline.PipelineError):
        pipeline.selection("MedIA Vertebrae", None, "ShapeKit")


def test_unavailable_stage_fails_before_execution(monkeypatch):
    monkeypatch.setattr(pipeline, "stage_availability", lambda model: (False, "Missing actual weights"))
    with pytest.raises(pipeline.PipelineError) as error:
        pipeline.selection("ePAI", "OpenVAE")
    assert error.value.status == 503
    assert error.value.code == "pipeline_unavailable"


def test_availability_requires_actual_checkpoint_and_runtime(tmp_path, monkeypatch):
    src = tmp_path / "openvae"
    (src / "test").mkdir(parents=True)
    (src / "test/test_3dvae.py").write_text("# installed")
    monkeypatch.setenv("OPENVAE_SRC_PATH", str(src))
    checkpoint = src / "actual.pt"
    monkeypatch.setenv("OPENVAE_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.setenv("CONDA_ENVS_DIR", str(tmp_path / "envs"))
    monkeypatch.setenv("CONDA_EXE_PATH", "")
    assert not pipeline.stage_availability("OpenVAE")[0]
    checkpoint.write_bytes(b"fixture only")
    assert not pipeline.stage_availability("OpenVAE")[0]
    interpreter = tmp_path / "envs/openvae/bin/python"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("fixture only")
    assert pipeline.stage_availability("OpenVAE") == (True, None)
