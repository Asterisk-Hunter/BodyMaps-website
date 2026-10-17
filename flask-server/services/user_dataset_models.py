"""Second-opinion masks for the user dataset: run every kept scan through the OTHER models, when the GPUs are idle.

A scan is kept in UserData with the mask of the model the user ran. This module (driven by
scripts/user_dataset_second_opinions.py, a separate process from the website) runs the same stored CT through
the remaining models and saves each result beside the original, so one scan carries an ePAI version, an
Atlas-Net version and a LesionSegmenter version:

    mask_only/USER_00000017/
        combined_labels.nii.gz, segmentations/, metadata.json     the model the user ran (unchanged)
        by_model/LesionSegmenter/{combined_labels.nii.gz, segmentations/, version.json}
        by_model/Atlas-Net/{...}

metadata.json gains `model_versions`, a list of all versions with their relative mask folders.

LOW PRIORITY, by construction:
  * a task starts only when the website is idle (GET /api/health shows nothing active, queued or running, for
    several checks in a row), the web host has memory to spare, and a GPU worker passes the website's own
    health check (idle GPU and CPU, enough free memory, nobody else's GPU process);
  * it runs on a worker (bdmap2-4) and NEVER on the web host's GPU: the process refuses to start unless the
    local fallback is off, and a result that did not run on a worker is discarded;
  * while a task runs the website is polled every few seconds; the moment a user job appears the model is
    cancelled (also on the worker) and the task is requeued without counting as a failure.

Everything the website relies on is untouched: this runs as its own process, writes only under UserData, and a
crash here cannot affect users. One task at a time, retries with back-off, a daily cap and a stop file.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

from services import model_provenance
from services import user_dataset as ud
from services.atomic_write import atomic_destination

SCHEMA = 1
DEFAULT_MODELS = ("ePAI", "Atlas-Net", "LesionSegmenter")
BY_MODEL = "by_model"
STATE_FILE = "second_opinions_state.json"
AUDIT_FILE = "second_opinions.jsonl"
STATUS_FILE = "second_opinions_status.json"
STOP_FILE = ".second_opinions.stop"
LOCK_FILE = ".second_opinions.lock"
_CASE = re.compile(r"^USER_\d{8}$")
_SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$")
BACKOFF_SECONDS = (3600, 6 * 3600)          # after the 1st and 2nd failure; the 3rd gives up
REQUEUE_SECONDS = 60                        # after a preemption: do not hammer a busy site


class UnsafeEnvironment(RuntimeError):
    """The process is not set up so that it can only ever use idle GPU workers."""


def _num(env, name, default, cast=float):
    try:
        return cast(env.get(name, default))
    except (TypeError, ValueError):
        return cast(default)


@dataclass
class Config:
    models: tuple = DEFAULT_MODELS
    base_url: str = "http://127.0.0.1:8000"
    idle_checks: int = 3
    check_interval: float = 20.0
    poll_seconds: float = 3.0
    max_run_seconds: float = 1800.0
    min_available_gb: float = 20.0
    daily_cap: int = 100
    max_attempts: int = 3
    loop_sleep: float = 60.0
    idle_sleep: float = 300.0

    @classmethod
    def from_env(cls, env=None) -> "Config":
        env = os.environ if env is None else env
        raw = [m.strip() for m in env.get("SECOND_OPINIONS_MODELS", "").split(",") if m.strip()]
        models = tuple(raw) if raw else DEFAULT_MODELS
        bad = [m for m in models if not _SAFE_MODEL.match(m)]
        if bad:
            raise ValueError(f"SECOND_OPINIONS_MODELS has unusable names: {bad}")
        return cls(
            models=models,
            base_url=env.get("SECOND_OPINIONS_BASE_URL", cls.base_url).rstrip("/"),
            idle_checks=max(1, _num(env, "SECOND_OPINIONS_IDLE_CHECKS", cls.idle_checks, int)),
            check_interval=_num(env, "SECOND_OPINIONS_CHECK_INTERVAL", cls.check_interval),
            poll_seconds=max(0.5, _num(env, "SECOND_OPINIONS_POLL_SECONDS", cls.poll_seconds)),
            max_run_seconds=_num(env, "SECOND_OPINIONS_MAX_RUN_SECONDS", cls.max_run_seconds),
            min_available_gb=_num(env, "SECOND_OPINIONS_MIN_AVAILABLE_GB", cls.min_available_gb),
            daily_cap=_num(env, "SECOND_OPINIONS_DAILY_CAP", cls.daily_cap, int),
            max_attempts=max(1, _num(env, "SECOND_OPINIONS_MAX_ATTEMPTS", cls.max_attempts, int)),
            loop_sleep=_num(env, "SECOND_OPINIONS_LOOP_SLEEP", cls.loop_sleep),
            idle_sleep=_num(env, "SECOND_OPINIONS_IDLE_SLEEP", cls.idle_sleep),
        )


# --------------------------------------------------------------------------------------------------------------
# Files: cases, versions, state
# --------------------------------------------------------------------------------------------------------------
def _iso(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc).isoformat()


def _write_json(path: str, obj) -> None:
    with atomic_destination(path) as tmp:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)


def _read_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def case_mask_dir(root: str, case_id: str) -> str:
    return os.path.join(root, "mask_only", case_id)


def version_dir(root: str, case_id: str, model: str) -> str:
    if not _SAFE_MODEL.match(model):
        raise ValueError(f"unsafe model name: {model!r}")
    return os.path.join(case_mask_dir(root, case_id), BY_MODEL, model)


def list_cases(root: str) -> list:
    """[(case_id, metadata)] for every admitted case, oldest first. Unreadable cases are skipped."""
    base = os.path.join(root, "mask_only")
    try:
        names = sorted(n for n in os.listdir(base) if _CASE.match(n))
    except OSError:
        return []
    out = []
    for name in names:
        meta = _read_json(os.path.join(base, name, "metadata.json"))
        if isinstance(meta, dict) and meta.get("model"):
            out.append((name, meta))
    return out


def version_done(root: str, case_id: str, model: str) -> bool:
    v = _read_json(os.path.join(version_dir(root, case_id, model), "version.json"))
    return bool(v) and v.get("status") == "ok"


@dataclass(frozen=True)
class Task:
    case_id: str
    model: str
    origin: str

    @property
    def key(self) -> str:
        return f"{self.case_id}|{self.model}"


def load_state(root: str) -> dict:
    state = _read_json(os.path.join(root, STATE_FILE), {}) or {}
    state.setdefault("tasks", {})      # key -> {attempts, status, next_try, last_error, last_attempt}
    state.setdefault("runs", [])       # epoch seconds of tasks that used a GPU (daily cap)
    return state


def save_state(root: str, state: dict) -> None:
    _write_json(os.path.join(root, STATE_FILE), state)


def pending_tasks(root: str, models, state: dict, now: float, max_attempts: int = 3) -> list:
    """Everything still to do, oldest case first: each case x each configured model other than the one the user
    ran, skipping finished versions, tasks that gave up, and tasks still backing off."""
    out = []
    for case_id, meta in list_cases(root):
        for model in models:
            if model == meta["model"] or version_done(root, case_id, model):
                continue
            task = Task(case_id, model, meta["model"])
            st = state["tasks"].get(task.key)
            if st and (st.get("status") == "given_up" or st.get("attempts", 0) >= max_attempts):
                continue
            if st and st.get("next_try", 0) > now:
                continue
            out.append(task)
    return out


def note_result(state: dict, task: Task, outcome: str, now: float, error: str = "",
                max_attempts: int = 3) -> None:
    """ok clears the task; failed counts an attempt with back-off (the last one gives up); preempted/deferred
    are not failures, only a short pause."""
    entry = state["tasks"].setdefault(task.key, {"attempts": 0})
    if outcome == "ok":
        state["tasks"].pop(task.key, None)
        state["runs"].append(now)
    elif outcome == "failed":
        entry["attempts"] = entry.get("attempts", 0) + 1
        entry["last_error"] = error[:300]
        entry["last_attempt"] = now
        state["runs"].append(now)
        if entry["attempts"] >= max_attempts:
            entry["status"] = "given_up"
        else:
            entry["status"] = "failed"
            entry["next_try"] = now + BACKOFF_SECONDS[min(entry["attempts"] - 1, len(BACKOFF_SECONDS) - 1)]
    else:  # preempted / deferred
        entry["next_try"] = now + REQUEUE_SECONDS
        entry.setdefault("status", "waiting")
    state["runs"] = [t for t in state["runs"] if t >= now - 24 * 3600]


def runs_today(state: dict, now: float) -> int:
    return sum(1 for t in state.get("runs", []) if t >= now - 24 * 3600)


def audit(root: str, event: dict) -> None:
    try:
        with open(os.path.join(root, AUDIT_FILE), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": _iso(), **event}) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------------------------------------------
# The idle gate: is it really OK to use a GPU now?
# --------------------------------------------------------------------------------------------------------------
def fetch_health(base_url: str, timeout: float = 5.0) -> Optional[dict]:
    """The website's /api/health as a dict, or None when it cannot be read (then we assume it is busy)."""
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:      # 503 = dataset mount down; the body is still the health report
        try:
            return json.load(e)
        except (ValueError, OSError):
            return None
    except (OSError, ValueError):
        return None


