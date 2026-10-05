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


def test_out_of_memory_on_idle_worker_is_not_rerun_locally(monkeypatch):
    # A scan too big for an idle worker would fail on bdmap1 too, and a huge
    # allocation there can hang the machine that serves the website.
    _stub_phases(monkeypatch)
    oom = "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 32.32 GiB."
    with pytest.raises(gpu_workers.RemoteModelFailed) as info:
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=1, err=oom))
    assert info.value.retry_locally is False and info.value.returncode == 1 and "out of memory" in info.value.output

    with pytest.raises(gpu_workers.RemoteModelFailed) as info:
        gpu_workers.run_on_worker("w1", "c", "/s", None, lambda argv: _FakeProc(returncode=1, err="ImportError: x"))
    assert info.value.retry_locally is True  # other failures still get the local re-run

    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: (_ for _ in ()).throw(info.value.__class__(
        "w1", "model exited 1", returncode=1, output=oom, retry_locally=False)))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: pytest.fail("re-ran locally after OOM"))
    with pytest.raises(subprocess.CalledProcessError) as failed:
        auto_segmentor._tracked_run("model", shell=True, check=True)
    assert failed.value.returncode == 1 and "out of memory" in failed.value.stderr
    result = auto_segmentor._tracked_run("model", shell=True)  # check=False callers get the failure back
    assert result.returncode == 1 and "out of memory" in result.stderr
    assert "w1" not in gpu_workers._cooldown_until  # the scan was at fault, not the worker


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


# ── Parallel jobs ───────────────────────────────────────────────────────────
import threading
import time


def _score_everyone_equal(monkeypatch):
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0))


def test_concurrent_jobs_never_get_the_same_worker(monkeypatch):
    # 8 threads fight over 3 workers, 40 rounds each: no worker is ever held by
    # two jobs at once, and every job eventually gets one.
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2,w3")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "30")
    _score_everyone_equal(monkeypatch)
    holders, problems, done = {}, [], []
    guard = threading.Lock()

    def job():
        for _ in range(40):
            h = gpu_workers.acquire_host()
            if h is None:
                problems.append("got None while workers exist")
                return
            with guard:
                if h in holders:
                    problems.append(f"{h} held twice")
                holders[h] = True
            time.sleep(0.001)
            with guard:
                del holders[h]
            gpu_workers.release_host(h)
        done.append(1)

    threads = [threading.Thread(target=job) for _ in range(8)]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    assert problems == [] and len(done) == 8 and not gpu_workers._busy_hosts


def test_two_simultaneous_jobs_use_two_workers(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    _score_everyone_equal(monkeypatch)
    got, barrier = [], threading.Barrier(2)

    def job():
        barrier.wait()
        got.append(gpu_workers.acquire_host())

    threads = [threading.Thread(target=job) for _ in range(2)]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    assert sorted(got) == ["w1", "w2"]  # neither saw "no free worker" and fell back
    for h in got:
        gpu_workers.release_host(h)


def test_job_waits_for_a_busy_worker_instead_of_overflowing(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "30")
    _score_everyone_equal(monkeypatch)
    gpu_workers._busy_hosts.add("w1")  # another job holds it
    got = []
    t = threading.Thread(target=lambda: got.append(gpu_workers.acquire_host()))
    t.start()
    time.sleep(0.3)
    assert got == []  # still waiting, not overflowed to the web host
    gpu_workers.release_host("w1")
    t.join(10)
    assert got == ["w1"]
    gpu_workers.release_host("w1")


def test_wait_is_bounded(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "0.4")
    _score_everyone_equal(monkeypatch)
    gpu_workers._busy_hosts.add("w1")
    start = time.monotonic()
    assert gpu_workers.acquire_host() is None  # then the caller falls back locally
    assert 0.3 < time.monotonic() - start < 3


def test_nothing_to_wait_for_returns_at_once(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "60")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: None)  # every worker down
    start = time.monotonic()
    assert gpu_workers.acquire_host() is None
    assert time.monotonic() - start < 2


