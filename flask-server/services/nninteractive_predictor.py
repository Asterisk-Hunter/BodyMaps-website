"""
flask-server/services/nninteractive_predictor.py

Talks to the standalone `nninteractive-server` process on bdmap1
(127.0.0.1:1527, model + GPU loaded once at server startup) via
nnInteractiveRemoteInferenceSession.

CONFIRMED end-to-end on bdmap1 against PanTS_00000001 (2026-08-15):
  - add_point_interaction(coords, include_interaction=True)
      coords = [i, j, k]  -> works, produced 142284 voxels on a test seed.
  - add_bbox_interaction(bbox, include_interaction=True)
      bbox = [[x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi]]  (per-axis pairs,
      NOT two corner points). Exactly one axis must have size == 1 (a 2D
      box on a single slice) -- size == 0 raises ValueError, and all three
      axes > 1 raises "3D bounding box... not supported by the loaded
      model checkpoint" (this checkpoint is 2D-box-only). Produced 16227
      voxels on a 30x30 test box.

Every box prompt is flattened to zero thickness on whichever axis has the
smallest extent -- see _corners_to_axis_pairs(). This matches a box drawn
on one 2D viewport pane, but has NOT yet been verified against a real
frontend box-drag; verify this once wired up.

Since api_blueprint.py's `_ANALYSIS_SLOTS` semaphore already serializes all
calls into `interactive_segment()`, one shared session with no extra locking
here is safe. Gunicorn is `--workers 1 --threads 8` (single process), so this
module-level cache is correctly shared across every request thread.
"""
from __future__ import annotations

import numpy as np

SERVER_URL = "http://127.0.0.1:1527"

_session = None
_cached_case_key: str | None = None
_cached_ct_shape: tuple | None = None
_target_buffer: np.ndarray | None = None


def _get_session():
    global _session
    if _session is None:
        from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
        _session = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL)
        if not _session.ping():
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} — "
                "check it's running (tmux session 'nninteractive' on bdmap1)."
            )
    return _session


def _reset_session():
    """Clear cached session after 410 idle timeout (600s) or Docker restart.

    The remote server reaps idle leases after 600 s and also loses all leases
    on restart. The next call will then 410. Resetting lets the retry-once
    wrapper below transparently reclaim a fresh lease.
    """
    global _session, _cached_case_key, _cached_ct_shape, _target_buffer, _pad_widths
    try:
        if _session is not None:
            _session.close()
    except Exception:
        pass
    _session = None
    _cached_case_key = None
    _cached_ct_shape = None
    _target_buffer = None
    _pad_widths = None


# Padding widths applied to the last loaded volume: tuple of (before, after) per axis
_pad_widths: tuple | None = None


def _pad_to_even(ct: np.ndarray):
    """Pad each axis to an even size if needed (avoids UNet residual shape mismatch)."""
    pads = []
    for s in ct.shape:
        pads.append((0, s % 2))  # add 1 slice at end if odd
    pads = tuple(pads)
    if all(p == (0, 0) for p in pads):
        return ct, pads
    ct_padded = np.pad(ct, pads, mode="edge")
    return ct_padded, pads


def _unpad(arr: np.ndarray, pads) -> np.ndarray:
    """Remove padding applied by _pad_to_even."""
    slices = tuple(
        slice(None, arr.shape[d] - p[1]) if p[1] > 0 else slice(None)
        for d, p in enumerate(pads)
    )
    return arr[slices]


def _ensure_volume_loaded(ct: np.ndarray, case_key: str) -> np.ndarray:
    """Load the CT into the nnInteractive session if not already cached.

    Returns the (possibly padded) CT array that was sent to the server.
    """
    global _cached_case_key, _cached_ct_shape, _target_buffer, _pad_widths
    session = _get_session()
    if _cached_case_key == case_key and _cached_ct_shape == ct.shape:
        ct_padded, _ = _pad_to_even(ct)
        return ct_padded
    ct_padded, pads = _pad_to_even(ct)
    if any(p != (0, 0) for p in pads):
        print(f"[nninteractive_predictor] padding CT {ct.shape} -> {ct_padded.shape} (odd dims)")
    _pad_widths = pads
    session.set_image(ct_padded[None])
    _target_buffer = np.zeros(ct_padded.shape, dtype=np.uint8)
    session.set_target_buffer(_target_buffer)
    _cached_case_key = case_key
    _cached_ct_shape = ct.shape  # store original shape so cache key is stable
    return ct_padded


def _corners_to_axis_pairs(lo, hi) -> list[list[int]]:
    lo, hi = list(lo), list(hi)
    extents = [hi[d] - lo[d] for d in range(3)]
    flatten_axis = min(range(3), key=lambda d: extents[d])
    pairs = []
    for d in range(3):
        if d == flatten_axis:
            start = lo[d]
            pairs.append([start, start + 1])
        else:
            end = hi[d] if hi[d] > lo[d] else lo[d] + 1
            pairs.append([lo[d], end])
    return pairs