def available_memory_gb() -> Optional[float]:
    """MemAvailable of THIS host, in GB. (nvidia-smi cannot report the GB10's unified memory, so system memory
    is what has to be watched.)"""
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / (1024 * 1024)
    except (OSError, ValueError, IndexError):
        pass
    return None


@dataclass
class Deps:
    """Everything that touches the outside world, so the logic is testable without a GPU."""
    website_health: Callable[[], Optional[dict]]
    available_gb: Callable[[], Optional[float]]
    free_workers: Callable[[], list]
    run_model: Callable[..., Optional[str]]          # (input_path, session_dir, model, session_id, on_start) -> output dir
    cancel: Callable[[str], bool]
    pop_run_info: Callable[[str], dict]
    local_hostname: Callable[[], str]
    now: Callable[[], float] = time.time
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep


def website_reason(deps: Deps) -> Optional[str]:
    """Why the website is not idle (None = idle). Unknown counts as busy: fail closed."""
    health = deps.website_health()
    if not isinstance(health, dict) or not isinstance(health.get("inference"), dict):
        return "website health unreadable"
    inf = health["inference"]
    try:
        active, queued, running = (int(inf.get(k, 0)) for k in ("active", "queued", "running"))
    except (TypeError, ValueError):
        return "website health unreadable"
    if active or queued or running:
        return f"website busy (active={active}, queued={queued}, running={running})"
    return None


