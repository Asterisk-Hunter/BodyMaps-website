"""Unit tests for remote GPU worker dispatch (services/gpu_workers.py).

No network or GPU: SSH, rsync and hosts are faked. The properties that matter
for keeping the website up are covered here:
  * disabled by default -> model commands run locally exactly as before;
  * any worker problem -> next worker, then local fallback;
  * any failed remote run (except a user cancel) -> one local re-run, so the
    remote path never fails a job a local run would complete;
  * secrets never forwarded to a worker;
  * cancel reaches the remote process tree.
"""
import subprocess

import pytest

from services import auto_segmentor, gpu_workers


class _FakeProc:
    def __init__(self, returncode=0, out="", err="", hang=False):
        self.returncode = returncode
        self.pid = 4242
        self._out, self._err = out, err
        self._hang = hang
        self.killed = False

    def communicate(self, timeout=None):
        if self._hang and not self.killed:
            raise subprocess.TimeoutExpired("ssh", timeout)
        return self._out, self._err

    def kill(self):
        self.killed = True

    def poll(self):
        return None


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("GPU_WORKERS_ENABLED", "GPU_WORKER_HOSTS", "GPU_WORKER_LOCAL_FALLBACK"):
        monkeypatch.delenv(key, raising=False)
    auto_segmentor._thread_session.remote_session_dir = "/home/visitor/tmp/session-1"
    auto_segmentor._thread_session.sid = None
    gpu_workers._busy_hosts.clear()
    gpu_workers._cooldown_until.clear()
    yield
    gpu_workers._cooldown_until.clear()
    auto_segmentor._thread_session.remote_session_dir = None


def _enable(monkeypatch, hosts="w1,w2"):
    monkeypatch.setenv("GPU_WORKERS_ENABLED", "true")
    monkeypatch.setenv("GPU_WORKER_HOSTS", hosts)


def test_disabled_by_default_runs_locally(monkeypatch):
    called = []
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: pytest.fail("remote used while disabled"))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: called.append(cmd) or _FakeProc())
    result = auto_segmentor._tracked_run("echo hi", shell=True, executable="/bin/bash", check=True)
    assert called == ["echo hi"] and result.returncode == 0


def test_list_commands_never_go_remote(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: pytest.fail("list command sent remote"))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _FakeProc())
    auto_segmentor._tracked_run(["scp", "a", "b"], text=True, capture_output=True)


def test_remote_success_skips_local(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda cmd, d, cwd, popen, cancelled: subprocess.CompletedProcess(cmd, 0, "", ""))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: pytest.fail("ran locally"))
    assert auto_segmentor._tracked_run("model", shell=True, check=True).returncode == 0


def test_remote_model_failure_raises_like_local(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda cmd, d, cwd, popen, cancelled: subprocess.CompletedProcess(cmd, 1, "", ""))
    with pytest.raises(subprocess.CalledProcessError):
        auto_segmentor._tracked_run("model", shell=True, check=True)


def test_worker_unavailable_falls_back_to_local(monkeypatch):
    _enable(monkeypatch)
    local = []

    def no_worker(*a, **k):
        raise gpu_workers.WorkerUnavailable("none idle")

    monkeypatch.setattr(gpu_workers, "run", no_worker)
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: local.append(cmd) or _FakeProc())
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert local == ["model"]


def test_fallback_can_be_disabled(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setenv("GPU_WORKER_LOCAL_FALLBACK", "false")

    def no_worker(*a, **k):
        raise gpu_workers.WorkerUnavailable("none idle")

    monkeypatch.setattr(gpu_workers, "run", no_worker)
    with pytest.raises(RuntimeError, match="local fallback is disabled"):
        auto_segmentor._tracked_run("model", shell=True, check=True)


def test_no_session_context_stays_local(monkeypatch):
    _enable(monkeypatch)
    auto_segmentor._thread_session.remote_session_dir = None
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: pytest.fail("remote without session"))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _FakeProc())
    auto_segmentor._tracked_run("model", shell=True)


