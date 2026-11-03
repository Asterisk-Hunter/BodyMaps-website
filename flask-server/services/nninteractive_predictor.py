"""
flask-server/services/nninteractive_predictor.py

Stateful nnInteractive session manager.

Architecture
------------
Each unique (case_id, segment_label, resolution) triple gets its own
nnInteractiveRemoteInferenceSession lease on the Docker server. Sessions are
stored in an OrderedDict. Expired sessions are reaped, and each account may
hold up to two leases so its prompt session and one-shot Refine can coexist.
The global default is two leases, below the model-server's three-session cap.
When that pool is full, preserve each reader's first session and refuse a new
reader rather than discard their active context.

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
  NNINTERACTIVE_MAX_SESSIONS default 2
  NNINTERACTIVE_MAX_SESSIONS_PER_USER default 2
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
API_KEY = os.environ.get("NNINTERACTIVE_API_KEY", "")
_MAX_SESSIONS = max(1, int(os.environ.get("NNINTERACTIVE_MAX_SESSIONS", "2")))
_MAX_SESSIONS_PER_USER = max(1, int(os.environ.get("NNINTERACTIVE_MAX_SESSIONS_PER_USER", "2")))
_SESSION_TTL  = int(os.environ.get("NNINTERACTIVE_SESSION_TTL",  "600"))
_CAPS_CACHE = None
_CAPS_FETCHED_AT = 0.0
_CAPS_FAILED_AT = 0.0
_CAPS_LOCK = threading.Lock()


def get_capabilities() -> dict | None:
    """Return the loaded model server's prompt and checkpoint capabilities."""
    global _CAPS_CACHE, _CAPS_FETCHED_AT, _CAPS_FAILED_AT
    now = time.monotonic()
    with _CAPS_LOCK:
        if _CAPS_CACHE is not None and now - _CAPS_FETCHED_AT < 3600:
            return _CAPS_CACHE
        if now - _CAPS_FAILED_AT < 30:
            return _CAPS_CACHE
        try:
            import requests
            headers = {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}
            response = requests.get(f"{SERVER_URL.rstrip('/')}/capabilities", headers=headers, timeout=3)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid model capabilities response")
            _CAPS_CACHE = payload
            _CAPS_FETCHED_AT = now
            return payload
        except Exception:
            _CAPS_FAILED_AT = now
            return _CAPS_CACHE


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


def _is_capacity_error(exc: Exception) -> bool:
    try:
        from nnInteractive.inference.remote.remote_session import ServerAtCapacityError
        if isinstance(exc, ServerAtCapacityError):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    if any(tok in msg for tok in ("at capacity", "server is at capacity", "too many sessions", "max sessions", "no slot")):
        return True
    # httpx HTTPStatusError with 429/503 often wraps a capacity detail
    try:
        import httpx
        if isinstance(exc, httpx.HTTPStatusError):
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (429, 503):
                return True
    except Exception:
        pass
    return False


def _is_timeout_error(exc: Exception) -> bool:
    try:
        import httpx
        if isinstance(exc, (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout, httpx.ConnectTimeout)):
            return True
        if isinstance(exc, httpx.TimeoutException):
            return True
    except Exception:
        pass
    if isinstance(exc, TimeoutError):
        return True
    msg = str(exc).lower()
    return any(tok in msg for tok in ("timed out", "timeout", "read timeout", "write timeout"))


