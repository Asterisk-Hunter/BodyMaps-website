"""Job state access, backed by the ``job`` table.

The single seam the app goes through for inference-job state, replacing the old
in-memory ``inference_jobs`` dict + job.json mirror. Each function owns its DB
session via ``session_scope`` so it works from both a Flask request thread and
(later) the standalone worker, neither needing an app context.

Leasing/claim logic is inert until the worker lands; keeping it here now makes
that step additive.
"""

import hashlib
import json
import os
import shutil
from datetime import timedelta

from sqlalchemy import select

from constants import Constants
from models.engine import session_scope
from models.job import (
    Job, utcnow, TERMINAL_STATUSES,
    STATUS_QUEUED, STATUS_RUNNING, STATUS_FAILED, STATUS_CANCELLED,
)
from models.user import SYSTEM_USER_ID


def create_job(session_id: str, model: str, ct_path: str | None,
               session_path: str | None, zip_path: str | None,
               user_id: str) -> dict:
    """Insert (or reset) a queued job owned by user_id. Re-submitting a session
    id overwrites the prior row (frontend reuses the id on retry)."""
    with session_scope() as s:
        job = s.get(Job, session_id)
        if job is None:
            job = Job(session_id=session_id)
            s.add(job)
        job.user_id = user_id
        job.model = model
        job.status = STATUS_QUEUED
        job.error = None
        job.ct_path = ct_path
        job.session_path = session_path
        job.zip_path = zip_path
        job.output_mask_dir = None
        job.reconstruction_path = None
        job.pipeline = None
        job.pipeline_stages = None
        job.lease_owner = None
        job.lease_expires_at = None
        job.attempts = 0
        job.cancel_requested = False
        s.flush()
        return job.to_dict()


def upsert_job(session_id: str, **fields) -> dict:
    """Create the row if absent, then set the given columns. Drop-in for the old
    ``_set_inference_job(**kwargs)``; the first call carries status + model."""
    with session_scope() as s:
        job = s.get(Job, session_id)
        if job is None:
            job = Job(session_id=session_id)
            s.add(job)
        for key, value in fields.items():
            if not hasattr(job, key):
                raise AttributeError(f"Job has no field {key!r}")
            setattr(job, key, value)
        s.flush()
        return job.to_dict()


def get_job(session_id: str) -> dict | None:
    """Return the job as a dict, or None if unknown. Never raises for a miss."""
    with session_scope() as s:
        job = s.get(Job, session_id)
        return job.to_dict() if job else None


def list_jobs_for_user(user_id: str) -> list[dict]:
    """All of a user's jobs, most recent first — backs GET /api/me/jobs."""
    with session_scope() as s:
        stmt = select(Job).where(Job.user_id == user_id).order_by(Job.created_at.desc())
        return [dict(session_id=j.session_id, **j.to_dict()) for j in s.execute(stmt).scalars()]


# ---- deleting a user's history -------------------------------------------

# Every path a job may own. Only those under the sessions root are ever removed
# — see _sessions_root below for why that restriction is load-bearing.
_JOB_PATH_FIELDS = ("ct_path", "session_path", "zip_path", "output_mask_dir", "reconstruction_path")


def _sessions_root() -> str:
    """Absolute path of the directory holding per-session artifacts.

    Deletion is confined to this tree. That is not merely defensive: a job run
    against a dataset case stores a ``ct_path`` pointing into the shared,
    read-only PanTS dataset (api_blueprint builds it from Constants.PANTS_PATH).
    Deleting a user's history must never touch those files — they are not the
    user's data, they are the dataset everyone reads.
    """
    return os.path.abspath(Constants.SESSIONS_DIR_NAME)


def _is_within(path: str, root: str) -> bool:
    """True if ``path`` resolves inside ``root`` (symlinks followed)."""
    try:
        real_root = os.path.realpath(root)
        real_path = os.path.realpath(path)
    except (OSError, ValueError):
        return False
    return real_path == real_root or real_path.startswith(real_root + os.sep)


def _remove_artifact(path: str | None, root: str) -> bool:
    """Delete one file or directory, but only inside ``root``. Never raises."""
    if not path:
        return False
    if not _is_within(path, root):
        return False  # dataset path or something unexpected — leave it alone
    try:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
        else:
            return False
        return True
    except OSError as e:
        print(f"[job delete] could not remove {path}: {e}")
        return False