def test_secrets_are_never_forwarded():
    env = {
        "EPAI_TTA_AXES": "1,2", "nnUNet_raw": "/r", "CONDA_ENV_EPAI": "epai",
        "WORKER_API_TOKEN": "x", "EPAI_API_KEY": "x", "EPAI_REMOTE_HOST": "h",
        "GPU_WORKER_HOSTS": "w1", "HOME": "/home/visitor", "SECRET_KEY": "x",
    }
    assert gpu_workers.forwarded_env(env) == {
        "EPAI_TTA_AXES": "1,2", "nnUNet_raw": "/r", "CONDA_ENV_EPAI": "epai",
    }


def test_remote_command_is_quoted_and_killable():
    line = gpu_workers.build_remote_command(
        "echo 'a b' && touch /tmp/x", "/opt/src", "/s/.pid", environ={"EPAI_X": "v w"})
    assert line.startswith("env EPAI_X='v w' setsid -w /bin/bash -c ")
    assert "cd /opt/src" in line and "/s/.pid" in line


def test_referenced_paths_skip_session_and_missing(tmp_path):
    present = tmp_path / "model"
    present.mkdir()
    cmd = f"run -m {present} -i /home/visitor/tmp/session-1/in -x /home/nope/missing"
    # tmp_path is not under /home on every OS, so feed it through the regex-free path.
    paths = gpu_workers.referenced_paths(cmd.replace(str(present), "/home/visitor/tmp/session-1/w"),
                                         "/home/visitor/tmp/session-1")
    assert paths == []


_IDLE_GPU = "36, 0, Not Active, Not Active, Not Active"  # real bdmap2 output


def _health(host="bdmap2", procs=(), gpu=_IDLE_GPU, load="0.10 20", mem_gb=90):
    lines = [f"HOST {host}"] + [f"PROC {p}" for p in procs]
    lines += [f"GPU {gpu}", f"LOAD {load}", f"MEM {mem_gb * 1024 * 1024}"]
    return "\n".join(lines)


def test_health_requires_free_memory_and_no_foreign_gpu_job(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_MIN_FREE_GB", "40")
    ok = lambda out: gpu_workers.health_ok(out, local_hostname="bdmap1")  # noqa: E731
    assert ok(_health())
    assert ok(_health(procs=["python /home/visitor/x/epai_warm_server.py"]))
    assert not ok(_health(procs=["python /home/visitor/gt_eval.py"]))  # someone's job
    assert not ok(_health(mem_gb=10))  # unified memory nearly full
    assert not ok(_health(host="bdmap1"))  # the web host itself is never a worker
    assert not ok("")  # unparseable -> treat as unhealthy


def test_health_rejects_hot_throttled_or_loaded_hosts():
    ok = lambda out: gpu_workers.health_ok(out, local_hostname="bdmap1")  # noqa: E731
    assert not ok(_health(gpu="88, 0, Not Active, Not Active, Not Active"))  # too hot
    assert not ok(_health(gpu="60, 0, Not Active, Active, Not Active"))  # thermal slowdown
    assert not ok(_health(gpu="60, 0, Active, Not Active, Not Active"))  # hardware slowdown
    assert not ok(_health(gpu="40, 95, Not Active, Not Active, Not Active"))  # hidden GPU job
    assert not ok(_health(load="18.0 20"))  # CPU-heavy job running
    assert ok(_health(gpu="[N/A], [N/A], [N/A], [N/A], [N/A]"))  # unreported fields are not held against it
    assert ok(_health(gpu=""))


def test_least_loaded_healthy_worker_is_chosen(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2,w3")
    scores = {"w1": (5.0, 0.1, 0), "w2": (0.0, 0.05, 0), "w3": None}
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: scores[h])
    assert gpu_workers.acquire_host() == "w2"
    assert gpu_workers._busy_hosts == {"w2"}  # the others were released
    gpu_workers.release_host("w2")
    scores["w2"] = (5.0, 0.1, 0)
    assert gpu_workers.acquire_host() == "w1"  # tie -> configured order
    gpu_workers.release_host("w1")


def test_failed_worker_cools_down(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0))
    gpu_workers._cooldown_until.clear()
    try:
        gpu_workers.mark_failed("w1")
        assert gpu_workers.acquire_host() == "w2"
        gpu_workers.release_host("w2")
        gpu_workers._cooldown_until["w1"] = 0
        assert gpu_workers.acquire_host() == "w1"
        gpu_workers.release_host("w1")
    finally:
        gpu_workers._cooldown_until.clear()