def test_wait_for_a_worker_is_cancellable(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "60")
    _score_everyone_equal(monkeypatch)
    gpu_workers._busy_hosts.add("w1")
    flag, errors = [], []

    def job():
        try:
            gpu_workers.acquire_host(cancelled=lambda: bool(flag))
        except gpu_workers.WorkerCancelled as e:
            errors.append(e)

    t = threading.Thread(target=job)
    t.start()
    time.sleep(0.2)
    flag.append(True)
    gpu_workers.release_host("w1")  # wakes the waiter, which sees the cancel
    t.join(10)
    assert len(errors) == 1


def test_unhealthy_free_worker_waits_for_the_busy_healthy_one(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "30")
    monkeypatch.setattr(gpu_workers, "_host_score", lambda h: (0.0, 0.0, 0) if h == "w1" else None)
    gpu_workers._busy_hosts.add("w1")  # healthy but busy; w2 is down
    got = []
    t = threading.Thread(target=lambda: got.append(gpu_workers.acquire_host()))
    t.start()
    time.sleep(0.3)
    assert got == []
    gpu_workers.release_host("w1")
    t.join(10)
    assert got == ["w1"]
    gpu_workers.release_host("w1")


@pytest.mark.parametrize("other_busy", [False, True])
def test_worker_released_during_health_checks_is_reconsidered(monkeypatch, other_busy):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2,w3" if other_busy else "w1,w2")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "0")
    gpu_workers._busy_hosts.add("w1")
    if other_busy:
        gpu_workers._busy_hosts.add("w3")
    checked = []

    def score(host):
        checked.append(host)
        if host == "w2":
            # A healthy worker finishes while the only free spare is checked.
            gpu_workers.release_host("w1")
            return None
        return (0.0, 0.0, 0)

    monkeypatch.setattr(gpu_workers, "_host_score", score)
    try:
        assert gpu_workers.acquire_host() == "w1"
        assert "w1" in checked
        assert "w3" not in checked
    finally:
        gpu_workers.release_host("w1")
        gpu_workers.release_host("w3")


def test_max_parallel_jobs_is_one_unless_asked_and_capped_by_workers(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "3")
    assert auto_segmentor.max_parallel_jobs() == 1  # workers disabled: strictly serial
    _enable(monkeypatch, "w1,w2")
    assert auto_segmentor.max_parallel_jobs() == 2  # capped by the number of workers
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "1")
    assert auto_segmentor.max_parallel_jobs() == 1
    monkeypatch.delenv("GPU_WORKER_PARALLEL")
    assert auto_segmentor.max_parallel_jobs() == 1  # default: no change on deploy
    for bad in ("abc", "0", "-4", ""):
        monkeypatch.setenv("GPU_WORKER_PARALLEL", bad)
        assert auto_segmentor.max_parallel_jobs() == 1


def _run_jobs_blocked(monkeypatch, slots, jobs):
    """Start `jobs` model runs that block inside the model; return the peak
    number inside at once."""
    monkeypatch.setattr(auto_segmentor, "_job_slots", threading.BoundedSemaphore(slots))
    inside, peak, release = [], [], threading.Event()
    lock = threading.Lock()

    def fake_epai(**kw):
        with lock:
            inside.append(1)
            peak.append(len(inside))
        release.wait(10)
        with lock:
            inside.pop()
        return "out"

    monkeypatch.setattr(auto_segmentor, "_run_epai_inference", fake_epai)
    monkeypatch.setattr(auto_segmentor, "_resolve_conda_activate_path", lambda: "")
    threads = [threading.Thread(target=auto_segmentor.run_auto_segmentation,
                                args=("in", "/s", "ePAI"), kwargs={"session_id": f"sess-{i}"})
               for i in range(jobs)]
    [t.start() for t in threads]
    time.sleep(0.4)
    seen = max(peak) if peak else 0
    release.set()
    [t.join(10) for t in threads]
    return seen


