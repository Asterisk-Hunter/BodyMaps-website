from __future__ import annotations

import nibabel as nib
import numpy as np
import pytest

from services.pants_labelmap import viewer_labelmap_path


def save_labels(path, labels, affine=None):
    image = nib.Nifti1Image(labels, np.eye(4) if affine is None else affine)
    nib.save(image, str(path))
    return path


def test_ipantsmini_ids_are_remapped_bijectively_and_source_is_untouched(tmp_path):
    source = tmp_path / "combined_labels.nii.gz"
    labels = np.arange(29, dtype=np.uint8).reshape((29, 1, 1))
    save_labels(source, labels)
    original_bytes = source.read_bytes()

    normalized = viewer_labelmap_path(source, tmp_path / "cache")
    result = np.asanyarray(nib.load(str(normalized)).dataobj)

    expected = np.arange(29, dtype=np.uint8)
    expected[22], expected[23], expected[24], expected[25], expected[26], expected[27], expected[28] = (
        23, 24, 25, 26, 27, 28, 22
    )
    assert np.array_equal(result[:, 0, 0], expected)
    assert result.dtype == np.uint8
    assert source.read_bytes() == original_bytes


def test_low_resolution_geometry_is_preserved_and_output_is_marked(tmp_path):
    source = tmp_path / "lowres.nii.gz"
    affine = np.array(
        [[2.5, 0, 0, -11], [0, 3.5, 0, 7], [0, 0, 4.5, 19], [0, 0, 0, 1]],
        dtype=float,
    )
    save_labels(source, np.array([[[25], [26], [28]]], dtype=np.uint8), affine)

    normalized = viewer_labelmap_path(source, tmp_path / "cache")
    source_image = nib.load(str(source))
    output_image = nib.load(str(normalized))

    assert output_image.shape == source_image.shape
    assert output_image.header.get_zooms() == source_image.header.get_zooms()
    assert np.allclose(output_image.affine, source_image.affine)
    for form in ("qform", "sform"):
        source_form, source_code = getattr(source_image, f"get_{form}")(coded=True)
        output_form, output_code = getattr(output_image, f"get_{form}")(coded=True)
        assert output_code == source_code
        if source_form is not None:
            assert np.allclose(output_form, source_form)
        else:
            assert output_form is None
    assert "viewer labelmap" in output_image.header["descrip"].tobytes().decode(
        "ascii", errors="ignore"
    )
    assert np.array_equal(np.asanyarray(output_image.dataobj).ravel(), [26, 27, 22])


def test_normalized_header_marker_prevents_a_second_remap(tmp_path):
    source = tmp_path / "source.nii.gz"
    save_labels(source, np.array([[[22, 23, 24, 25, 26, 27, 28]]], dtype=np.uint8))
    cache = tmp_path / "cache"

    normalized = viewer_labelmap_path(source, cache)
    repeated = viewer_labelmap_path(normalized, cache)

    assert repeated == normalized
    assert np.array_equal(
        np.asanyarray(nib.load(str(repeated)).dataobj).ravel(), [23, 24, 25, 26, 27, 28, 22]
    )


def test_viewer_schema_returns_source_without_rewriting(tmp_path):
    source = tmp_path / "viewer.nii.gz"
    save_labels(source, np.array([[[22, 23, 25, 28]]], dtype=np.uint8))
    original_bytes = source.read_bytes()

    result = viewer_labelmap_path(source, tmp_path / "cache", schema="viewer-v1")

    assert result == source
    assert source.read_bytes() == original_bytes


def test_cache_is_reused_for_same_source_and_changes_for_new_source(tmp_path):
    source = tmp_path / "source.nii.gz"
    cache = tmp_path / "cache"
    save_labels(source, np.array([[[1, 25]]], dtype=np.uint8))
    first = viewer_labelmap_path(source, cache)
    first_mtime = first.stat().st_mtime_ns

    second = viewer_labelmap_path(source, cache)
    assert second == first
    assert second.stat().st_mtime_ns == first_mtime

    save_labels(source, np.array([[[1, 26]]], dtype=np.uint8))
    changed = viewer_labelmap_path(source, cache)
    assert changed != first
    assert np.array_equal(np.asanyarray(nib.load(str(changed)).dataobj).ravel(), [1, 27])


def test_cache_hit_does_not_materialize_source_volume(tmp_path, monkeypatch):
    import services.pants_labelmap as labelmap

    source = tmp_path / "source.nii.gz"
    cache = tmp_path / "cache"
    save_labels(source, np.array([[[1, 25]]], dtype=np.uint8))
    first = viewer_labelmap_path(source, cache)

    def fail_if_materialized(_image):
        raise AssertionError("cache hit should not materialize source labels")

    monkeypatch.setattr(labelmap, "_validated_labels", fail_if_materialized)
    assert viewer_labelmap_path(source, cache) == first


@pytest.mark.parametrize(
    "labels",
    [
        np.array([[[np.nan]]], dtype=np.float32),
        np.array([[[1.5]]], dtype=np.float32),
        np.array([[[-1]]], dtype=np.int16),
        np.array([[[29]]], dtype=np.int16),
    ],
)
def test_invalid_source_labels_raise_without_creating_cache(tmp_path, labels):
    source = tmp_path / "invalid.nii.gz"
    cache = tmp_path / "cache"
    save_labels(source, labels)

    with pytest.raises(ValueError, match="label"):
        viewer_labelmap_path(source, cache)

    assert not cache.exists()
