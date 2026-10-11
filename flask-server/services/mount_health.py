"""Keep a dead dataset mount from taking the whole site down.

The datasets live on a network mount (NFS). When the server behind it stops answering, a
"hard" mount makes every read wait forever. Each visitor request that reads a scan then
holds one of gunicorn's few threads for good, so within seconds nothing is left to answer
even the pages that need no files at all (search, the case library, sign-in, /api/ping).

This module turns that outage into a fast, honest answer:

* a background monitor probes the mount every few seconds and keeps a cached verdict, so
  checking it on a request costs a dictionary lookup and never touches the mount;
* ``@requires_dataset_mount`` on a route that reads dataset files answers 503 immediately
  while the verdict is "down", instead of parking a thread on the mount;
* ``snapshot()`` feeds ``/api/health`` for uptime monitors and the watchdog script.

What it can and cannot do: requests already stuck on the mount when it died stay stuck until
the mount returns (a hard mount cannot be interrupted from here), so the monitor limits the
damage to the few requests that arrive before it notices rather than to every later one.

Probe: ``stat`` of a random, nonexistent child of the dataset folder. A fresh name forces a
real round trip to the server (a cached directory or a cached file would answer from memory
and miss the outage); "no such file" is the healthy answer. The probe runs in its own
daemon thread under a timeout. If it does not return, that single thread is left behind and
no second probe is started until it finishes, so a long outage leaks one thread, not one
per check.

Nothing here runs unless ``start_monitor()`` is called (``create_app`` does), and it is
inert when no dataset path is configured (local development, most tests).
"""
from __future__ import annotations

import inspect
import os
import threading
import time
import uuid
from functools import wraps
from typing import Callable, Iterable, List, Optional

# Seconds a probe may take before it counts as a failure. A busy but healthy NFS server can
# stall for a second or two; a dead one never answers.
DEFAULT_PROBE_TIMEOUT = 5.0
DEFAULT_INTERVAL = 5.0
# Consecutive failed checks before the verdict flips to "down": one slow answer is not an outage.
DEFAULT_FAIL_THRESHOLD = 2
RETRY_AFTER_SECONDS = 15


def default_probe(path: str) -> bool:
    """True if ``path`` answers from the server. Raises nothing; any error means unhealthy.

    A path that is not a directory counts as unhealthy only once it has been seen healthy
    (the caller decides that), so a dev machine without the dataset is not reported as down.
    """
    try:
        os.stat(os.path.join(path, ".mount-probe-" + uuid.uuid4().hex))
    except FileNotFoundError:
        return os.path.isdir(path)      # server answered "no such file"; make sure the folder is there
    except OSError:
        return False                    # EIO, ESTALE, ETIMEDOUT, ENOTCONN, a not-a-directory parent...
    return True                         # the random name existing is absurd, but it did answer


class MountMonitor:
    """Cached verdict on whether the dataset mount answers. Thread-safe."""

    def __init__(
        self,
        paths: Iterable[str],
        probe: Callable[[str], bool] = default_probe,
        probe_timeout: float = DEFAULT_PROBE_TIMEOUT,
        interval: float = DEFAULT_INTERVAL,
        fail_threshold: int = DEFAULT_FAIL_THRESHOLD,
        clock: Callable[[], float] = time.monotonic,
    ):
        seen = set()
        self.paths: List[str] = []
        for p in paths:
            p = (p or "").strip()
            if p and p not in seen:
                seen.add(p)
                self.paths.append(p)
        self._probe = probe
        self.probe_timeout = float(probe_timeout)
        self.interval = float(interval)
        self.fail_threshold = max(1, int(fail_threshold))
        self._clock = clock
        self._lock = threading.Lock()
        self._down = False
        self._failures = 0
        self._seen_ok = set()           # paths that have answered at least once in this process
        self._last_ok: Optional[float] = None
        self._down_since: Optional[float] = None
        self._inflight: Optional[threading.Thread] = None
        self._inflight_result: dict = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.checks = 0

    # ------------------------------------------------------------------ public
    @property
    def enabled(self) -> bool:
        return bool(self.paths)

    def is_ok(self) -> bool:
        """True unless the monitor has concluded the mount is down. Never blocks."""
        return not self._down

    def snapshot(self) -> dict:
        """Safe-to-publish status (no filesystem paths)."""
        with self._lock:
            now = self._clock()
            return {
                "enabled": self.enabled,
                "ok": not self._down,
                "down_for_s": None if self._down_since is None else round(now - self._down_since, 1),
                "last_ok_s_ago": None if self._last_ok is None else round(now - self._last_ok, 1),
                "consecutive_failures": self._failures,
                "probe_timeout_s": self.probe_timeout,
            }

    def start(self) -> None:
        """Start the background checks (idempotent). No-op without configured paths."""
        if not self.enabled:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="mount-monitor", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def check_once(self) -> bool:
        """Run one check (synchronously, up to ``probe_timeout``) and update the verdict."""
        if not self.enabled:
            return True
        self.checks += 1
        ok = self._run_probe()
        with self._lock:
            now = self._clock()
            if ok:
                self._failures = 0
                self._last_ok = now
                self._down = False
                self._down_since = None
            else:
                self._failures += 1
                if self._failures >= self.fail_threshold and not self._down:
                    self._down = True
                    self._down_since = now
            return not self._down

    # ----------------------------------------------------------------- internals
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.check_once()
            except Exception as exc:      # the monitor must never die and leave a stale verdict
                print(f"[mount-monitor] check failed: {exc}", flush=True)
            self._stop.wait(self.interval)

    def _run_probe(self) -> bool:
        """One probe of every path; False if it errors, says unhealthy, or does not return in time."""
        with self._lock:
            prior = self._inflight
        if prior is not None and prior.is_alive():
            return False                 # the last probe is still stuck on the mount: still down
        result: dict = {}
        done = threading.Event()

        def work():
            try:
                ok_all = True
                for p in self.paths:
                    healthy = bool(self._probe(p))
                    if healthy:
                        self._seen_ok.add(p)
                    elif p in self._seen_ok:
                        ok_all = False   # it used to answer and now does not
                    # a path that never answered (dataset not present here) is not an outage
                result["ok"] = ok_all
            except Exception:
                result["ok"] = False
            finally:
                done.set()

        t = threading.Thread(target=work, name="mount-probe", daemon=True)
        with self._lock:
            self._inflight = t
        t.start()
        if not done.wait(self.probe_timeout):
            return False                 # leave the thread behind; _inflight keeps us from stacking more
        return bool(result.get("ok"))