def test_job_slots_bound_how_many_models_run_at_once(monkeypatch):
    assert _run_jobs_blocked(monkeypatch, slots=1, jobs=3) == 1  # exactly the old behavior
    assert _run_jobs_blocked(monkeypatch, slots=2, jobs=3) == 2  # the third queues


def _local_fallback_setup(monkeypatch, popen):
    _enable(monkeypatch)
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: (_ for _ in ()).throw(gpu_workers.WorkerUnavailable("down")))
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", popen)


def test_web_host_gpu_runs_one_model_at_a_time_even_with_parallel_jobs(monkeypatch):
    active, peak = [], []
    guard = threading.Lock()

    class SlowProc(_FakeProc):
        def communicate(self, timeout=None):
            with guard:
                active.append(1)
                peak.append(len(active))
            time.sleep(0.2)
            with guard:
                active.pop()
            return "", ""

    _local_fallback_setup(monkeypatch, lambda cmd, **k: SlowProc())

    def job(i):
        auto_segmentor._thread_session.remote_session_dir = "/home/visitor/tmp/session-1"
        auto_segmentor._thread_session.sid = f"s{i}"
        auto_segmentor._tracked_run("model", shell=True, check=True)

    threads = [threading.Thread(target=job, args=(i,)) for i in range(3)]
    [t.start() for t in threads]
    [t.join(20) for t in threads]
    assert max(peak) == 1 and len(peak) == 3  # all three ran, one at a time


def test_waiting_for_the_web_host_gpu_is_cancellable(monkeypatch):
    _local_fallback_setup(monkeypatch, lambda cmd, **k: pytest.fail("ran while the web GPU was busy"))
    auto_segmentor._cancelled_sessions.add("s-cancel")
    assert auto_segmentor._local_gpu_lock.acquire(timeout=1)  # another job holds it
    try:
        errors = []

        def job():
            auto_segmentor._thread_session.remote_session_dir = "/home/visitor/tmp/session-1"
            auto_segmentor._thread_session.sid = "s-cancel"
            try:
                auto_segmentor._tracked_run("model", shell=True, check=True)
            except RuntimeError as e:
                errors.append(str(e))

        t = threading.Thread(target=job)
        t.start()
        t.join(10)
        assert errors == ["Inference cancelled"]
    finally:
        auto_segmentor._local_gpu_lock.release()
        auto_segmentor._cancelled_sessions.discard("s-cancel")


def test_disabled_path_never_touches_the_web_gpu_lock(monkeypatch):
    # With workers disabled the old behavior is byte-for-byte: no extra lock.
    monkeypatch.setattr(auto_segmentor.subprocess, "Popen", lambda cmd, **k: _FakeProc())
    assert auto_segmentor._local_gpu_lock.acquire(timeout=1)
    try:
        out = []
        t = threading.Thread(target=lambda: out.append(
            auto_segmentor._tracked_run("model", shell=True, check=True).returncode))
        t.start()
        t.join(5)
        assert out == [0]  # would hang if the lock were taken
    finally:
        auto_segmentor._local_gpu_lock.release()


# ── Review round: findings against the parallel-jobs change ─────────────────

def test_job_waits_when_another_job_reserves_a_worker_during_its_health_check(monkeypatch):
    # Finding: the busy-worker snapshot predates the health checks. Here job B
    # reserves w2 while job A is still checking it, so A must wait for it
    # instead of concluding "nothing to wait for" and falling back.
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    monkeypatch.setenv("GPU_WORKER_MAX_WAIT_SECONDS", "30")
    state = {"healthy": False, "b_took_it": False}

    def score(h):
        if h == "w2" and not state["b_took_it"]:
            state["b_took_it"] = True
            gpu_workers._busy_hosts.add("w2")  # job B takes it mid-check, once
        return (0.0, 0.0, 0) if state["healthy"] and h == "w2" else None

    monkeypatch.setattr(gpu_workers, "_host_score", score)
    got = []
    start = time.monotonic()
    t = threading.Thread(target=lambda: got.append((gpu_workers.acquire_host(), time.monotonic() - start)))
    t.start()
    time.sleep(0.4)
    assert got == []  # still waiting, did not return None / fall back
    state["healthy"] = True
    gpu_workers.release_host("w2")
    t.join(10)
    assert got and got[0][0] == "w2" and got[0][1] >= 0.35
    gpu_workers.release_host("w2")


