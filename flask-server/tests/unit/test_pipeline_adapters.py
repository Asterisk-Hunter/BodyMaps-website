"""Real NIfTI adapter boundaries; model subprocesses are isolated fixtures."""
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from services import auto_segmentor as adapter


def save(path, values, affine=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(np.asarray(values), np.eye(4) if affine is None else affine), str(path))
    return str(path)


@pytest.fixture
def stage_env(monkeypatch, tmp_path):
    source = tmp_path / "source with spaces"
    (source / "test").mkdir(parents=True)
    (source / "test" / "test_3dvae.py").write_text("# fixture")
    (source / "main.py").write_text("# fixture")
    checkpoint = source / "autoencoder_best.pt"
    checkpoint.write_bytes(b"fixture")
    monkeypatch.setenv("OPENVAE_SRC_PATH", str(source))
    monkeypatch.setenv("OPENVAE_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.setenv("SHAPEKIT_SRC_PATH", str(source))
    monkeypatch.setenv("SHAPEKIT_CPU_NUM", "2")
    monkeypatch.setattr(adapter, "_env_command", lambda _: "python")
    monkeypatch.setattr(adapter, "get_least_used_gpu", lambda: "0")
    monkeypatch.setattr(adapter, "_current_session_cancelled", lambda: False)
    return source, checkpoint


def test_missing_openvae_weights_never_substitutes_maisi(stage_env, monkeypatch, tmp_path):
    stage_env[1].unlink()
    calls = []
    monkeypatch.setattr(adapter, "_tracked_run", lambda *a, **k: calls.append(a))
    with pytest.raises(RuntimeError, match="different model will not be substituted"):
        adapter._run_openvae_inference("unused", str(tmp_path / "session"))
    assert not calls


def test_openvae_keeps_original_and_requires_configured_weights(stage_env, monkeypatch, tmp_path):
    original = save(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6), np.float32))
    before = Path(original).read_bytes()
    session = tmp_path / "session"
    calls = []

    def execute(command, **kwargs):
        calls.append(command)
        save(session / "openvae/reconstructed_ct.nii.gz", np.ones((4, 5, 6), np.float32))

    monkeypatch.setattr(adapter, "_tracked_run", execute)
    result = adapter._run_openvae_inference(original, str(session))
    assert Path(result, "reconstructed_ct.nii.gz").is_file()
    assert Path(original).read_bytes() == before
    assert "--checkpoint" in calls[0] and "--maisi_ckpt" not in calls[0]


def test_openvae_normalizes_only_harmless_singleton_dimensions(stage_env, monkeypatch, tmp_path):
    original = save(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6, 1), np.float32))
    before = Path(original).read_bytes()
    session = tmp_path / "session"

    def execute(command, **kwargs):
        normalized = session / "openvae_input_3d.nii.gz"
        assert normalized.name in command
        assert nib.load(str(normalized)).shape == (4, 5, 6)
        save(session / "openvae/reconstructed_ct.nii.gz", np.ones((4, 5, 6), np.float32))

    monkeypatch.setattr(adapter, "_tracked_run", execute)
    adapter._run_openvae_inference(original, str(session))
    assert Path(original).read_bytes() == before


def test_openvae_rejects_real_four_dimensional_input(stage_env, monkeypatch, tmp_path):
    original = save(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6, 2), np.float32))
    calls = []
    monkeypatch.setattr(adapter, "_tracked_run", lambda *a, **k: calls.append(a))
    with pytest.raises(RuntimeError, match="single 3-D"):
        adapter._run_openvae_inference(original, str(tmp_path / "session"))
    assert not calls


@pytest.mark.parametrize("kind", ["shape", "affine", "nan"])
def test_reconstruction_rejects_incompatible_output(stage_env, monkeypatch, tmp_path, kind):
    original = save(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6), np.float32))
    session = tmp_path / "session"
    values = np.zeros((3, 5, 6) if kind == "shape" else (4, 5, 6), np.float32)
    affine = np.eye(4)
    if kind == "affine":
        affine[0, 3] = 10
    if kind == "nan":
        values[0, 0, 0] = np.nan
    monkeypatch.setattr(adapter, "_tracked_run", lambda *a, **k: save(session / "openvae/reconstructed_ct.nii.gz", values, affine))
    with pytest.raises(RuntimeError, match="Processing output"):
        adapter._run_openvae_inference(original, str(session))


def test_shapekit_preserves_other_labels_and_original_mask(stage_env, monkeypatch, tmp_path):
    values = np.zeros((4, 4, 4), np.int16)
    values[0, 0, 0] = 14  # liver
    values[0, 0, 1] = 25  # spleen
    values[0, 0, 2] = 33  # liver lesion
    values[0, 0, 3] = 44  # another unsupported dataset label
    source = tmp_path / "raw"
    original = save(source / "combined_labels.nii.gz", values)
    before = Path(original).read_bytes()
    session = tmp_path / "session"

    def execute(*args, **kwargs):
        refined = session / "shapekit_raw/case001/segmentations"
        # Both organs expand into everything, including each other and lesions.
        save(refined / "spleen.nii.gz", np.ones(values.shape, np.uint8))
        save(refined / "liver.nii.gz", np.ones(values.shape, np.uint8))
        # An unexpected label must never be introduced by a stray output file.
        save(refined / "pancreas.nii.gz", np.ones(values.shape, np.uint8))

    monkeypatch.setattr(adapter, "_tracked_run", execute)
    result = adapter._run_shapekit_inference(str(source), str(session))
    refined = np.asarray(nib.load(str(Path(result) / "combined_labels.nii.gz")).dataobj)
    assert np.array_equal(refined[0, 0], [14, 25, 33, 44])
    assert refined[1, 1, 1] == 14  # stable priority for overlapping background
    assert not np.any(refined == 17)
    assert Path(original).read_bytes() == before


