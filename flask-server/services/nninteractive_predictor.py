"""
flask-server/services/nninteractive_predictor.py

Stateful nnInteractive session manager.

Architecture
------------
Each unique (case_id, segment_label, resolution) triple gets its own
nnInteractiveRemoteInferenceSession lease on the Docker server.  Sessions are
stored in an LRU OrderedDict and evicted either:
  • when the store is full (_MAX_SESSIONS, default 3 – one per GPU slot), or
  • after _SESSION_TTL seconds of inactivity (default 600 s).

Stateful interaction flow
-------------------------
  1. First request  : create session → set_image → (optionally) set_target_buffer
                       with baseline mask → add_*_interaction → read result.
  2. Refinement     : re-use the same session (no reset_interactions!) →
                       add_*_interaction → read updated result.
  3. Explicit reset : caller sets action="reset" → reset_interactions() is
                       called and target_buffer is zeroed (or re-injected with a
                       fresh baseline).

Positive / Negative clicks
--------------------------
  include_interaction=True  → positive click (include this region)
  include_interaction=False → negative click (exclude this region)

Both are forwarded to session.add_point_interaction / add_bbox_interaction /
add_lasso_interaction / add_scribble_interaction unchanged.

Thread safety
-------------
_STORE_LOCK guards all mutations to _SESSIONS.  The Docker server serialises
its own GPU work, so concurrent requests to different sessions are safe at the
network layer.

Environment variables
---------------------
  NNINTERACTIVE_URL          default "http://127.0.0.1:1527"
  NNINTERACTIVE_MAX_SESSIONS default 3
  NNINTERACTIVE_SESSION_TTL  default 600  (seconds)
"""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SERVER_URL   = os.environ.get("NNINTERACTIVE_URL", "http://127.0.0.1:1527")
_MAX_SESSIONS = int(os.environ.get("NNINTERACTIVE_MAX_SESSIONS", "3"))
_SESSION_TTL  = int(os.environ.get("NNINTERACTIVE_SESSION_TTL",  "600"))


# ---------------------------------------------------------------------------
# Helpers: even-dimension padding (avoids UNet residual shape mismatch)
# ---------------------------------------------------------------------------
def _pad_to_even(ct: np.ndarray):
    """Pad each axis to even length and return (padded_ct, pad_widths)."""
    pads = tuple((0, s % 2) for s in ct.shape)
    if all(p == (0, 0) for p in pads):
        return ct, pads
    return np.pad(ct, pads, mode="edge"), pads


def _unpad(arr: np.ndarray, pads) -> np.ndarray:
    """Strip padding introduced by _pad_to_even."""
    slices = tuple(
        slice(None, arr.shape[d] - p[1]) if p[1] > 0 else slice(None)
        for d, p in enumerate(pads)
    )
    return arr[slices]


# ---------------------------------------------------------------------------
# Helpers: bbox / axis-pair conversion
# ---------------------------------------------------------------------------
def _corners_to_axis_pairs(lo, hi) -> list[list[int]]:
    """Convert two corner IJK triples to per-axis [lo, hi] pairs.

    The nnInteractive 2-D-box-only checkpoint requires exactly one axis to have
    size == 1 (a box drawn on a single slice).  We flatten whichever axis has
    the smallest extent.
    """
    lo, hi = list(lo), list(hi)
    extents = [hi[d] - lo[d] for d in range(3)]
    flat = min(range(3), key=lambda d: extents[d])
    pairs = []
    for d in range(3):
        if d == flat:
            pairs.append([lo[d], lo[d] + 1])
        else:
            end = hi[d] if hi[d] > lo[d] else lo[d] + 1
            pairs.append([lo[d], end])
    return pairs


def _bbox_from_mask(mask: np.ndarray):
    """Smallest bounding-box enclosing non-zero voxels → (bbox, cropped)."""
    idx = np.argwhere(mask > 0)
    if len(idx) == 0:
        return None, None
    mins = idx.min(axis=0)
    maxs = idx.max(axis=0) + 1
    bbox = [[int(mins[d]), int(maxs[d])] for d in range(3)]
    cropped = mask[mins[0]:maxs[0], mins[1]:maxs[1], mins[2]:maxs[2]]
    return bbox, cropped


def _is_expired_error(exc: Exception) -> bool:
    try:
        from nnInteractive.inference.remote.remote_session import SessionExpiredError
        if isinstance(exc, SessionExpiredError):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    return any(tok in msg for tok in ("410", "lease expired", "session expired", "idle timeout"))