def test_cleanup_refuses_shallow_paths(monkeypatch):
    calls = []
    monkeypatch.setattr(gpu_workers, "_run", lambda *a, **k: calls.append(a))
    gpu_workers._cleanup("w1", "/home/visitor")
    gpu_workers._cleanup("w1", "relative/path/that/is/deep")
    gpu_workers._cleanup("w1", "/home/visitor/ePAI/model")  # not under tmp/
    gpu_workers._cleanup("w1", "/home/visitor/PanTS-Viewer/tmp/x")  # not a session id
    assert calls == []
    gpu_workers._cleanup("w1", "/home/visitor/PanTS-Viewer/tmp/effad307-9b3f-43af-8e41-075cb66db776")
    assert len(calls) == 1


def test_stale_prune_only_touches_the_session_parent(monkeypatch):
    calls = []
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: calls.append(cmd))
    gpu_workers._prune_stale("w1", "/home/visitor/ePAI/model")  # not a session path
    assert calls == []
    gpu_workers._prune_stale("w1", "/home/visitor/PanTS-Viewer/tmp/effad307-9b3f-43af-8e41-075cb66db776")
    script = calls[0][-1]
    assert "find /home/visitor/PanTS-Viewer/tmp -mindepth 1 -maxdepth 1 -type d -mmin +2880" in script


def test_raw_session_path_is_recreated_on_worker(monkeypatch):
    seen = []
    monkeypatch.setattr(gpu_workers, "_shares_session_filesystem", lambda h, d: False)
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: seen.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
    raw = "/home/visitor/PanTS-Viewer/flask-server/api/../../tmp/sid"
    gpu_workers._sync_to("w1", raw, "/home/visitor/PanTS-Viewer/tmp/sid")
    assert any(raw in " ".join(c) for c in seen if c[0] == "ssh")


def test_acquire_skips_busy_and_unhealthy(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2,w3")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0) if h == "w3" else None)
    gpu_workers._busy_hosts.add("w2")
    assert gpu_workers.acquire_host() == "w3"
    assert "w1" not in gpu_workers._busy_hosts  # released after failed health check
    gpu_workers.release_host("w3")


def test_run_tries_next_worker_then_gives_up(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0))
    attempts = []

    def flaky(host, *a, **k):
        attempts.append(host)
        if host == "w1":
            raise gpu_workers.WorkerUnavailable("w1 rebooted")
        return subprocess.CompletedProcess("c", 0, "", "")

    monkeypatch.setattr(gpu_workers, "run_on_worker", flaky)
    assert gpu_workers.run("c", "/s", None, None).returncode == 0
    assert attempts == ["w1", "w2"] and not gpu_workers._busy_hosts

    monkeypatch.setattr(gpu_workers, "run_on_worker",
                        lambda *a, **k: (_ for _ in ()).throw(gpu_workers.WorkerUnavailable("down")))
    with pytest.raises(gpu_workers.WorkerUnavailable):
        gpu_workers.run("c", "/s", None, None)
    assert not gpu_workers._busy_hosts