def _bbox_from_mask(mask: np.ndarray) -> tuple[list[list[int]], np.ndarray] | tuple[None, None]:
    """Compute minimal bbox enclosing non-zero voxels and return cropped array.

    Used to send lasso/scribble as small 2D crop + interaction_bbox rather than
    full volume, per API_CHANGES_v2 recommended path.
    """
    idx = np.argwhere(mask > 0)
    if len(idx) == 0:
        return None, None
    mins = idx.min(axis=0)
    maxs = idx.max(axis=0) + 1  # half-open
    bbox = [[int(mins[d]), int(maxs[d])] for d in range(3)]
    cropped = mask[mins[0]:maxs[0], mins[1]:maxs[1], mins[2]:maxs[2]]
    return bbox, cropped


def _is_session_expired_error(exc: Exception) -> bool:
    try:
        from nnInteractive.inference.remote.remote_session import SessionExpiredError
        if isinstance(exc, SessionExpiredError):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    if "410" in msg or "lease expired" in msg or "session expired" in msg or "idle timeout" in msg:
        return True
    # httpx 410 is also surfaced as generic RuntimeError with 410
    if "410" in str(type(exc)):
        return True
    return False


def predict(
    ct: np.ndarray,
    case_key: str,
    point_ijk=None,
    box_ijk=None,
    lasso_mask=None,
    scribble_mask=None,
    lasso_bbox=None,
    scribble_bbox=None,
    include_interaction=True,
) -> np.ndarray:
    """Run nnInteractive prediction for point/box/lasso/scribble with retry-once on 410."""

    def _do_once() -> np.ndarray:
        session = _get_session()
        _ensure_volume_loaded(ct, case_key)
        session.reset_interactions()

        if point_ijk is not None:
            session.add_point_interaction(list(point_ijk), include_interaction=include_interaction)
        elif box_ijk is not None:
            lo, hi = box_ijk
            axis_pairs = _corners_to_axis_pairs(lo, hi)
            session.add_bbox_interaction(axis_pairs, include_interaction=include_interaction)
        elif lasso_mask is not None:
            arr = np.asarray(lasso_mask, dtype=np.uint8)
            # prefer bbox crop path when available
            if lasso_bbox is not None:
                bbox = [list(b) for b in lasso_bbox]
                # ensure cropped shape matches bbox
                # if arr shape already matches bbox, send as-is; else crop
                expected = [b[1] - b[0] for b in bbox]
                if list(arr.shape) != expected:
                    if arr.size == np.prod(expected):
                        arr = arr.reshape(expected)
                    # try to crop from full volume if arr is full shape
                    elif arr.shape == ct.shape:
                        arr = arr[bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]]
                    # else fallback to full-volume mode
                    if list(arr.shape) != expected:
                        bbox = None
                        arr = np.asarray(lasso_mask, dtype=np.uint8)
                if bbox is not None:
                    session.add_lasso_interaction(arr, include_interaction=include_interaction, interaction_bbox=bbox)
                else:
                    session.add_lasso_interaction(arr, include_interaction=include_interaction)
            else:
                # auto-compute bbox for efficiency
                bbox, cropped = _bbox_from_mask(arr)
                if bbox is not None and cropped is not None and cropped.size < arr.size // 4:
                    session.add_lasso_interaction(cropped, include_interaction=include_interaction, interaction_bbox=bbox)
                else:
                    session.add_lasso_interaction(arr, include_interaction=include_interaction)
        elif scribble_mask is not None:
            arr = np.asarray(scribble_mask, dtype=np.uint8)
            if scribble_bbox is not None:
                bbox = [list(b) for b in scribble_bbox]
                expected = [b[1] - b[0] for b in bbox]
                if list(arr.shape) != expected:
                    if arr.size == np.prod(expected):
                        arr = arr.reshape(expected)
                    elif arr.shape == ct.shape:
                        arr = arr[bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]]
                    if list(arr.shape) != expected:
                        bbox = None
                        arr = np.asarray(scribble_mask, dtype=np.uint8)
                if bbox is not None:
                    session.add_scribble_interaction(arr, include_interaction=include_interaction, interaction_bbox=bbox)
                else:
                    session.add_scribble_interaction(arr, include_interaction=include_interaction)
            else:
                bbox, cropped = _bbox_from_mask(arr)
                if bbox is not None and cropped is not None and cropped.size < arr.size // 4:
                    session.add_scribble_interaction(cropped, include_interaction=include_interaction, interaction_bbox=bbox)
                else:
                    session.add_scribble_interaction(arr, include_interaction=include_interaction)
        else:
            raise ValueError("predict() needs point_ijk or box_ijk or lasso_mask/scribble_mask")

        result = _target_buffer.copy()
        # Unpad back to original CT shape if we padded the volume
        if _pad_widths is not None and any(p != (0, 0) for p in _pad_widths):
            result = _unpad(result, _pad_widths)
        return result

    try:
        return _do_once()
    except Exception as e:
        if _is_session_expired_error(e):
            print(f"[nninteractive_predictor] session expired ({type(e).__name__}: {e}), resetting and retrying once")
            _reset_session()
            # retry once; let second failure propagate
            return _do_once()
        raise