def _is_unavailable_error(exc: Exception) -> bool:
    try:
        import httpx
        if isinstance(exc, (httpx.ConnectError, httpx.NetworkError)):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    return any(tok in msg for tok in ("not reachable", "is the docker", "connection refused", "connection reset", "failed to connect", "connect error", "network unreachable", "connection aborted", "err_connection"))


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

        if baseline_mask is not None:
            init = np.pad(baseline_mask.astype(np.uint8), self._pads, mode="constant")
            self._target = init
            self._raw.set_target_buffer(self._target)
            self._raw.add_initial_seg_interaction(self._target)
        else:
            init = np.zeros(ct_padded.shape, dtype=np.uint8)
            self._target = init
            self._raw.set_target_buffer(self._target)

        self.interaction_count = 0
        self.last_used = time.time()
        # Per-session mutex: prevents concurrent tool-switch requests from
        # racing into the same Docker session simultaneously.
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def reset(self, baseline_mask: np.ndarray | None = None) -> None:
        """Clear all interactions and optionally reinject a baseline mask."""
        with self._lock:
            self._raw.reset_interactions()
            if baseline_mask is not None:
                self._target[:] = np.pad(baseline_mask.astype(np.uint8), self._pads, mode="constant")
                self._raw.set_target_buffer(self._target)
                self._raw.add_initial_seg_interaction(self._target)
            else:
                self._target[:] = 0
                self._raw.set_target_buffer(self._target)
            self._raw.set_target_buffer(self._target)
            self.interaction_count = 0
            self.last_used = time.time()

    def refine_from_mask(self, mask: np.ndarray) -> None:
        """Run nnInteractive's zero-shot refinement from the supplied live mask."""
        arr = np.asarray(mask, dtype=np.uint8)
        if arr.shape != self._original_shape:
            raise ValueError("The current segmentation does not match the CT grid.")
        if not np.any(arr):
            raise ValueError("This class has no voxels to refine yet. Draw or segment it first.")
        if getattr(self._raw, "supports_zero_shot_label_refinement", True) is False:
            raise ValueError("This model checkpoint can't refine a label on its own.")
        with self._lock:
            self._raw.reset_interactions()
            self._target[:] = np.pad(arr, self._pads, mode="constant")
            self._raw.set_target_buffer(self._target)
            self._raw.add_initial_seg_interaction(self._target, run_prediction=True)
            self.interaction_count = 1
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
        with self._lock:
            if lasso_mask is not None:
                self._add_lasso(lasso_mask, lasso_bbox, is_positive)
            elif scribble_mask is not None:
                self._add_scribble(scribble_mask, scribble_bbox, is_positive)
            elif box_ijk is not None:
                lo, hi = box_ijk
                self._raw.add_bbox_interaction(
                    _corners_to_axis_pairs(lo, hi), include_interaction=is_positive
                )
            elif point_ijk is not None:
                self._raw.add_point_interaction(
                    list(point_ijk), include_interaction=is_positive
                )
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
        with self._lock:
            result = self._target.copy()
        if any(p != (0, 0) for p in self._pads):
            result = _unpad(result, self._pads)
        return result

    def close(self) -> None:
        # Match the upstream release guarantee: never close a remote session
        # while an interaction is still using it. The lock is released as soon
        # as reset/refine/add_interaction completes.
        with self._lock:
            try:
                self._raw.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# LRU session store
# ---------------------------------------------------------------------------
_SESSIONS: OrderedDict[str, _NNSession] = OrderedDict()
_STORE_LOCK = threading.Lock()


class PromptCapacityError(RuntimeError):
    """The session pool is full; preserve existing prompt context."""


class PromptSessionLostError(RuntimeError):
    """The client expected an accumulated prompt object that is no longer live."""


def _session_key(
    case_id: str,
    segment_label: int | None,
    resolution: str,
    session_token: str | None = None,
    owner: str | None = None,
) -> str:
    """Scope live model state to the user-owned viewer prompt session."""
    return f"{owner or 'anonymous'}:{session_token or 'legacy'}:{case_id}:{segment_label}:{resolution}"


def _evict_expired(now: float) -> None:
    """Evict sessions that have been idle longer than _SESSION_TTL. Caller holds lock."""
    stale = [k for k, s in _SESSIONS.items() if now - s.last_used > _SESSION_TTL and not s._lock.locked()]
    for k in stale:
        print(f"[nninteractive_predictor] evicting idle session {k}")
        _SESSIONS.pop(k).close()


def _owner_of(sess: _NNSession) -> str:
    return getattr(sess, "_bodymaps_owner", "anonymous")


def _evict_oldest_idle(predicate) -> bool:
    """Close the least-recently-used idle session matching predicate."""
    for key, session in list(_SESSIONS.items()):
        if predicate(key, session) and not session._lock.locked():
            _SESSIONS.pop(key).close()
            return True
    return False


def session_is_active(
    case_id: str,
    segment_label: int | None,
    resolution: str,
    session_token: str | None,
    owner: str | None = None,
) -> bool:
    """Check whether this caller still owns the accumulated model session."""
    key = _session_key(case_id, segment_label, resolution, session_token, owner)
    with _STORE_LOCK:
        _evict_expired(time.time())
        return key in _SESSIONS