def test_acquire_releases_host_when_health_check_raises(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")

    def boom(h):
        raise ValueError("unexpected")

    monkeypatch.setattr(gpu_workers, "_host_score", boom)
    assert gpu_workers.acquire_host() is None
    assert not gpu_workers._busy_hosts


def _stub_phases(monkeypatch, cleaned=None, synced_back=None, killed=None):
    monkeypatch.setattr(gpu_workers, "_shares_session_filesystem", lambda h, d: False)
    monkeypatch.setattr(gpu_workers, "_sync_to", lambda h, raw, real: None)
    monkeypatch.setattr(gpu_workers, "_preflight", lambda h, c, d, cwd: None)
    monkeypatch.setattr(gpu_workers, "_cleanup", lambda h, d: (cleaned if cleaned is not None else []).append(d))
    monkeypatch.setattr(gpu_workers, "_sync_back", lambda h, d, **k: (synced_back if synced_back is not None else []).append(d))
    monkeypatch.setattr(gpu_workers, "kill_remote", lambda h, p: (killed if killed is not None else []).append(p))


def test_connection_loss_is_worker_problem(monkeypatch):
    cleaned, back, killed = [], [], []
    _stub_phases(monkeypatch, cleaned, back, killed)
    with pytest.raises(gpu_workers.WorkerUnavailable, match="connection lost"):
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=255))
    with pytest.raises(gpu_workers.WorkerUnavailable, match="not runnable"):
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=127))
    assert len(cleaned) == 2  # worker copy removed on every failure path
    assert back == []  # nothing fetched from a broken run
    assert len(killed) == 1  # orphan killed after a lost connection


def test_cancel_before_start_never_runs_model(monkeypatch):
    _stub_phases(monkeypatch)
    with pytest.raises(gpu_workers.WorkerCancelled):
        gpu_workers.run_on_worker("w1", "c", "/s", None,
                                  lambda argv: pytest.fail("model started after cancel"),
                                  cancelled=lambda: True)
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")
    with pytest.raises(gpu_workers.WorkerCancelled):
        gpu_workers.run("c", "/s", None, None, cancelled=lambda: True)


def test_cancel_during_run_kills_and_skips_sync_back(monkeypatch):
    back, killed = [], []
    _stub_phases(monkeypatch, synced_back=back, killed=killed)
    flag = []

    def start(argv):
        flag.append(True)  # user cancels while the model runs
        return _FakeProc(returncode=-15)

    with pytest.raises(gpu_workers.WorkerCancelled):
        gpu_workers.run_on_worker("w1", "c", "/s", None, start, cancelled=lambda: bool(flag))
    assert back == [] and len(killed) == 1


def test_signalled_ssh_without_cancel_fails_without_fallback(monkeypatch):
    back, killed = [], []
    _stub_phases(monkeypatch, synced_back=back, killed=killed)
    result = gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=-9))
    assert result.returncode == -9  # fails like a signalled local run, not "cancelled"
    assert back == [] and len(killed) == 1


def test_refused_shared_worker_is_never_cleaned(monkeypatch):
    # Cleanup on a shared filesystem would delete the live session.
    cleaned = []
    _stub_phases(monkeypatch, cleaned=cleaned)
    monkeypatch.setattr(gpu_workers, "_shares_session_filesystem", lambda h, d: True)
    with pytest.raises(gpu_workers.WorkerUnavailable, match="shares"):
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: pytest.fail("ran on shared worker"))
    assert cleaned == []


def test_lost_results_skip_other_workers(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0))
    _stub_phases(monkeypatch)
    starts = []

    def lost(h, d, **k):
        raise gpu_workers.RemoteResultLost(h, "rsync failed")

    monkeypatch.setattr(gpu_workers, "_sync_back", lost)
    with pytest.raises(gpu_workers.RemoteResultLost):
        gpu_workers.run("c", "/s", None, lambda argv: starts.append(argv) or _FakeProc(returncode=0))
    assert len(starts) == 1  # w2 was NOT tried: the caller re-runs locally instead
    assert not gpu_workers._busy_hosts