# ---------------------------------------------------------------------------
# Session store
# ---------------------------------------------------------------------------
class _NNSession:
    """One nnInteractive remote session for a single (case, segment, res) triple."""

    def __init__(self, ct: np.ndarray, baseline_mask: np.ndarray | None = None):
        from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
        self._raw = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL)
        if not self._raw.ping():
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} – "
                "is the Docker container running?"
            )
        ct_padded, self._pads = _pad_to_even(ct)
        self._original_shape = ct.shape
        self._raw.set_image(ct_padded[None])

        # target_buffer is a shared array that the server writes predictions into
        init = baseline_mask.astype(np.uint8) if baseline_mask is not None else np.zeros(ct_padded.shape, dtype=np.uint8)
        self._target = init
        self._raw.set_target_buffer(self._target)

        self.interaction_count = 0
        self.last_used = time.time()

    # ------------------------------------------------------------------
    def reset(self, baseline_mask: np.ndarray | None = None) -> None:
        """Clear all interactions and optionally reinject a baseline mask."""
        self._raw.reset_interactions()
        if baseline_mask is not None:
            self._target[:] = baseline_mask.astype(np.uint8)
        else:
            self._target[:] = 0
        # Re-register the (possibly mutated) buffer so the server sees the new values
        self._raw.set_target_buffer(self._target)
        self.interaction_count = 0
        self.last_used = time.time()

    # ------------------------------------------------------------------
    def add_interaction(
        self,
        *,
        point_ijk=None,
        box_ijk=None,
        lasso_mask: np.ndarray | None = None,
        scribble_mask: np.ndarray | None = None,
        lasso_bbox=None,
        scribble_bbox=None,
        is_positive: bool = True,
    ) -> None:
        """Add one user interaction without resetting prior history."""
        if point_ijk is not None:
            self._raw.add_point_interaction(
                list(point_ijk), include_interaction=is_positive
            )
        elif box_ijk is not None:
            lo, hi = box_ijk
            self._raw.add_bbox_interaction(
                _corners_to_axis_pairs(lo, hi), include_interaction=is_positive
            )
        elif lasso_mask is not None:
            self._add_lasso(lasso_mask, lasso_bbox, is_positive)
        elif scribble_mask is not None:
            self._add_scribble(scribble_mask, scribble_bbox, is_positive)
        else:
            raise ValueError("add_interaction: no prompt provided")

        self.interaction_count += 1
        self.last_used = time.time()

    def _add_lasso(self, raw_mask, bbox, is_positive: bool) -> None:
        arr = np.asarray(raw_mask, dtype=np.uint8)
        if bbox is not None:
            bbox = [list(b) for b in bbox]
            expected = [b[1] - b[0] for b in bbox]
            if list(arr.shape) != expected:
                if arr.size == int(np.prod(expected)):
                    arr = arr.reshape(expected)
                elif arr.shape == self._original_shape:
                    arr = arr[bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]]
                if list(arr.shape) != expected:
                    bbox = None; arr = np.asarray(raw_mask, dtype=np.uint8)
        if bbox is not None:
            self._raw.add_lasso_interaction(arr, include_interaction=is_positive, interaction_bbox=bbox)
        else:
            auto_bbox, cropped = _bbox_from_mask(arr)
            if auto_bbox and cropped is not None and cropped.size < arr.size // 4:
                self._raw.add_lasso_interaction(cropped, include_interaction=is_positive, interaction_bbox=auto_bbox)
            else:
                self._raw.add_lasso_interaction(arr, include_interaction=is_positive)

    def _add_scribble(self, raw_mask, bbox, is_positive: bool) -> None:
        arr = np.asarray(raw_mask, dtype=np.uint8)
        if bbox is not None:
            bbox = [list(b) for b in bbox]
            expected = [b[1] - b[0] for b in bbox]
            if list(arr.shape) != expected:
                if arr.size == int(np.prod(expected)):
                    arr = arr.reshape(expected)
                elif arr.shape == self._original_shape:
                    arr = arr[bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]]
                if list(arr.shape) != expected:
                    bbox = None; arr = np.asarray(raw_mask, dtype=np.uint8)
        if bbox is not None:
            self._raw.add_scribble_interaction(arr, include_interaction=is_positive, interaction_bbox=bbox)
        else:
            auto_bbox, cropped = _bbox_from_mask(arr)
            if auto_bbox and cropped is not None and cropped.size < arr.size // 4:
                self._raw.add_scribble_interaction(cropped, include_interaction=is_positive, interaction_bbox=auto_bbox)
            else:
                self._raw.add_scribble_interaction(arr, include_interaction=is_positive)

    # ------------------------------------------------------------------
    def get_result(self) -> np.ndarray:
        """Return current prediction mask in original (unpadded) CT shape."""
        result = self._target.copy()
        if any(p != (0, 0) for p in self._pads):
            result = _unpad(result, self._pads)
        return result

    def close(self) -> None:
        try:
            self._raw.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# LRU session store
# ---------------------------------------------------------------------------
_SESSIONS: OrderedDict[str, _NNSession] = OrderedDict()
_STORE_LOCK = threading.Lock()