def test_cancel_is_noticed_even_when_the_web_gpu_lock_is_free():
    # Finding: cancellation was only checked when the lock wait timed out.
    with pytest.raises(RuntimeError, match="cancelled"):
        with auto_segmentor._local_gpu_slot(lambda: True):
            pytest.fail("ran a model for a cancelled job")
    assert auto_segmentor._local_gpu_lock.acquire(blocking=False)  # lock was released
    auto_segmentor._local_gpu_lock.release()


def test_cancel_landing_just_as_the_web_gpu_lock_frees_is_noticed():
    assert auto_segmentor._local_gpu_lock.acquire(timeout=1)  # another job holds it
    flag, outcome = [], []

    def waiter():
        try:
            with auto_segmentor._local_gpu_slot(lambda: bool(flag)):
                outcome.append("ran")
        except RuntimeError:
            outcome.append("cancelled")

    t = threading.Thread(target=waiter)
    t.start()
    time.sleep(0.2)
    flag.append(True)  # user cancels while it waits...
    auto_segmentor._local_gpu_lock.release()  # ...and the lock frees at once
    t.join(10)
    assert outcome == ["cancelled"]


def _media_agentic_probe(monkeypatch, tmp_path, enabled):
    """Run the MedIA-Agentic runner with a fake subprocess; return whether the
    web host's GPU lock was held while the model command ran."""
    if enabled:
        _enable(monkeypatch)
    held = []

    def fake_run(cmd, **kw):
        held.append(auto_segmentor._local_gpu_lock.locked())
        return subprocess.CompletedProcess(cmd, 1, "", "stop here")

    ct = tmp_path / "ct.nii.gz"
    ct.write_bytes(b"x")
    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="MedIA-Agentic inference failed"):
        auto_segmentor._run_media_agentic_inference(str(ct), str(tmp_path / "s"), "organs")
    return held


def test_media_agentic_queues_on_the_web_gpu_lock_when_workers_are_enabled(monkeypatch, tmp_path):
    # Finding: it launches a GPU model directly, bypassing the lock, so it could
    # run alongside a local fallback job or another MedIA-Agentic job.
    assert _media_agentic_probe(monkeypatch, tmp_path, enabled=True) == [True]


def test_media_agentic_is_unchanged_when_workers_are_disabled(monkeypatch, tmp_path):
    assert _media_agentic_probe(monkeypatch, tmp_path, enabled=False) == [False]


# ── Review round 2 ──────────────────────────────────────────────────────────

def _run_sessions_blocked(monkeypatch, slots, session_ids):
    """Start one model run per entry of session_ids (repeats = the same session
    submitted again); return the peak number running at once and per-session peaks."""
    monkeypatch.setattr(auto_segmentor, "_job_slots", threading.BoundedSemaphore(slots))
    inside, peaks, release = {}, {"all": 0}, threading.Event()
    lock = threading.Lock()

    def fake_epai(session_dir, **kw):
        sid = auto_segmentor._thread_session.sid
        with lock:
            inside[sid] = inside.get(sid, 0) + 1
            peaks["all"] = max(peaks["all"], sum(inside.values()))
            peaks[sid] = max(peaks.get(sid, 0), inside[sid])
        release.wait(10)
        with lock:
            inside[sid] -= 1
        return "out"

    monkeypatch.setattr(auto_segmentor, "_run_epai_inference", fake_epai)
    monkeypatch.setattr(auto_segmentor, "_resolve_conda_activate_path", lambda: "")
    threads = [threading.Thread(target=auto_segmentor.run_auto_segmentation,
                                args=("in", "/s", "ePAI"), kwargs={"session_id": sid})
               for sid in session_ids]
    [t.start() for t in threads]
    time.sleep(0.5)
    snapshot = dict(peaks)
    release.set()
    [t.join(10) for t in threads]
    return snapshot, peaks