def test_sync_back_retries_then_reports_lost(monkeypatch):
    calls = []
    monkeypatch.setattr(gpu_workers.time, "sleep", lambda s: None)
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: calls.append(cmd) or subprocess.CompletedProcess(cmd, 23, "", "boom"))
    with pytest.raises(gpu_workers.RemoteResultLost):
        gpu_workers._sync_back("w1", "/home/visitor/PanTS-Viewer/tmp/sid-1234567")
    assert len(calls) == 3
    for c in calls:
        assert "--update" not in c  # cross-host mtimes must not decide what is kept
        assert {"--exclude=job.json", "--exclude=.owner", "--exclude=auto_masks.zip"} <= set(c)


def test_sync_back_stops_retrying_after_cancel(monkeypatch):
    calls = []
    monkeypatch.setattr(gpu_workers.time, "sleep", lambda s: None)
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: calls.append(cmd) or subprocess.CompletedProcess(cmd, 23, "", "boom"))
    with pytest.raises(gpu_workers.WorkerCancelled):
        gpu_workers._sync_back("w1", "/home/visitor/PanTS-Viewer/tmp/sid-1234567",
                               cancelled=lambda: len(calls) >= 1)
    assert len(calls) == 1


@pytest.mark.parametrize("out,rc,shared", [
    ("FSTYPE ext2/ext3\n", 0, False),
    ("FSTYPE xfs\n", 0, False),
    ("SHARED\nFSTYPE ext2/ext3\n", 0, True),   # probe visible
    ("FSTYPE nfs\n", 0, True),                 # network fs even if probe was missed
    ("FSTYPE fuseblk\n", 0, True),
    ("", 255, None),                           # check failed -> worker unavailable
])
def test_shared_filesystem_detection(monkeypatch, tmp_path, out, rc, shared):
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: subprocess.CompletedProcess(cmd, rc, out, ""))
    if shared is None:
        with pytest.raises(gpu_workers.WorkerUnavailable):
            gpu_workers._shares_session_filesystem("w1", str(tmp_path))
    else:
        assert gpu_workers._shares_session_filesystem("w1", str(tmp_path)) is shared
    assert list(tmp_path.iterdir()) == []  # probe file removed


def test_cancel_kills_remote_tree(monkeypatch):
    killed = []
    proc = _FakeProc()
    proc.kill_remote = lambda: killed.append(True)
    auto_segmentor._session_procs["sid-1"] = proc
    monkeypatch.setattr(auto_segmentor.os, "getpgid", lambda pid: (_ for _ in ()).throw(OSError()), raising=False)
    try:
        auto_segmentor.cancel_session("sid-1")
    finally:
        auto_segmentor._session_procs.pop("sid-1", None)
    import time
    for _ in range(50):
        if killed:
            break
        time.sleep(0.01)
    assert killed == [True]


def test_cancel_never_falls_back_locally(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: pytest.fail("fell back locally"))
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: (_ for _ in ()).throw(gpu_workers.WorkerCancelled("x")))
    with pytest.raises(RuntimeError, match="cancelled"):
        auto_segmentor._tracked_run("model", shell=True, check=True)


@pytest.mark.parametrize("exc", [
    gpu_workers.RemoteModelFailed("w1", "model exited 1"),   # e.g. env drift on the worker
    gpu_workers.RemoteModelFailed("w1", "no result after 3600s; killed"),  # hung worker
    gpu_workers.RemoteResultLost("w1", "rsync failed"),
])
def test_failed_remote_run_is_redone_locally_and_worker_cools_down(monkeypatch, exc):
    _enable(monkeypatch)
    local = []
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: (_ for _ in ()).throw(exc))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: local.append(cmd) or _FakeProc())
    assert auto_segmentor._tracked_run("model", shell=True, check=True).returncode == 0
    assert local == ["model"]
    assert gpu_workers._cooldown_until.get("w1", 0) > 0  # local worked, so the worker was at fault


def test_genuine_model_failure_fails_without_blaming_the_worker(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: (_ for _ in ()).throw(
        gpu_workers.RemoteModelFailed("w1", "model exited 1")))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _FakeProc(returncode=1))
    with pytest.raises(subprocess.CalledProcessError):
        auto_segmentor._tracked_run("model", shell=True, check=True)
    assert "w1" not in gpu_workers._cooldown_until  # bad input, not a bad worker