@pytest.mark.parametrize("kind", ["missing", "affine", "nonbinary"])
def test_shapekit_does_not_report_invalid_outputs_as_refined(stage_env, monkeypatch, tmp_path, kind):
    values = np.full((4, 4, 4), 14, np.int16)
    source = tmp_path / "raw"
    save(source / "combined_labels.nii.gz", values)
    session = tmp_path / "session"

    def execute(*args, **kwargs):
        refined = session / "shapekit_raw/case001/segmentations"
        refined.mkdir(parents=True)
        if kind != "missing":
            affine = np.eye(4)
            if kind == "affine":
                affine[1, 3] = 5
            save(refined / "liver.nii.gz", np.full(values.shape, 2 if kind == "nonbinary" else 1, np.uint8), affine)

    monkeypatch.setattr(adapter, "_tracked_run", execute)
    with pytest.raises(RuntimeError):
        adapter._run_shapekit_inference(str(source), str(session))
    assert not (session / "shapekit/combined_labels.nii.gz").exists()


def test_shapekit_rejects_segmentation_without_supported_organs(stage_env, monkeypatch, tmp_path):
    source = tmp_path / "raw"
    save(source / "combined_labels.nii.gz", np.full((4, 4, 4), 33, np.int16))
    calls = []
    monkeypatch.setattr(adapter, "_tracked_run", lambda *a, **k: calls.append(a))
    with pytest.raises(RuntimeError, match="no organs supported"):
        adapter._run_shapekit_inference(str(source), str(tmp_path / "session"))
    assert not calls


def test_atlas_distinguishes_intestine_renal_veins_and_stent_before_refinement(tmp_path):
    # Verified against JHU's Atlas Dataset001_ATLASNet dataset.json. These four
    # classes must not become colon/generic veins or disappear before ShapeKit.
    source = save(tmp_path / "atlas.nii.gz", np.array([6, 16, 19, 20, 21, 22, 23, 24, 25], np.int16).reshape(3, 3, 1))
    adapter._remap_combined_labels(source, adapter._ATLASNET_TO_VIEWER)
    actual = np.asarray(nib.load(source).dataobj).ravel()
    assert np.array_equal(actual, [6, 29, 28, 30, 31, 32, 22, 22, 22])


def test_stage_state_failure_prevents_model_execution(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(adapter, "_run_epai_inference", lambda **kw: calls.append(kw))

    def stage_start():
        raise RuntimeError("Cannot persist stage state")

    with pytest.raises(RuntimeError, match="Cannot persist stage state"):
        adapter.run_auto_segmentation("unused", str(tmp_path), "ePAI", on_start=stage_start)
    assert not calls


@pytest.mark.parametrize("activate_conda", [False, True])
def test_epai_requests_export_and_publishes_mask_and_measurements(monkeypatch, tmp_path, activate_conda):
    original = save(tmp_path / "scan.nii", np.zeros((3, 3, 3), np.float32))
    before = Path(original).read_bytes()
    session = tmp_path / "session"
    activation = tmp_path / "conda.sh"
    activation.write_text("# fixture")
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", "false")
    monkeypatch.setattr(adapter, "get_least_used_gpu", lambda: "0")
    monkeypatch.setattr(adapter, "_env_command", lambda *args: "fixture-nnunet")

    def exporter(command, **kwargs):
        # Mirrors the installed ePAI exporter's observed contract: the CLI can
        # return success without files when probability export is omitted.
        if "--save_probabilities" in command.split():
            native = np.zeros((3, 3, 3), np.uint8)
            native[0, 0, :3] = [12, 13, 23]  # liver, pancreas, pancreatic lesion
            save(session / "epai/out/CASE_scan.nii.gz", native)
            (session / "epai/output.csv").write_text("BDMAP ID,fixture_measurement\nCASE_scan,1\n")

    monkeypatch.setattr(adapter, "_tracked_run", exporter)
    output = Path(adapter._run_epai_inference(original, str(session), str(activation) if activate_conda else "", "epai", ""))
    assert np.array_equal(np.asarray(nib.load(str(output / "combined_labels.nii.gz")).dataobj)[0, 0, :3], [14, 17, 22])
    assert "CASE_scan,1" in (output / "output.csv").read_text()
    assert Path(original).read_bytes() == before


def test_epai_exit_zero_without_mask_is_still_a_failure(monkeypatch, tmp_path):
    original = save(tmp_path / "scan.nii", np.zeros((3, 3, 3), np.float32))
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", "false")
    monkeypatch.setattr(adapter, "get_least_used_gpu", lambda: "0")
    monkeypatch.setattr(adapter, "_env_command", lambda *args: "fixture-nnunet")
    monkeypatch.setattr(adapter, "_tracked_run", lambda *args, **kwargs: None)
    with pytest.raises(RuntimeError, match="Expected ePAI output not found"):
        adapter._run_epai_inference(original, str(tmp_path / "session"), "", "epai", "")