def _session_key(case_id: str, segment_label: int | None, resolution: str) -> str:
    return f"{case_id}:{segment_label}:{resolution}"


def _evict_expired(now: float) -> None:
    """Evict sessions that have been idle longer than _SESSION_TTL. Caller holds lock."""
    stale = [k for k, s in _SESSIONS.items() if now - s.last_used > _SESSION_TTL]
    for k in stale:
        print(f"[nninteractive_predictor] evicting idle session {k}")
        _SESSIONS.pop(k).close()


def get_or_create_session(
    case_id: str,
    segment_label: int | None,
    resolution: str,
    ct: np.ndarray,
    baseline_mask: np.ndarray | None = None,
) -> _NNSession:
    """Return the existing session or create a new one (evicting LRU if full)."""
    key = _session_key(case_id, segment_label, resolution)
    with _STORE_LOCK:
        now = time.time()
        _evict_expired(now)

        if key in _SESSIONS:
            sess = _SESSIONS[key]
            sess.last_used = now
            _SESSIONS.move_to_end(key)           # LRU refresh
            return sess

        # Evict LRU entries until below capacity
        while len(_SESSIONS) >= _MAX_SESSIONS:
            evicted_key, evicted = _SESSIONS.popitem(last=False)
            print(f"[nninteractive_predictor] LRU evict {evicted_key} (capacity={_MAX_SESSIONS})")
            evicted.close()

        print(f"[nninteractive_predictor] creating session {key} (ct={ct.shape}, baseline={baseline_mask is not None})")
        sess = _NNSession(ct, baseline_mask=baseline_mask)
        _SESSIONS[key] = sess
        return sess


def drop_session(case_id: str, segment_label: int | None, resolution: str) -> None:
    """Forcibly close and remove a session (e.g. when case is deleted)."""
    key = _session_key(case_id, segment_label, resolution)
    with _STORE_LOCK:
        if key in _SESSIONS:
            _SESSIONS.pop(key).close()


# ---------------------------------------------------------------------------
# Public high-level predict function (backward-compat wrapper + retry logic)
# ---------------------------------------------------------------------------
def predict(
    ct: np.ndarray,
    case_key: str,
    *,
    segment_label: int | None = None,
    action: str = "interact",         # "interact" | "reset"
    is_positive: bool = True,
    point_ijk=None,
    box_ijk=None,
    lasso_mask=None,
    scribble_mask=None,
    lasso_bbox=None,
    scribble_bbox=None,
    baseline_mask: np.ndarray | None = None,
    inject_baseline: bool = False,
    # deprecated – kept for backward compat; is_positive takes precedence
    include_interaction: bool = True,
) -> np.ndarray:
    """Run stateful nnInteractive inference.

    Parameters
    ----------
    ct              : full 3-D CT numpy array (original, un-padded)
    case_key        : str like "abc123:low" – used to look up / scope the session
    segment_label   : integer label of the organ being edited (part of session key)
    action          : "interact" → add interaction; "reset" → clear all interactions
    is_positive     : True = positive click/lasso, False = negative/exclusion click
    baseline_mask   : numpy uint8 array (same shape as ct) to inject as initial mask
    inject_baseline : if True AND no existing session, load baseline_mask at session creation
    """
    # is_positive overrides old include_interaction arg
    effective_positive = is_positive if is_positive is not None else include_interaction

    # Parse the (case_id, resolution) parts from case_key (e.g. "abc123:low")
    parts = case_key.rsplit(":", 1)
    case_id = parts[0]
    resolution = parts[1] if len(parts) == 2 else "low"

    def _do_once() -> np.ndarray:
        with _STORE_LOCK:
            key = _session_key(case_id, segment_label, resolution)
            exists = key in _SESSIONS

        init_baseline = baseline_mask if (inject_baseline and not exists) else None
        sess = get_or_create_session(case_id, segment_label, resolution, ct, baseline_mask=init_baseline)

        if action == "reset":
            reinject = baseline_mask if inject_baseline else None
            sess.reset(baseline_mask=reinject)
            # After a pure reset return the current (zeroed or baselined) mask
            return sess.get_result()

        # action == "interact"
        sess.add_interaction(
            point_ijk=point_ijk,
            box_ijk=box_ijk,
            lasso_mask=lasso_mask,
            scribble_mask=scribble_mask,
            lasso_bbox=lasso_bbox,
            scribble_bbox=scribble_bbox,
            is_positive=effective_positive,
        )
        return sess.get_result()

    try:
        return _do_once()
    except Exception as exc:
        if _is_expired_error(exc):
            print(f"[nninteractive_predictor] Docker session expired ({exc}), dropping and retrying once")
            drop_session(case_id, segment_label, resolution)
            return _do_once()
        raise
