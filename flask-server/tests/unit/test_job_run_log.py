"""Where each model job ran, recorded for later questions (services/job_run_log.py
and the bookkeeping in services/auto_segmentor.py). No network, GPU or database."""
import json
import subprocess
import time

import pytest

from services import auto_segmentor, gpu_workers, job_run_log


# ── the log file ────────────────────────────────────────────────────────────

def _write(path, **over):
    fields = dict(session_id="s1", model="ePAI", status="completed", duration_seconds=48.26,
                  input_size_bytes=123, run_info={"ran_on": ["bdmap2"], "fell_back": False})
    fields.update(over)
    job_run_log.record_job_run(str(path), **fields)


def test_a_record_has_the_machine_and_outcome_but_no_user_data(tmp_path):
    path = tmp_path / "job_runs.jsonl"
    _write(path)
    (rec,) = job_run_log.load(str(path))
    assert rec["ran_on"] == ["bdmap2"] and rec["fell_back"] is False
    assert rec["model"] == "ePAI" and rec["status"] == "completed" and rec["duration_seconds"] == 48.3
    assert "recorded_at" in rec and "error" not in rec
    assert not ({"user_id", "ip", "user", "email"} & set(rec))  # nothing identifying beyond the session id


def test_a_failure_keeps_a_short_error(tmp_path):
    path = tmp_path / "job_runs.jsonl"
    _write(path, status="failed", error="x" * 1000, run_info={"ran_on": ["bdmap1"], "fell_back": True})
    (rec,) = job_run_log.load(str(path))
    assert rec["status"] == "failed" and len(rec["error"]) == 300 and rec["fell_back"] is True


def test_no_run_info_still_records_the_job(tmp_path):
    path = tmp_path / "job_runs.jsonl"
    _write(path, status="cancelled", duration_seconds=None, run_info=None)  # cancelled while queued
    (rec,) = job_run_log.load(str(path))
    assert rec["ran_on"] == [] and rec["fell_back"] is False and rec["duration_seconds"] is None


def test_the_file_is_trimmed_to_the_newest_records(tmp_path, monkeypatch):
    monkeypatch.setattr(job_run_log, "MAX_LINES", 5)
    path = tmp_path / "job_runs.jsonl"
    for i in range(9):
        _write(path, session_id=f"s{i}")
    ids = [r["session_id"] for r in job_run_log.load(str(path))]
    assert ids == [f"s{i}" for i in range(4, 9)]


def test_logging_can_never_raise(tmp_path, capsys):
    # A path that cannot be written (its parent is a file) must be swallowed.
    blocker = tmp_path / "file"
    blocker.write_text("x")
    _write(blocker / "job_runs.jsonl")
    assert "[job_run_log]" in capsys.readouterr().out


def test_load_skips_garbage_and_filters_by_age(tmp_path):
    path = tmp_path / "job_runs.jsonl"
    now = time.time()
    path.write_text("\n".join([
        json.dumps({"recorded_at": now - 10 * 86400, "model": "old"}),
        "not json at all",
        json.dumps({"recorded_at": now - 3600, "model": "recent"}),
    ]) + "\n")
    assert [r["model"] for r in job_run_log.load(str(path))] == ["old", "recent"]
    assert [r["model"] for r in job_run_log.load(str(path), days=2)] == ["recent"]
    assert job_run_log.load(str(tmp_path / "missing.jsonl")) == []


def test_summary_answers_where_jobs_ran_and_how_often_they_fell_back(tmp_path):
    path = tmp_path / "job_runs.jsonl"
    _write(path)
    _write(path, run_info={"ran_on": ["bdmap4"], "fell_back": False})
    _write(path, status="failed", error="boom", run_info={"ran_on": ["bdmap1"], "fell_back": True})
    out = job_run_log.summarize(job_run_log.load(str(path)))
    assert "3 jobs: completed 2, failed 1" in out
    assert "bdmap2 1" in out and "bdmap4 1" in out and "bdmap1 1" in out
    assert "fell back to the web host: 1 (33%)" in out
    assert "failed ePAI on bdmap1: boom" in out
    assert job_run_log.summarize([]) == "no jobs recorded"


# ── recording the machine while a job runs ──────────────────────────────────

class _Proc:
    def __init__(self, rc=0):
        self.returncode, self.pid = rc, 4242

    def communicate(self, timeout=None):
        return "", ""

    def poll(self):
        return None


@pytest.fixture(autouse=True)
def _session(monkeypatch):
    for key in ("GPU_WORKERS_ENABLED", "GPU_WORKER_HOSTS", "GPU_WORKER_LOCAL_FALLBACK"):
        monkeypatch.delenv(key, raising=False)
    auto_segmentor._thread_session.sid = "run-1"
    auto_segmentor._thread_session.remote_session_dir = "/home/visitor/tmp/session-1"
    auto_segmentor.pop_run_info("run-1")
    gpu_workers._cooldown_until.clear()
    yield
    auto_segmentor.pop_run_info("run-1")
    auto_segmentor._thread_session.remote_session_dir = None
    gpu_workers._cooldown_until.clear()


