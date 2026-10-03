"""The class-chunked LesionSegmenter export must give the same label map as the
single-pass export it replaces for scans too big to export in one piece."""
import importlib.util
import os

import pytest

torch = pytest.importorskip("torch")

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "lesionseg_predict.py")
_spec = importlib.util.spec_from_file_location("lesionseg_predict", _SCRIPT)
lesionseg_predict = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lesionseg_predict)


def _single_pass(logits, threshold, channel):
    seg = logits.argmax(0).to(torch.uint8)
    if threshold > 0.0 and logits.shape[0] > channel:
        seg[torch.softmax(logits, 0)[channel] > threshold] = channel
    return seg


@pytest.mark.parametrize("chunk", [1, 4, 7, 43])
@pytest.mark.parametrize("threshold", [0.0, 0.05])
def test_chunked_export_matches_single_pass(monkeypatch, chunk, threshold):
    monkeypatch.setattr(lesionseg_predict, "_LESION_THRESHOLD", threshold)
    monkeypatch.setattr(lesionseg_predict, "_LESION_CHANNEL", 40)
    torch.manual_seed(0)
    logits = (torch.randn(43, 9, 11, 13) * 3).half()

    expected = _single_pass(logits.float(), threshold, 40)
    got = lesionseg_predict._chunked_segmentation(logits, lambda x: x, chunk)

    assert got.dtype == torch.uint8
    # the lesion cutoff is a float comparison; the two summation orders may disagree on a
    # voxel sitting exactly on it, nothing more
    assert int((got != expected).sum()) <= 2


def test_ties_keep_the_lowest_class_like_argmax():
    logits = torch.zeros(6, 2, 2, 2)
    logits[1] = 1.0
    logits[4] = 1.0                     # tied with class 1, in another chunk
    got = lesionseg_predict._chunked_segmentation(logits, lambda x: x, 2)
    assert (got == 1).all()


def test_normal_scans_keep_the_single_pass_path_and_huge_ones_are_chunked():
    assert lesionseg_predict._export_chunk_channels(43, (500, 500, 250)) == 43       # ~60M voxels
    chunk = lesionseg_predict._export_chunk_channels(43, (512, 512, 1394))           # ~365M voxels
    assert 1 <= chunk < 43
    assert lesionseg_predict._export_chunk_channels(43, (2000, 2000, 3000)) == 1     # never below 1