def test_unexpected_dispatch_error_kills_remote_and_runs_locally(monkeypatch):
    _enable(monkeypatch)
    killed, local = [], []

    def buggy(cmd, d, cwd, popen, cancelled):
        proc = popen(["ssh", "w1", "model"])
        proc.kill_remote = lambda: killed.append(True)
        raise KeyError("bug")

    monkeypatch.setattr(gpu_workers, "run", buggy)
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: local.append(cmd) or _FakeProc())
    auto_segmentor._tracked_run("model", shell=True, check=True)
    assert killed == [True] and local[-1] == "model"


def test_remote_model_error_is_not_copied_back(monkeypatch):
    cleaned, back = [], []
    _stub_phases(monkeypatch, cleaned=cleaned, synced_back=back)
    with pytest.raises(gpu_workers.RemoteModelFailed, match="exited 1"):
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=1, err="CUDA error"))
    assert back == [] and len(cleaned) == 1


def test_hung_remote_run_is_killed(monkeypatch):
    killed = []
    _stub_phases(monkeypatch, killed=killed)
    monkeypatch.setenv("GPU_WORKER_MAX_RUN_SECONDS", "1")
    proc = _FakeProc(hang=True)
    with pytest.raises(gpu_workers.RemoteModelFailed, match="no result"):
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: proc)
    assert proc.killed and len(killed) == 1


def test_unreachable_host_gets_short_cooldown(monkeypatch):
    monkeypatch.setattr(gpu_workers, "_ensure_master", lambda h: None)
    monkeypatch.setattr(gpu_workers, "_run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 255, "", "no route"))
    assert gpu_workers._host_score("w1") is None
    wait = gpu_workers._cooldown_until["w1"] - __import__("time").time()
    assert 0 < wait <= 60


def test_ssh_reuses_connection_but_never_spawns_master_from_clients():
    argv = gpu_workers._ssh_base("w1")
    assert "ControlMaster=no" in argv and any(a.startswith("ControlPath=/tmp/gpuw-") for a in argv)
    assert "ControlMaster=no" in gpu_workers._rsync("w1", "a", "b")[5]



def test_cancel_flag_only_for_running_job_and_cleared_after(monkeypatch):
    # Not running (queued, finished or unknown): nothing recorded, so a later
    # run of the same session is not poisoned.
    auto_segmentor.cancel_session("sid-flag")
    assert "sid-flag" not in auto_segmentor._cancelled_sessions

    seen = []

    def on_start():
        # Holding the GPU slot: a cancel now is recorded even with no process.
        auto_segmentor.cancel_session("sid-flag")
        seen.append("sid-flag" in auto_segmentor._cancelled_sessions)
        return False

    auto_segmentor._thread_session.remote_session_dir = "/stale"
    auto_segmentor.run_auto_segmentation("in", "/s", "ePAI", session_id="sid-flag", on_start=on_start)
    assert seen == [True]
    assert "sid-flag" not in auto_segmentor._cancelled_sessions
    assert "sid-flag" not in auto_segmentor._active_sessions
    assert auto_segmentor._thread_session.remote_session_dir is None


def test_finished_run_does_not_clear_a_newer_runs_cancel(monkeypatch):
    newer = object()
    auto_segmentor._active_sessions["sid-race"] = newer
    auto_segmentor._cancelled_sessions.add("sid-race")
    monkeypatch.setattr(auto_segmentor, "_run_auto_segmentation", lambda *a, **k: None)
    try:
        auto_segmentor.run_auto_segmentation("in", "/s", "ePAI", session_id="sid-race")
        assert auto_segmentor._active_sessions.get("sid-race") is newer
        assert "sid-race" in auto_segmentor._cancelled_sessions
    finally:
        auto_segmentor._active_sessions.pop("sid-race", None)
        auto_segmentor._cancelled_sessions.discard("sid-race")