def _enable(monkeypatch):
    monkeypatch.setenv("GPU_WORKERS_ENABLED", "true")
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1.example.edu,w2.example.edu")


def _raising(exc):
    def run(*a, **k):
        raise exc
    return run


def test_a_job_on_a_worker_records_the_worker(monkeypatch):
    _enable(monkeypatch)

    def run(cmd, d, cwd, popen, cancelled):
        done = subprocess.CompletedProcess(cmd, 0, "", "")
        done.host = "w2.example.edu"
        return done

    monkeypatch.setattr(gpu_workers, "run", run)
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": ["w2"], "fell_back": False}


def test_gpu_workers_run_says_which_worker_ran_it(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0))
    monkeypatch.setattr(gpu_workers, "run_on_worker",
                        lambda host, *a, **k: subprocess.CompletedProcess("c", 0, "", ""))
    assert gpu_workers.run("c", "/s", None, None).host == "w1"


def test_a_fallback_to_the_web_host_is_flagged(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", _raising(gpu_workers.WorkerUnavailable("none healthy")))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _Proc())
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": [gpu_workers._local_hostname()], "fell_back": True}


def test_a_failed_worker_run_redone_locally_is_flagged(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", _raising(gpu_workers.RemoteModelFailed("w1.example.edu", "exited 1")))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _Proc())
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": [gpu_workers._local_hostname()], "fell_back": True}


def test_an_out_of_memory_failure_records_the_worker_not_a_fallback(monkeypatch):
    _enable(monkeypatch)
    oom = gpu_workers.RemoteModelFailed("w1.example.edu", "exited 1", returncode=1,
                                        output="CUDA out of memory", retry_locally=False)
    monkeypatch.setattr(gpu_workers, "run", _raising(oom))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: pytest.fail("re-ran locally"))
    with pytest.raises(subprocess.CalledProcessError):
        auto_segmentor._tracked_run("model", shell=True, check=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": ["w1"], "fell_back": False}


def test_a_plain_local_run_with_workers_off_is_recorded_without_a_fallback_flag(monkeypatch):
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _Proc())
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": [gpu_workers._local_hostname()], "fell_back": False}


def test_commands_that_are_not_model_runs_record_nothing(monkeypatch):
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _Proc())
    auto_segmentor._tracked_run(["scp", "a", "b"], text=True, capture_output=True)  # a list, not a model command
    auto_segmentor._thread_session.remote_session_dir = None
    auto_segmentor._tracked_run("echo hi", shell=True)  # no session context
    assert auto_segmentor.pop_run_info("run-1") == {}


def test_several_commands_in_one_job_list_each_machine_once(monkeypatch):
    auto_segmentor._note_run("run-1", "w1.example.edu")
    auto_segmentor._note_run("run-1", "w1.example.edu")
    auto_segmentor._note_run("run-1", "bdmap1", fell_back=True)
    assert auto_segmentor.pop_run_info("run-1") == {"ran_on": ["w1", "bdmap1"], "fell_back": True}
    assert auto_segmentor.pop_run_info("run-1") == {}  # taken once, then gone


def test_bookkeeping_without_a_session_or_host_is_ignored_and_bounded():
    auto_segmentor._note_run(None, "w1")
    auto_segmentor._note_run("run-1", None)
    assert auto_segmentor.pop_run_info("run-1") == {}
    try:
        for i in range(1200):  # a caller that never pops must not grow it forever
            auto_segmentor._note_run(f"leak-{i}", "w1")
        assert len(auto_segmentor._run_info) <= 1001
    finally:
        for i in range(1200):
            auto_segmentor.pop_run_info(f"leak-{i}")


# ── the API layer records every way a job can end ───────────────────────────

def test_every_way_a_job_ends_is_recorded_and_the_entry_is_always_released():
    """api_blueprint cannot be imported without the full app dependencies, so
    check its source: every exit of the job thread logs its outcome, and the
    finally block always drops the in-memory entry."""
    import ast
    import os

    path = os.path.join(os.path.dirname(__file__), "..", "..", "api", "api_blueprint.py")
    tree = ast.parse(open(path, encoding="utf-8").read())
    job = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "do_segmentation_and_zip")

    logged = []
    for call in ast.walk(job):
        if isinstance(call, ast.Call) and getattr(call.func, "id", None) == "_log_run":
            logged.append(call.args[0].value)
    # cancelled (skip-zip), failed (no output), completed, cancelled-by-exception, failed-by-exception
    assert sorted(logged) == ["cancelled", "cancelled", "completed", "failed", "failed"]

    try_node = next(n for n in ast.walk(job) if isinstance(n, ast.Try))
    in_finally = [getattr(c.func, "id", None) for stmt in try_node.finalbody for c in ast.walk(stmt) if isinstance(c, ast.Call)]
    assert "pop_run_info" in in_finally

    closure = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_log_run")
    calls = {getattr(c.func, "attr", getattr(c.func, "id", None)) for c in ast.walk(closure) if isinstance(c, ast.Call)}
    assert {"record_job_run", "pop_run_info"} <= calls