def test_a_repeated_session_never_overlaps_itself(monkeypatch):
    # Finding: with parallel jobs, a retry / double click for the same session
    # ran alongside the first, both writing the same workspace and outputs.
    before_release, final = _run_sessions_blocked(monkeypatch, slots=2, session_ids=["dup", "dup"])
    assert before_release["dup"] == 1  # the second waits for the first
    assert final["dup"] == 1  # ... and still runs afterwards (no run lost)


def test_a_waiting_duplicate_does_not_use_up_a_job_slot(monkeypatch):
    # dup, dup, other with 2 slots: the duplicate waits on its session, not on
    # a slot, so the other session still runs in parallel with the first.
    before_release, _ = _run_sessions_blocked(monkeypatch, slots=2, session_ids=["dup", "dup", "other"])
    assert before_release["all"] == 2 and before_release["dup"] == 1 and before_release["other"] == 1


def test_session_locks_do_not_leak(monkeypatch):
    _run_sessions_blocked(monkeypatch, slots=2, session_ids=["a", "a", "b"])
    assert auto_segmentor._session_locks == {}


def test_legacy_single_host_epai_mode_keeps_jobs_serial(monkeypatch):
    # Finding: EPAI_REMOTE_ENABLED sends every ePAI job to one fixed GPU outside
    # the worker pool, which parallel jobs would overload.
    _enable(monkeypatch, "w1,w2")
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "2")
    assert auto_segmentor.max_parallel_jobs() == 2
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", "true")
    assert auto_segmentor.max_parallel_jobs() == 1
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", "false")
    assert auto_segmentor.max_parallel_jobs() == 2


# ── Review round 3 ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("spelling", ["1", "true", "TRUE", "yes", "y", "Y", " on ", "On"])
def test_every_spelling_that_enables_legacy_epai_mode_forces_serial_jobs(monkeypatch, spelling):
    # Finding: the ePAI runner accepts "y" but the serial-mode guard used a
    # parser that did not, so EPAI_REMOTE_ENABLED=y plus parallel jobs would have
    # sent two ePAI jobs to the same fixed GPU.
    _enable(monkeypatch, "w1,w2")
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "2")
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", spelling)
    assert auto_segmentor._is_truthy(spelling) is True  # the runner really treats it as on
    assert auto_segmentor.max_parallel_jobs() == 1


@pytest.mark.parametrize("spelling", ["", "0", "false", "no", "n", "off", "maybe", "2"])
def test_other_spellings_leave_parallel_jobs_alone(monkeypatch, spelling):
    _enable(monkeypatch, "w1,w2")
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "2")
    monkeypatch.setenv("EPAI_REMOTE_ENABLED", spelling)
    assert auto_segmentor.max_parallel_jobs() == 2


def test_there_is_only_one_yes_no_parser():
    # The ePAI runner and the worker settings must never disagree about a value.
    assert auto_segmentor._is_truthy("y") and gpu_workers._truthy("y")
    for value in ["1", "true", "yes", "y", "on", "Y", " TRUE ", "0", "false", "no", "n", "off", "", None, "t", "2"]:
        assert auto_segmentor._is_truthy(value) == gpu_workers._truthy(value), value


# ── Review round 4 ──────────────────────────────────────────────────────────

def _score_while_another_job_fails_on(monkeypatch, victim, scores):
    """Health scores where, as `victim` is being checked, another job reserves
    it, fails on it (cooldown) and releases it: the scorer's result is stale."""
    state = {"done": False}

    def score(h):
        if h == victim and not state["done"]:
            state["done"] = True
            gpu_workers._busy_hosts.add(victim)   # job B reserves it...
            gpu_workers.mark_failed(victim)        # ...fails on it...
            gpu_workers.release_host(victim)       # ...and releases it
        return scores[h]

    monkeypatch.setattr(gpu_workers, "_host_score", score)