def busy_reason(deps: Deps, cfg: Config, *, check_workers: bool = False) -> Optional[str]:
    reason = website_reason(deps)
    if reason:
        return reason
    gb = deps.available_gb()
    if gb is None or gb < cfg.min_available_gb:
        return f"web host memory low or unknown ({gb} GB available, need {cfg.min_available_gb:g})"
    if check_workers and not deps.free_workers():
        return "no GPU worker is free"
    return None


def confirm_idle(deps: Deps, cfg: Config) -> Optional[str]:
    """None only if idle_checks consecutive samples, check_interval apart, are all idle AND a worker is free at
    the end. Returns the first reason it is not."""
    for i in range(cfg.idle_checks):
        reason = busy_reason(deps, cfg, check_workers=(i == cfg.idle_checks - 1))
        if reason:
            return reason
        if i < cfg.idle_checks - 1:
            deps.sleep(cfg.check_interval)
    return None


def assert_safe_environment(gpu_workers, env=None) -> None:
    """Refuse to run unless the only possible place for a job is an idle GPU worker."""
    env = os.environ if env is None else env
    if not gpu_workers.enabled():
        raise UnsafeEnvironment("GPU workers are not enabled (GPU_WORKERS_ENABLED / GPU_WORKER_HOSTS): refusing to "
                                "run second-opinion models anywhere else")
    if gpu_workers.local_fallback_allowed():
        raise UnsafeEnvironment("GPU_WORKER_LOCAL_FALLBACK must be false: a second opinion must never run on the "
                                "web host's GPU")
    if str(env.get("EPAI_REMOTE_ENABLED", "")).strip().lower() in {"1", "true", "yes", "on"}:
        raise UnsafeEnvironment("EPAI_REMOTE_ENABLED (single fixed remote GPU) is not supported here")
    if not gpu_workers.hosts():
        raise UnsafeEnvironment("no GPU_WORKER_HOSTS configured")