def delete_jobs_for_user(user_id: str) -> dict:
    """Delete every job owned by a user, along with its files on disk.

    Backs "delete my scan history" and is also the first half of an account
    purge. Returns ``{"jobs": n, "files": n}``. Files are removed on a
    best-effort basis: a failure there is logged, never raised, and never blocks
    the database rows from going — a user asking for their history to be gone
    should not be stuck because one directory was already missing.
    """
    root = _sessions_root()
    with session_scope() as s:
        jobs = s.execute(select(Job).where(Job.user_id == user_id)).scalars().all()
        # Collect paths before the rows go, and de-duplicate: several fields on
        # one job commonly live under the same session directory.
        paths: list[str] = []
        for job in jobs:
            for field in _JOB_PATH_FIELDS:
                value = getattr(job, field, None)
                if value and value not in paths:
                    paths.append(value)
        job_count = len(jobs)
        for job in jobs:
            s.delete(job)

    removed = sum(1 for p in paths if _remove_artifact(p, root))
    return {"jobs": job_count, "files": removed}


# Where the in-process inference path keeps each run: <repo>/tmp/<session>/,
# holding the CT copy, the masks, auto_masks.zip and job.json, which names the
# owner. api_blueprint.SESSIONS_DIR is this same folder.
RUNS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tmp"))

# Folders under sessions/inference/ that belong to the sample stager
# (services/sample_staging.py): a staged sample carries this marker, and its
# account's reservation slots live under SAMPLE_RESERVATIONS.
SAMPLE_STAGING_MARKER = ".sample-staging"
SAMPLE_RESERVATIONS = ".sample-reservations"


def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def delete_run_folders_for_user(
    user_id: str,
    is_active=lambda _session_id: False,
    runs_root: str | None = None,
    uploads_root: str | None = None,
    purge: bool = False,
) -> list[str]:
    """Delete the folders the in-process inference path keeps for a user.

    A run's job row points at <runs_root>/<session>/ (the CT copy, the masks,
    auto_masks.zip), which sits outside _sessions_root(), so
    delete_jobs_for_user leaves those files on disk. A run names its owner in
    <runs_root>/<session>/job.json; a CT uploaded ahead of Run names it in
    <uploads_root>/<session>/.owner and no job row refers to it at all. A
    session ``is_active`` reports as still queued or running is left for its
    worker. Folders with no owner record can't be attributed and are left
    alone.

    Staged samples are left to the sample stager, which also frees their
    reservation slots, unless ``purge`` is set (the account itself is going):
    then they and the account's reservation slots are removed too. Returns
    the session ids removed; never raises.
    """
    runs_root = runs_root or RUNS_DIR
    uploads_root = uploads_root or os.path.join(Constants.SESSIONS_DIR_NAME, "inference")

    def folders(root: str) -> list[tuple[str, str]]:
        try:
            return [(name, os.path.join(root, name)) for name in os.listdir(root)]
        except OSError:
            return []

    removed: set[str] = set()
    for name, path in folders(runs_root):
        raw = _read_text(os.path.join(path, "job.json"))
        try:
            job = json.loads(raw) if raw else None
        except ValueError:
            job = None
        if not isinstance(job, dict) or job.get("user_id") != user_id or is_active(name):
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed.add(name)

    for name, path in folders(uploads_root):
        if name.startswith("."):
            continue  # the sample stager's reservations, not an upload
        owner = _read_text(os.path.join(path, ".owner"))
        if owner is None or owner.strip() != user_id or is_active(name):
            continue
        if os.path.isfile(os.path.join(path, SAMPLE_STAGING_MARKER)) and not purge:
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed.add(name)

    if purge:
        bucket = hashlib.sha256(user_id.encode()).hexdigest()
        shutil.rmtree(os.path.join(uploads_root, SAMPLE_RESERVATIONS, bucket), ignore_errors=True)
    return sorted(removed)


def update_job(session_id: str, **fields) -> dict | None:
    """Patch columns on an existing job (unknown id -> None). Unknown field names
    raise, so a typo fails loudly rather than being silently dropped."""
    if not fields:
        return get_job(session_id)
    with session_scope() as s:
        job = s.get(Job, session_id)
        if job is None:
            return None
        for key, value in fields.items():
            if not hasattr(job, key):
                raise AttributeError(f"Job has no field {key!r}")
            setattr(job, key, value)
        s.flush()
        return job.to_dict()


def request_cancel(session_id: str) -> dict | None:
    """Flag a job for cancellation. A queued job goes straight to cancelled; a
    running one keeps the flag for its worker to tear down."""
    with session_scope() as s:
        job = s.get(Job, session_id)
        if job is None:
            return None
        job.cancel_requested = True
        if job.status == STATUS_QUEUED:
            job.status = STATUS_CANCELLED
            job.error = "Cancelled by user"
        s.flush()
        return job.to_dict()


def is_cancel_requested(session_id: str) -> bool:
    with session_scope() as s:
        job = s.get(Job, session_id)
        return bool(job and job.cancel_requested)


# ---- worker-facing leasing (inert until the worker process exists) --------

