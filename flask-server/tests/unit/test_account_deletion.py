"""Unit tests for the display name and the account-deletion lifecycle.

Covers the grace period end to end: requesting deletion makes the account
unusable immediately, signing back in inside the window restores it, and past
the window the account is refused even before the purge has physically removed
it. Also covers deleting scan history, including the rule that files outside the
sessions root (the shared PanTS dataset) are never touched.
"""

import hashlib
import importlib
import json
import os
from datetime import timedelta

import pytest


@pytest.fixture()
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'del.db'}")
    monkeypatch.setenv("SESSIONS_DIR_PATH", str(tmp_path / "sessions"))
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.job  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.job_store as job_store
    importlib.reload(job_store)
    # Runs from the Upload page live outside the sessions root; keep them in
    # the test's own folder too.
    monkeypatch.setattr(job_store, "RUNS_DIR", str(tmp_path / "runs"))

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store, job_store, tmp_path
    engine.reset_engine_for_tests()


def _age_deletion(auth_store, user_id, days):
    """Backdate a pending deletion so the grace period can be tested."""
    from models.engine import session_scope
    from models.job import utcnow
    from models.user import User
    with session_scope() as s:
        s.get(User, user_id).deletion_requested_at = utcnow() - timedelta(days=days)


# ---- display name ---------------------------------------------------------