# --------------------------------------------------------------------------------------------------------------
# Saving a finished version
# --------------------------------------------------------------------------------------------------------------
def refresh_model_versions(root: str, case_id: str) -> list:
    """Rewrite metadata.json's `model_versions` from what is on disk: the user's own run plus every finished
    by_model/<Model>/version.json."""
    mask = case_mask_dir(root, case_id)
    path = os.path.join(mask, "metadata.json")
    meta = _read_json(path)
    if not isinstance(meta, dict):
        raise ValueError(f"{case_id}: metadata.json unreadable")
    versions = [{"model": meta.get("model"), "role": "user_run", "mask": ".", "pipeline": meta.get("pipeline")}]
    base = os.path.join(mask, BY_MODEL)
    for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        v = _read_json(os.path.join(base, name, "version.json"))
        if isinstance(v, dict) and v.get("status") == "ok":
            versions.append({"model": name, "role": "second_opinion", "mask": f"{BY_MODEL}/{name}",
                             "completed_at": v.get("completed_at"), "segmentation_ok": v.get("segmentation_ok")})
    meta["model_versions"] = versions
    _write_json(path, meta)
    return versions


def _grid(shape) -> list:
    return [int(d) for d in shape if int(d) > 1]


def store_version(root: str, task: Task, output_dir: str, *, executor: dict, seconds: float,
                  completed_at: Optional[float] = None) -> dict:
    """Validate a model's output against the stored CT and publish it as by_model/<Model>/ atomically."""
    import nibabel as nib
    combined = os.path.join(output_dir, "combined_labels.nii.gz")
    if not os.path.isfile(combined):
        raise ValueError("the model produced no combined_labels.nii.gz")
    ct_path = os.path.join(root, "image_only", task.case_id, "ct.nii.gz")
    ct_grid, mask_grid = _grid(nib.load(ct_path).shape), _grid(nib.load(combined).shape)
    if ct_grid != mask_grid:
        raise ValueError(f"grid_mismatch: mask {mask_grid} vs CT {ct_grid}")
    meta = _read_json(os.path.join(case_mask_dir(root, task.case_id), "metadata.json")) or {}
    ok, note, stats = ud.segmentation_quality_ok(combined)     # informational here: an empty result is still a result
    geometry = {"shape": meta.get("shape"), "spacing_mm": meta.get("spacing_mm", [])}
    final = version_dir(root, task.case_id, task.model)
    stage = final + ".partial"
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    try:
        ud._store_nifti_gz(combined, os.path.join(stage, "combined_labels.nii.gz"))
        existing = os.path.join(output_dir, "segmentations")
        organs = ud._write_sublabels(combined, os.path.join(stage, "segmentations"),
                                     existing if os.path.isdir(existing) else None)
        version = {
            "schema": SCHEMA, "case_id": task.case_id, "model": task.model, "role": "second_opinion", "status": "ok",
            "input": {"ct": f"image_only/{task.case_id}/ct.nii.gz", "sha256": meta.get("sha256"),
                      "pipeline": {"segmentation_input": "original", "preprocessing": None, "postprocessing": None}},
            "user_ran_model": task.origin,
            "completed_at": _iso(completed_at), "run_seconds": round(float(seconds), 1),
            "executor": executor,
            "segmentation_ok": ok, "segmentation_note": note, "segmentation_stats": stats, "organs": organs,
            **ud.case_summary(geometry, stats),
            **model_provenance.describe(task.model, ud._LABEL_NAMES, ud._LESION_LABELS),
        }
        _write_json(os.path.join(stage, "version.json"), version)
        if os.path.isdir(final):
            shutil.rmtree(final)
        os.replace(stage, final)      # published only when every file is in place
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    refresh_model_versions(root, task.case_id)
    return version


# --------------------------------------------------------------------------------------------------------------
# Running one task
# --------------------------------------------------------------------------------------------------------------
@dataclass
class Result:
    outcome: str            # ok | failed | preempted | deferred
    detail: str = ""
    seconds: float = 0.0
    version: dict = field(default_factory=dict)