def claim_next_job(worker_id: str, lease_seconds: int = 1800) -> dict | None:
    """Atomically claim the oldest queued (or lease-expired) job, or None. The
    read + status flip share one transaction, so two workers can't both win it."""
    now = utcnow()
    with session_scope() as s:
        stmt = (
            select(Job)
            .where(
                (Job.status == STATUS_QUEUED)
                | ((Job.status == STATUS_RUNNING) & (Job.lease_expires_at < now))
            )
            .where(Job.cancel_requested.is_(False))
            .order_by(Job.created_at.asc())
            .limit(1)
        )
        job = s.execute(stmt).scalar_one_or_none()
        if job is None:
            return None
        job.status = STATUS_RUNNING
        job.lease_owner = worker_id
        job.lease_expires_at = now + timedelta(seconds=lease_seconds)
        job.attempts = (job.attempts or 0) + 1
        s.flush()
        return job.to_dict()


def fail_all_active(error: str = "Cancelled by user") -> int:
    """Mark every queued/running job failed (backs the admin 'stop everything').
    Returns the number affected."""
    with session_scope() as s:
        stmt = select(Job).where(Job.status.in_((STATUS_QUEUED, STATUS_RUNNING)))
        active = s.execute(stmt).scalars().all()
        for job in active:
            job.status = STATUS_FAILED
            job.error = error
            job.lease_owner = None
            job.lease_expires_at = None
        return len(active)


def import_legacy_job_json(sessions_dir: str) -> int:
    """One-time import of pre-DB ``sessions/<id>/job.json`` files. Returns count.

    Keeps results that completed before this deploy viewable: /session-ct and
    /session-segmentation read ct_path / output_mask_dir off the job record,
    which the empty post-deploy DB wouldn't have. Idempotent (skips ids already
    in the DB); best-effort per file so one bad json can't block boot.
    """
    if not sessions_dir or not os.path.isdir(sessions_dir):
        return 0

    imported = 0
    for name in os.listdir(sessions_dir):
        meta_path = os.path.join(sessions_dir, name, "job.json")
        if not os.path.isfile(meta_path):
            continue
        try:
            with open(meta_path) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                continue
            with session_scope() as s:
                if s.get(Job, name) is not None:
                    continue
                job = Job(session_id=name)
                # Pre-account jobs have no owner -> the reserved system user.
                job.user_id = SYSTEM_USER_ID
                job.model = data.get("model") or "unknown"
                job.status = data.get("status") or STATUS_FAILED
                for key in ("error", "ct_path", "session_path", "zip_path", "output_mask_dir"):
                    if key in data:
                        setattr(job, key, data.get(key))
                s.add(job)
            imported += 1
        except Exception as e:
            print(f"[job import] {name}: {e}")
    return imported


def reap_orphaned_jobs() -> int:
    """Fail any job mid-flight when its runner died; returns the count. Run once
    at boot. Lease-aware: a job with an unexpired lease is held by a live worker
    and left alone. This phase sets no lease, so all in-flight jobs are reaped —
    correct while inference runs inside the web process itself."""
    now = utcnow()
    with session_scope() as s:
        stmt = select(Job).where(
            Job.status.in_((STATUS_QUEUED, STATUS_RUNNING)),
            (Job.lease_expires_at.is_(None)) | (Job.lease_expires_at < now),
        )
        orphans = s.execute(stmt).scalars().all()
        for job in orphans:
            job.status = STATUS_FAILED
            job.error = job.error or "Interrupted by server restart"
            job.lease_owner = None
            job.lease_expires_at = None
            if job.pipeline_stages:
                stages = [dict(stage) for stage in job.pipeline_stages]
                for stage in stages:
                    if stage.get("status") == "running":
                        stage.update(status="failed", error="Interrupted by server restart", completed_at=now.isoformat())
                job.pipeline_stages = stages
        # Restart recovery must also free plan concurrency. Keep the daily scan
        # charge, but a failed job must never occupy an unfinished usage slot.
        if orphans:
            from models.usage_event import UsageEvent, KIND_INFERENCE
            events = s.execute(select(UsageEvent).where(
                UsageEvent.ref_id.in_([job.session_id for job in orphans]),
                UsageEvent.kind == KIND_INFERENCE,
                UsageEvent.finished_at.is_(None),
            )).scalars()
            for event in events:
                event.finished_at = now
        return len(orphans)


def heartbeat(session_id: str, worker_id: str, lease_seconds: int = 1800) -> bool:
    """Extend a lease the worker still owns; False if the job was reassigned or
    finished under it (the worker should then stop)."""
    now = utcnow()
    with session_scope() as s:
        job = s.get(Job, session_id)
        if job is None or job.lease_owner != worker_id:
            return False
        if job.status in TERMINAL_STATUSES:
            return False
        job.lease_expires_at = now + timedelta(seconds=lease_seconds)
        s.flush()
        return True