# ------------------------------------------------------------------ module-level wiring
_monitor: Optional[MountMonitor] = None
_monitor_lock = threading.Lock()


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def configured_paths() -> List[str]:
    """Folders worth probing: ``MOUNT_GUARD_PATHS`` (comma separated) or the dataset roots."""
    explicit = os.environ.get("MOUNT_GUARD_PATHS")
    if explicit is not None:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    return [p for p in (os.environ.get("PANTS_PATH"), os.environ.get("CANCERVERSE_PATH")) if p]


def get_monitor() -> MountMonitor:
    """The process-wide monitor, created on first use from the environment."""
    global _monitor
    with _monitor_lock:
        if _monitor is None:
            enabled = os.environ.get("MOUNT_GUARD", "1").strip().lower() not in ("0", "false", "off", "no")
            _monitor = MountMonitor(
                configured_paths() if enabled else [],
                probe_timeout=_env_float("MOUNT_GUARD_TIMEOUT", DEFAULT_PROBE_TIMEOUT),
                interval=_env_float("MOUNT_GUARD_INTERVAL", DEFAULT_INTERVAL),
                fail_threshold=int(_env_float("MOUNT_GUARD_FAILS", DEFAULT_FAIL_THRESHOLD)),
            )
        return _monitor


def start_monitor() -> MountMonitor:
    mon = get_monitor()
    mon.start()
    return mon


def reset_for_tests(monitor: Optional[MountMonitor] = None) -> None:
    """Replace (or clear) the process-wide monitor. Tests only."""
    global _monitor
    with _monitor_lock:
        if _monitor is not None:
            _monitor.stop()
        _monitor = monitor


def unavailable_response():
    """The fast answer while the mount is down. Imported lazily so this module stays Flask-free."""
    from flask import jsonify
    resp = jsonify({
        "error": "dataset_storage_unavailable",
        "message": "The dataset storage is temporarily unavailable. Please try again in a minute.",
        "retry_after_seconds": RETRY_AFTER_SECONDS,
    })
    resp.status_code = 503
    resp.headers["Retry-After"] = str(RETRY_AFTER_SECONDS)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def requires_dataset_mount(view):
    """Answer 503 at once, without running ``view``, while the dataset mount is down.

    Put it directly under ``@api_blueprint.route`` (above ``@require_auth``) on every route that
    reads dataset files (async views are supported). Routes that only use the in-memory catalog, the database or local disk
    (search, facets, sign-in, /ping) must NOT carry it: they are exactly what keeps working.
    """
    if inspect.iscoroutinefunction(view):
        # Flask only awaits a view it can see is a coroutine function; a plain wrapper around an
        # async view would hand it a coroutine object instead of a response.
        @wraps(view)
        async def async_wrapper(*args, **kwargs):
            if not get_monitor().is_ok():
                return unavailable_response()
            return await view(*args, **kwargs)
        async_wrapper.requires_dataset_mount = True
        return async_wrapper

    @wraps(view)
    def wrapper(*args, **kwargs):
        if not get_monitor().is_ok():
            return unavailable_response()
        return view(*args, **kwargs)
    wrapper.requires_dataset_mount = True
    return wrapper


def mount_down_response():
    """None while the mount answers, else the 503 to return.

    For routes that can serve part of their traffic from local disk (the low-res copies, the
    pre-baked meshes): check it right before the first read that needs the mount, so the local
    paths keep working through an outage:  ``down = mount_down_response(); if down: return down``.
    """
    return None if get_monitor().is_ok() else unavailable_response()