def execute(task: Task, root: str, cfg: Config, deps: Deps, sessions_dir: str, log=print,
            should_stop: Callable[[], bool] = lambda: False) -> Result:
    ct_path = os.path.join(root, "image_only", task.case_id, "ct.nii.gz")
    if not os.path.isfile(ct_path):
        return Result("failed", "the stored CT is missing")
    sid = f"so-{task.case_id}-{task.model}-{uuid.uuid4().hex[:8]}"
    session_dir = os.path.join(sessions_dir, sid)
    preempted, timed_out, finished = threading.Event(), threading.Event(), threading.Event()
    started = deps.monotonic()
    reason_box = []

    def supervise():
        # Poll the website while the model runs; the moment a user job shows up, cancel (also on the worker).
        while not finished.wait(cfg.poll_seconds):
            reason = "stop requested" if should_stop() else website_reason(deps)
            if reason:
                reason_box.append(reason)
                preempted.set()
                deps.cancel(sid)
                return
            if deps.monotonic() - started > cfg.max_run_seconds:
                timed_out.set()
                deps.cancel(sid)
                return

    watcher = threading.Thread(target=supervise, name=f"second-opinion-watch-{sid}", daemon=True)
    try:
        os.makedirs(session_dir)
        input_path = os.path.join(session_dir, f"{task.case_id}.nii.gz")
        shutil.copyfile(ct_path, input_path)
        watcher.start()
        log(f"[second-opinions] {task.case_id}: running {task.model} (user ran {task.origin})")
        try:
            output_dir = deps.run_model(input_path, session_dir, task.model, sid,
                                        lambda: website_reason(deps) is None)   # last look before dispatch
        except Exception as e:
            if preempted.is_set():
                return Result("preempted", reason_box[0] if reason_box else "website became busy")
            if timed_out.is_set():
                return Result("failed", f"exceeded {cfg.max_run_seconds:g}s", deps.monotonic() - started)
            return Result("failed", f"{type(e).__name__}: {e}"[:300], deps.monotonic() - started)
        finally:
            finished.set()
        seconds = deps.monotonic() - started
        info = deps.pop_run_info(sid) or {}
        if output_dir is None:
            return Result("deferred", "the website became busy before dispatch")
        ran_on, local = list(info.get("ran_on", [])), deps.local_hostname().split(".")[0].lower()
        if info.get("fell_back") or not ran_on or local in [h.split(".")[0].lower() for h in ran_on]:
            return Result("failed", f"not on a GPU worker (ran_on={ran_on}); result discarded", seconds)
        try:
            version = store_version(root, task, output_dir,
                                    executor={"ran_on": ran_on, "fell_back_to_web_host": False}, seconds=seconds,
                                    completed_at=deps.now())
        except Exception as e:
            return Result("failed", f"{type(e).__name__}: {e}"[:300], seconds)
        return Result("ok", ",".join(ran_on), seconds, version)
    finally:
        finished.set()
        if watcher.is_alive():
            watcher.join(timeout=cfg.poll_seconds + 2)
        shutil.rmtree(session_dir, ignore_errors=True)


# --------------------------------------------------------------------------------------------------------------
# The loop
# --------------------------------------------------------------------------------------------------------------
@contextlib.contextmanager
def single_instance(root: str):
    """Only one second-opinion process may run (an flock on UserData/.second_opinions.lock)."""
    os.makedirs(root, exist_ok=True)
    f = open(os.path.join(root, LOCK_FILE), "w")
    try:
        try:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ImportError:        # no fcntl (Windows/CI): the lock is advisory only
            pass
        except OSError:
            yield False
            return
        yield True
    finally:
        f.close()


def stop_requested(root: str, stop_event: Optional[threading.Event] = None) -> bool:
    return bool(stop_event and stop_event.is_set()) or os.path.exists(os.path.join(root, STOP_FILE))


def write_status(root: str, **fields) -> None:
    with contextlib.suppress(OSError):
        _write_json(os.path.join(root, STATUS_FILE), {"updated_at": _iso(), "pid": os.getpid(), **fields})