def test_a_worker_that_failed_meanwhile_is_not_reserved_on_a_stale_score(monkeypatch):
    # Finding: the commit step checked busy but not cooldown, so a worker another
    # job had just put in a 600 s cooldown was handed straight to a new job.
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1")
    _score_while_another_job_fails_on(monkeypatch, "w1", {"w1": (0.0, 0.0, 0)})
    assert gpu_workers.acquire_host() is None  # nothing usable: the caller falls back
    assert "w1" not in gpu_workers._busy_hosts


def test_another_healthy_worker_is_used_when_the_best_one_just_failed(monkeypatch):
    monkeypatch.setenv("GPU_WORKER_HOSTS", "w1,w2")
    _score_while_another_job_fails_on(monkeypatch, "w1", {"w1": (0.0, 0.0, 0), "w2": (5.0, 0.0, 0)})
    assert gpu_workers.acquire_host() == "w2"  # w1 ranked first but is cooling down now
    assert gpu_workers._busy_hosts == {"w2"}
    gpu_workers.release_host("w2")


@pytest.mark.parametrize("workers_enabled", [False, True])
@pytest.mark.parametrize("inference_fails", [False, True])
def test_direct_suprem_queues_only_inference_and_records_local_host(
    monkeypatch, tmp_path, workers_enabled, inference_fails
):
    from contextlib import contextmanager

    if workers_enabled:
        _enable(monkeypatch)
    monkeypatch.setenv("SUPREM_USE_DIRECT_PYTHON", "true")
    monkeypatch.setenv("SUPREM_SRC_PATH", str(tmp_path / "source"))
    monkeypatch.setattr(auto_segmentor, "_stage_nifti_gz", lambda *a: None)
    monkeypatch.setattr(auto_segmentor, "get_least_used_gpu", lambda: "0")
    monkeypatch.setattr(gpu_workers, "_local_hostname", lambda: "web-host")
    monkeypatch.setattr(gpu_workers, "run", lambda *a, **k: pytest.fail("direct SuPreM sent remote"))
    auto_segmentor._thread_session.sid = "direct-suprem"
    held = []
    calls = []
    notes = []

    @contextmanager
    def slot(cancelled):
        assert cancelled is auto_segmentor._current_session_cancelled
        held.append(True)
        try:
            yield
        finally:
            held.clear()

    monkeypatch.setattr(auto_segmentor, "_local_gpu_slot", slot)
    monkeypatch.setattr(auto_segmentor, "_note_run", lambda sid, host: notes.append((sid, host)))

    def run(cmd, **kwargs):
        from pathlib import Path

        calls.append(cmd)
        if len(calls) == 1:
            assert bool(held) == workers_enabled
            assert kwargs["env"]["CUDA_VISIBLE_DEVICES"] == "0"
            assert notes == [("direct-suprem", "web-host")]
            if inference_fails:
                raise subprocess.CalledProcessError(1, cmd)
            output = Path(cmd[cmd.index("--save_dir") + 1]) / "ct"
            output.mkdir()
            (output / "combined_labels.nii.gz").touch()
        else:
            assert not held, "CPU postprocessing must release the GPU slot"
            assert cmd[1].endswith("postprocess_suprem.py")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(auto_segmentor, "_tracked_run", run)
    try:
        if inference_fails:
            with pytest.raises(RuntimeError, match="SuPreM inference failed"):
                auto_segmentor._run_suprem_inference("input.nii.gz", str(tmp_path / "session"))
            assert len(calls) == 1
        else:
            result = auto_segmentor._run_suprem_inference("input.nii.gz", str(tmp_path / "session"))
            assert result == str(tmp_path / "session" / "suprem" / "outputs" / "ct")
            assert len(calls) == 2
        assert not held
        assert notes == [("direct-suprem", "web-host")]
    finally:
        auto_segmentor._thread_session.sid = None
