"""The interactive tools' seed labelmap is inflated with a bound.

`initial_seg_gz_b64` comes from the browser as base64 gzip. Deflate packs a run of
zeros about a thousand to one, so a request of a few megabytes can unpack to gigabytes,
and the length check used to run only after the whole stream had been inflated inside
the web process. Both places that unpack a seed now stop one byte past the voxel count
they expect and refuse the rest.
"""
import base64
import gzip
import tracemalloc
import zlib

import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as api_routes
import services.advanced_analysis as analysis

CT = np.zeros((4, 4, 4), dtype=np.float32)
BOMB_BYTES = 64 * 1024 * 1024
# Far above the few hundred bytes a 4x4x4 seed needs, far below the bomb.
PEAK_LIMIT = 8 * 1024 * 1024


def _bomb_b64(size=BOMB_BYTES):
    """Base64 of a gzip stream that inflates to `size` zero bytes, built in chunks so
    the test itself never holds the inflated data."""
    packer = zlib.compressobj(9, zlib.DEFLATED, 31)
    chunk = bytes(1024 * 1024)
    parts = [packer.compress(chunk) for _ in range(size // len(chunk))]
    parts.append(packer.flush())
    return base64.b64encode(b"".join(parts)).decode("ascii")


def _peak_while(call):
    tracemalloc.start()
    try:
        with pytest.raises(ValueError) as caught:
            call()
        return tracemalloc.get_traced_memory()[1], caught.value
    finally:
        tracemalloc.stop()


def test_a_full_grid_seed_bomb_is_refused_without_inflating_it():
    bomb = _bomb_b64()
    prompt = {"point_ijk": [1, 1, 1], "initial_seg_gz_b64": bomb}

    peak, error = _peak_while(lambda: analysis.segment_from_prompt(CT, np.eye(4), prompt, case_key="1:full"))

    assert peak < PEAK_LIMIT
    assert "more than 64 voxels" in str(error)


def test_a_viewer_grid_seed_bomb_is_refused_before_the_upsample():
    bomb = _bomb_b64()

    peak, error = _peak_while(lambda: api_routes._upsample_seed_b64(bomb, (4, 4, 4), (8, 8, 8)))

    assert peak < PEAK_LIMIT
    assert "more than 64 voxels" in str(error)


def test_the_endpoint_answers_a_seed_bomb_with_400(tmp_path, monkeypatch):
    import nibabel as nib
    ct_path = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(CT.astype(np.int16), np.eye(4)), str(ct_path))
    monkeypatch.setattr(api_routes, "_case_ct_path", lambda case_id, low=False: str(ct_path))
    monkeypatch.setattr(api_routes, "_ct_cache_key", None)
    monkeypatch.setattr(api_routes, "_ct_cache_obj", None)
    monkeypatch.setattr(api_routes, "_ct_cache_array", None)

    body = {"point_ijk": [1, 1, 1], "res": "full", "initial_seg_gz_b64": _bomb_b64(8 * 1024 * 1024)}
    with Flask(__name__).test_request_context(json=body, method="POST"):
        resp = api_routes.interactive_segment("1")
    resp, status = resp if isinstance(resp, tuple) else (resp, resp.status_code)

    assert status == 400
    assert "more than 64 voxels" in resp.get_json()["error"]


def test_a_seed_of_the_right_size_still_decodes():
    seed = np.zeros(CT.shape, dtype=np.uint8)
    seed[1, 2, 3] = 5
    encoded = base64.b64encode(gzip.compress(seed.tobytes(order="F"))).decode("ascii")

    raw = analysis.inflate_seed_labelmap(encoded, CT.size, "the CT", "")

    assert np.array_equal(np.frombuffer(raw, np.uint8).reshape(CT.shape, order="F"), seed)


@pytest.mark.parametrize("payload, message", [
    (base64.b64encode(gzip.compress(bytes(10))).decode("ascii"), "has 10 voxels"),
    (base64.b64encode(gzip.compress(bytes(64))[:-6]).decode("ascii"), "not valid base64 gzip"),
    ("not base64 at all!", "not valid base64 gzip"),
])
def test_short_truncated_and_garbled_seeds_are_refused(payload, message):
    with pytest.raises(ValueError, match=message):
        analysis.inflate_seed_labelmap(payload, CT.size, "the CT", "")