def run_loop(root: str, cfg: Config, deps: Deps, sessions_dir: str, *, once: bool = False,
             limit: Optional[int] = None, stop_event: Optional[threading.Event] = None, log=print) -> dict:
    """Work through the backlog, one task at a time, only while idle. once=True does not wait for idleness: it
    stops at the first closed gate. Returns counts."""
    counts = {"ok": 0, "failed": 0, "preempted": 0, "deferred": 0, "gate_closed": 0}
    with single_instance(root) as got:
        if not got:
            log("[second-opinions] another instance is already running; exiting")
            counts["already_running"] = 1
            return counts
        while True:
            if stop_requested(root, stop_event):
                log("[second-opinions] stop requested; exiting")
                break
            if limit is not None and sum(counts[k] for k in ("ok", "failed")) >= limit:
                break
            now = deps.now()
            state = load_state(root)
            tasks = pending_tasks(root, cfg.models, state, now, cfg.max_attempts)
            write_status(root, state="idle" if not tasks else "waiting", pending=len(tasks),
                         runs_today=runs_today(state, now), counts=counts)
            if not tasks:
                if once:
                    break
                deps.sleep(cfg.idle_sleep)
                continue
            if runs_today(state, now) >= cfg.daily_cap:
                log(f"[second-opinions] daily cap of {cfg.daily_cap} reached; pausing")
                if once:
                    break
                deps.sleep(cfg.loop_sleep)
                continue
            reason = confirm_idle(deps, cfg)
            if reason:
                counts["gate_closed"] += 1
                write_status(root, state="gate_closed", reason=reason, pending=len(tasks), counts=counts)
                if once:
                    log(f"[second-opinions] not idle: {reason}")
                    break
                deps.sleep(cfg.loop_sleep)
                continue
            task = tasks[0]
            write_status(root, state="running", task=task.key, pending=len(tasks), counts=counts)
            result = execute(task, root, cfg, deps, sessions_dir, log=log,
                             should_stop=lambda: stop_requested(root, stop_event))
            counts[result.outcome] = counts.get(result.outcome, 0) + 1
            state = load_state(root)
            note_result(state, task, result.outcome, deps.now(), result.detail, cfg.max_attempts)
            save_state(root, state)
            audit(root, {"case": task.case_id, "model": task.model, "outcome": result.outcome,
                         "detail": result.detail, "seconds": round(result.seconds, 1)})
            log(f"[second-opinions] {task.key}: {result.outcome} {result.detail}".rstrip())
            if result.outcome in ("preempted", "deferred"):
                deps.sleep(cfg.loop_sleep)
        write_status(root, state="stopped", counts=counts)
    return counts


def status_report(root: str, cfg: Config, now: Optional[float] = None) -> dict:
    """What exists and what is left, without touching a GPU."""
    now = time.time() if now is None else now
    state = load_state(root)
    cases = list_cases(root)
    per_model = {m: {"done": 0, "pending": 0, "backing_off": 0, "gave_up": 0, "is_users_run": 0} for m in cfg.models}
    for case_id, meta in cases:
        for m in cfg.models:
            if m == meta["model"]:
                per_model[m]["is_users_run"] += 1
            elif version_done(root, case_id, m):
                per_model[m]["done"] += 1
            else:
                st = state["tasks"].get(f"{case_id}|{m}")
                if st and (st.get("status") == "given_up" or st.get("attempts", 0) >= cfg.max_attempts):
                    per_model[m]["gave_up"] += 1
                elif st and st.get("next_try", 0) > now:
                    per_model[m]["backing_off"] += 1
                else:
                    per_model[m]["pending"] += 1
    return {"cases": len(cases), "models": per_model, "runs_last_24h": runs_today(state, now),
            "daily_cap": cfg.daily_cap, "given_up": [k for k, v in state["tasks"].items() if v.get("status") == "given_up"]}


def default_deps() -> Deps:
    """The real dependencies. gpu_workers is light; auto_segmentor (heavy, reads .env) is imported on first use."""
    from services import gpu_workers

    def free_workers():
        scores = gpu_workers._score_all(gpu_workers.hosts())
        return [h for h, s in scores.items() if s is not None]

    def run_model(input_path, session_dir, model, session_id, on_start):
        from services import auto_segmentor
        return auto_segmentor.run_auto_segmentation(input_path, session_dir, model, session_id=session_id,
                                                    on_start=on_start)

    def cancel(session_id):
        from services import auto_segmentor
        return auto_segmentor.cancel_session(session_id)

    def pop_run_info(session_id):
        from services import auto_segmentor
        return auto_segmentor.pop_run_info(session_id)

    return Deps(
        website_health=lambda: fetch_health(Config.from_env().base_url),
        available_gb=available_memory_gb, free_workers=free_workers, run_model=run_model, cancel=cancel,
        pop_run_info=pop_run_info, local_hostname=gpu_workers._local_hostname,
    )