def get_or_create_session(
    case_id: str,
    segment_label: int | None,
    resolution: str,
    ct: np.ndarray,
    baseline_mask: np.ndarray | None = None,
    session_token: str | None = None,
    owner: str | None = None,
) -> _NNSession:
    """Return an existing session or create one without evicting live context."""
    key = _session_key(case_id, segment_label, resolution, session_token, owner)
    with _STORE_LOCK:
        now = time.time()
        _evict_expired(now)

        if key in _SESSIONS:
            sess = _SESSIONS[key]
            sess.last_used = now
            _SESSIONS.move_to_end(key)           # LRU refresh
            return sess

        owner_key = owner or "anonymous"
        owner_sessions = [(k, s) for k, s in _SESSIONS.items() if _owner_of(s) == owner_key]
        if len(owner_sessions) >= _MAX_SESSIONS_PER_USER:
            if not _evict_oldest_idle(lambda _k, session: _owner_of(session) == owner_key):
                raise PromptCapacityError("Your interactive sessions are busy; retry after one finishes.")

        if len(_SESSIONS) >= _MAX_SESSIONS:
            owner_counts: dict[str, int] = {}
            for session in _SESSIONS.values():
                session_owner = _owner_of(session)
                owner_counts[session_owner] = owner_counts.get(session_owner, 0) + 1
            # Preserve each reader's first session. If the pool is full, only
            # reclaim an extra idle lease from a reader already holding more
            # than one, never another reader's sole active context.
            if not _evict_oldest_idle(
                lambda _k, session: owner_counts.get(_owner_of(session), 0) > 1
            ):
                raise PromptCapacityError("Interactive segmentation is at capacity; existing prompt sessions were preserved.")

        print(f"[nninteractive_predictor] creating session {key} (ct={ct.shape}, baseline={baseline_mask is not None})")
        sess = _NNSession(ct, baseline_mask=baseline_mask)
        sess._bodymaps_owner = owner_key
        sess._bodymaps_token = session_token
        sess._bodymaps_case_id = case_id
        sess._bodymaps_segment_label = segment_label
        sess._bodymaps_resolution = resolution
        _SESSIONS[key] = sess
        return sess


def drop_session(
    case_id: str,
    segment_label: int | None,
    resolution: str,
    session_token: str | None = None,
    owner: str | None = None,
) -> None:
    """Forcibly close and remove a session (e.g. when case is deleted)."""
    key = _session_key(case_id, segment_label, resolution, session_token, owner)
    to_close = None
    with _STORE_LOCK:
        session_key = key if key in _SESSIONS else None
        if session_key is None and session_token is not None:
            # A low-res viewer request may be promoted to a full-res model
            # session. The release endpoint only knows the viewer resolution;
            # the opaque token and owner still identify that exact lease.
            session_key = next((candidate for candidate, session in _SESSIONS.items()
                                if getattr(session, "_bodymaps_owner", None) == (owner or "anonymous")
                                and getattr(session, "_bodymaps_token", None) == session_token
                                and getattr(session, "_bodymaps_case_id", None) == case_id
                                and getattr(session, "_bodymaps_segment_label", object()) == segment_label), None)
        if session_key is not None:
            to_close = _SESSIONS.pop(session_key)
    if to_close is not None:
        to_close.close()


# ---------------------------------------------------------------------------
# Public high-level predict function (backward-compat wrapper + retry logic)
# ---------------------------------------------------------------------------
def predict(
    ct: np.ndarray,
    case_key: str,
    *,
    segment_label: int | None = None,
    action: str = "interact",         # "interact" | "reset"
    refine: bool = False,
    session_token: str | None = None,
    owner: str | None = None,
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

    # Validate a zero-shot refine before reserving a remote lease. An empty or
    # missing label has nothing for nnInteractive to refine and should not use
    # a scarce model-server slot.
    if (refine or action == "refine") and (
        baseline_mask is None or not np.any(baseline_mask)
    ):
        raise ValueError("This class has no voxels to refine yet. Draw or segment it first.")

    # Parse the (case_id, resolution) parts from case_key (e.g. "abc123:low")
    parts = case_key.rsplit(":", 1)
    case_id = parts[0]
    resolution = parts[1] if len(parts) == 2 else "low"

    def _do_once() -> np.ndarray:
        with _STORE_LOCK:
            key = _session_key(case_id, segment_label, resolution, session_token, owner)
            exists = key in _SESSIONS

        init_baseline = baseline_mask if (inject_baseline and not exists) else None
        sess = get_or_create_session(
            case_id, segment_label, resolution, ct, baseline_mask=init_baseline,
            session_token=session_token, owner=owner,
        )

        if refine or action == "refine":
            if baseline_mask is None:
                raise ValueError("Refining needs the class's current voxels.")
            sess.refine_from_mask(baseline_mask)
            return sess.get_result()

        # Heal sessions whose target buffer is empty even though a baseline is
        # available. Baseline is injected via reset() → add_initial_seg_interaction
        # (authoritative nnInteractive contract), not merely a local buffer.
        # Covers sessions zeroed by an undo-sync reset and sessions created empty
        # because the first request arrived without inject_baseline. Also heals
        # stale sessions whose interaction history left an empty target (e.g. after
        # a failed or partial sync) — without this the model refines an EMPTY
        # canvas and the frontend would erase the organ on the next positive click.
        # Healing is scoped to empty targets only, so non-empty sessions keep
        # paper-accurate refinement behavior.
        if (
            action == "interact"
            and inject_baseline
            and baseline_mask is not None
            and int(baseline_mask.sum()) > 0
            and int(sess.get_result().sum()) == 0
        ):
            sess.reset(baseline_mask=baseline_mask)

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
            drop_session(case_id, segment_label, resolution, session_token, owner)
            return _do_once()
        raise