def test_name_is_optional_and_updatable(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("a@b.com", "hunter2pass")
    assert user["name"] is None  # accounts without a name are valid

    updated = auth_store.update_name(user["id"], "  Ada   Lovelace ")
    assert updated["name"] == "Ada Lovelace"  # trimmed, whitespace collapsed


def test_name_can_be_set_at_registration(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("c@d.com", "hunter2pass", "Grace Hopper")
    assert user["name"] == "Grace Hopper"


def test_blank_name_clears_back_to_null(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("e@f.com", "hunter2pass", "Ada")
    assert auth_store.update_name(user["id"], "   ")["name"] is None


def test_overlong_name_is_truncated_not_rejected(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("g@h.com", "hunter2pass")
    updated = auth_store.update_name(user["id"], "x" * 500)
    assert len(updated["name"]) == auth_store.MAX_NAME_LEN


# ---- deletion lifecycle ---------------------------------------------------

def test_requesting_deletion_signs_out_everywhere(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("i@j.com", "hunter2pass")
    token_a = auth_store.create_session(user["id"])
    token_b = auth_store.create_session(user["id"])  # a second browser
    assert auth_store.resolve_session(token_a) is not None

    result = auth_store.request_deletion(user["id"])
    assert result["grace_days"] == auth_store.DELETION_GRACE_DAYS
    assert auth_store.resolve_session(token_a) is None
    assert auth_store.resolve_session(token_b) is None


def test_signing_in_during_grace_restores_the_account(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("k@l.com", "hunter2pass")
    auth_store.request_deletion(user["id"])

    back = auth_store.authenticate("k@l.com", "hunter2pass")
    assert back is not None and back["id"] == user["id"]

    # and the account is fully usable again
    token = auth_store.create_session(user["id"])
    assert auth_store.resolve_session(token) is not None
    assert auth_store.list_users_pending_purge() == []


def test_account_is_refused_once_grace_has_elapsed(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("m@n.com", "hunter2pass")
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    # refused even though the row is still physically present
    assert auth_store.authenticate("m@n.com", "hunter2pass") is None
    assert auth_store.get_user(user["id"]) is not None


def test_purge_removes_only_accounts_past_the_grace_period(stores):
    auth_store, _, _ = stores
    keeper = auth_store.create_user("keep@x.com", "hunter2pass")
    recent = auth_store.create_user("recent@x.com", "hunter2pass")
    stale = auth_store.create_user("stale@x.com", "hunter2pass")

    auth_store.request_deletion(recent["id"])  # still inside the window
    auth_store.request_deletion(stale["id"])
    _age_deletion(auth_store, stale["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert auth_store.get_user(stale["id"]) is None
    assert auth_store.get_user(recent["id"]) is not None
    assert auth_store.get_user(keeper["id"]) is not None


def test_purge_removes_a_users_jobs_too(stores):
    """job.user_id is NOT NULL with no cascade, so the purge has to clear jobs
    itself or the delete raises."""
    auth_store, job_store, _ = stores
    user = auth_store.create_user("o@p.com", "hunter2pass")
    job_store.create_job("sess-1", "ePAI", None, None, None, user["id"])
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert job_store.get_job("sess-1") is None


def test_deletion_is_idempotent(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("q@r.com", "hunter2pass")
    first = auth_store.request_deletion(user["id"])
    second = auth_store.request_deletion(user["id"])
    # the clock must not restart on a second click
    assert first["deletion_requested_at"] == second["deletion_requested_at"]


# ---- scan history ---------------------------------------------------------

def test_delete_history_removes_jobs_and_their_files(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("s@t.com", "hunter2pass")

    session_dir = tmp_path / "sessions" / "sess-a"
    session_dir.mkdir(parents=True)
    ct = session_dir / "ct.nii.gz"
    ct.write_text("scan")

    job_store.create_job("sess-a", "ePAI", str(ct), str(session_dir), None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["jobs"] == 1
    assert job_store.get_job("sess-a") is None
    assert not ct.exists()
    assert not session_dir.exists()


def test_delete_history_never_touches_the_shared_dataset(stores):
    """A job run against a dataset case has ct_path inside the read-only PanTS
    tree. Deleting history must not delete the dataset."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("u@v.com", "hunter2pass")

    dataset_ct = tmp_path / "pants_dataset" / "image_only" / "PanTS_00001" / "ct.nii.gz"
    dataset_ct.parent.mkdir(parents=True)
    dataset_ct.write_text("shared dataset scan")

    job_store.create_job("sess-b", "ePAI", str(dataset_ct), None, None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["jobs"] == 1          # the record is gone
    assert result["files"] == 0         # but nothing was deleted from disk
    assert dataset_ct.exists()


def test_delete_history_leaves_other_users_alone(stores):
    auth_store, job_store, _ = stores
    mine = auth_store.create_user("w@x.com", "hunter2pass")
    theirs = auth_store.create_user("y@z.com", "hunter2pass")
    job_store.create_job("mine-1", "ePAI", None, None, None, mine["id"])
    job_store.create_job("theirs-1", "ePAI", None, None, None, theirs["id"])

    job_store.delete_jobs_for_user(mine["id"])

    assert job_store.get_job("mine-1") is None
    assert job_store.get_job("theirs-1") is not None


def test_delete_history_survives_a_missing_directory(stores):
    """Files already gone must not stop the rows from being deleted."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("aa@bb.com", "hunter2pass")
    ghost = tmp_path / "sessions" / "not-there"
    job_store.create_job("sess-c", "ePAI", None, str(ghost), None, user["id"])

    result = job_store.delete_jobs_for_user(user["id"])
    assert result == {"jobs": 1, "files": 0}
    assert job_store.get_job("sess-c") is None


def test_delete_history_rejects_a_traversal_path(stores):
    """A stored path escaping the sessions root is skipped, not followed."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("cc@dd.com", "hunter2pass")

    outside = tmp_path / "outside.txt"
    outside.write_text("important")
    escaping = os.path.join(str(tmp_path / "sessions"), "..", "outside.txt")

    job_store.create_job("sess-d", "ePAI", escaping, None, None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["files"] == 0
    assert outside.exists()


# ---- runs from the Upload page ---------------------------------------------
# A run's files sit in <RUNS_DIR>/<session>/, outside the sessions root that
# delete_jobs_for_user may remove from, and its job.json names the owner. A CT
# uploaded ahead of Run names it in <sessions>/inference/<session>/.owner.

def _upload_page_run(tmp_path, session_id, user_id, status="completed"):
    run = tmp_path / "runs" / session_id
    run.mkdir(parents=True)
    (run / "job.json").write_text(json.dumps({"user_id": user_id, "status": status}))
    (run / "auto_masks.zip").write_text("masks")
    upload = tmp_path / "sessions" / "inference" / session_id
    (upload / "BDMAP_00000001").mkdir(parents=True)
    (upload / ".owner").write_text(user_id)
    (upload / "BDMAP_00000001" / "ct.nii.gz").write_text("scan")
    return run, upload


def test_delete_history_removes_upload_page_runs(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("ee@ff.com", "hunter2pass")
    theirs = auth_store.create_user("gg@hh.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-mine", mine["id"])
    their_run, their_upload = _upload_page_run(tmp_path, "sess-theirs", theirs["id"])
    # a CT uploaded ahead of Run and never run: only the .owner record exists
    pre = tmp_path / "sessions" / "inference" / "sess-pre"
    pre.mkdir(parents=True)
    (pre / ".owner").write_text(mine["id"])

    assert job_store.delete_run_folders_for_user(mine["id"]) == ["sess-mine", "sess-pre"]
    assert not run.exists() and not upload.exists() and not pre.exists()
    assert their_run.exists() and their_upload.exists()


def test_delete_history_leaves_a_run_still_in_progress(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("ii@jj.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-live", user["id"], status="running")

    removed = job_store.delete_run_folders_for_user(user["id"], is_active=lambda sid: sid == "sess-live")

    assert removed == []
    assert run.exists() and upload.exists()


def test_delete_history_skips_folders_with_no_owner_record(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("kk@ll.com", "hunter2pass")
    legacy = tmp_path / "runs" / "sess-legacy"
    legacy.mkdir(parents=True)
    (legacy / "job.json").write_text(json.dumps({"status": "completed"}))
    (tmp_path / "runs" / "job_durations.jsonl").parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / "runs" / "job_durations.jsonl").write_text("{}\n")

    assert job_store.delete_run_folders_for_user(user["id"]) == []
    assert legacy.exists()
    assert (tmp_path / "runs" / "job_durations.jsonl").exists()


def test_purge_removes_upload_page_runs_too(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("mm@nn.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-gone", user["id"])
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert not run.exists() and not upload.exists()


def _staged_sample(tmp_path, session_id, user_id):
    """A sample the stager copied for this account, and its reservation slot."""
    inference = tmp_path / "sessions" / "inference"
    sample = inference / session_id
    (sample / "BDMAP_SAMPLE").mkdir(parents=True)
    (sample / ".owner").write_text(user_id)
    (sample / ".sample-staging").touch()
    (sample / "BDMAP_SAMPLE" / "ct.nii.gz").write_text("scan")
    bucket = inference / ".sample-reservations" / hashlib.sha256(user_id.encode()).hexdigest()
    bucket.mkdir(parents=True)
    (bucket / "0").write_text(json.dumps({"session_id": session_id}))
    return sample, bucket


def test_delete_history_leaves_staged_samples_to_the_stager(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("ww@xx.com", "hunter2pass")
    sample, bucket = _staged_sample(tmp_path, "sess-sample", user["id"])
    _, upload = _upload_page_run(tmp_path, "sess-run", user["id"])

    assert job_store.delete_run_folders_for_user(user["id"]) == ["sess-run"]
    # Deleting the folder by hand would leave its reservation slot taken.
    assert sample.exists() and (bucket / "0").exists()
    assert not upload.exists()


def test_purge_removes_staged_samples_and_their_reservations(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("yy@zz.com", "hunter2pass")
    other = auth_store.create_user("zz@aa.com", "hunter2pass")
    sample, bucket = _staged_sample(tmp_path, "sess-sample", user["id"])
    their_sample, their_bucket = _staged_sample(tmp_path, "sess-their-sample", other["id"])
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert not sample.exists() and not bucket.exists()
    assert their_sample.exists() and their_bucket.exists()


def test_the_sample_folder_names_match_the_stager():
    from services import job_store, sample_staging

    assert job_store.SAMPLE_STAGING_MARKER == sample_staging.MARKER
    stager = sample_staging.SampleStager("/srv/inference", "someone")
    assert stager.bucket.parent.name == job_store.SAMPLE_RESERVATIONS
