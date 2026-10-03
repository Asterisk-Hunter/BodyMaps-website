"""Run model inference commands on remote GPU worker hosts (bdmap2-4).

The web server (bdmap1) keeps doing everything it does today -- staging inputs,
post-processing, zipping, status -- but the GPU-heavy model command itself can
run on another host. This keeps bdmap1's GPU free, so a worker reboot never
takes the website down.

How it works, per model command:
  1. health-check all workers in parallel and pick the least loaded healthy
     one: reachable, working GPU, not hot or throttled, GPU and CPU not busy,
     enough free memory, no foreign GPU process, not the web host, not in a
     cooldown after a recent failure;
  2. rsync the session directory (and flask-server/scripts) to the worker at
     the SAME absolute path, then preflight files, working dir, tools, disk;
  3. run the unchanged shell command there over SSH, inside its own session
     (setsid) so a cancel can kill the whole remote process tree;
  4. rsync results back (never the files the web app itself writes during a
     run), then delete the worker copy.

Every model command already uses absolute /home/visitor/... paths, so the only
requirement on a worker is an identical copy of the model environments and
weights (scripts/sync_gpu_workers.sh does that).

Failure policy -- the remote path may only ever help, never fail a job that a
local run would complete:
  * worker unhealthy, missing files, or connection lost before/while the model
    runs -> try the next worker, then run locally (unless disabled);
  * the remote model exits non-zero, runs past GPU_WORKER_MAX_RUN_SECONDS, or
    its results cannot be fetched -> re-run once locally (the authoritative
    environment); if that succeeds the worker was at fault and cools down;
  * user cancel at any stage -> stop, kill the remote process, never re-run.

SSH connections are reused per worker, so the per-job overhead is about the
time to copy the session's files over the LAN.

Several jobs can run at once (GPU_WORKER_PARALLEL, default 1), one per worker:
workers are reserved atomically after their health check, a job waits for a
busy worker rather than overflowing to the web host, and the web host's own GPU
still runs at most one model at a time (see auto_segmentor._local_gpu_slot).

Disabled unless GPU_WORKERS_ENABLED is true, so deploying this changes nothing.
"""
from __future__ import annotations

import os
import re
import shlex
import socket
import subprocess
import threading
import time
import uuid

_SSH_CONNECTION_ERROR = 255

# Environment variables forwarded to the remote command, by prefix. The web
# process has these from .env; an SSH session would not.
_FORWARD_PREFIXES = (
    "EPAI_", "ATLASNET_", "LESIONSEG_", "SUPREM_", "OPENVAE_", "MEDFORMER_",
    "RSUPER_", "SHAPEKIT_", "nnUNet_", "NNUNET_", "CONDA_", "PYTORCH_",
    "TORCH_", "OMP_", "MKL_",
)
_NEVER_FORWARD = re.compile(r"(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)", re.I)
_NEVER_FORWARD_PREFIXES = ("EPAI_REMOTE_", "GPU_WORKER")


class WorkerUnavailable(RuntimeError):
    """No worker could run the command; the caller may fall back to local."""


class WorkerCancelled(RuntimeError):
    """The user cancelled; never fall back to running locally."""


class RemoteRunFailed(RuntimeError):
    """The remote run started but did not produce a usable result.

    Not a WorkerUnavailable: trying yet another worker could repeat the same
    failure. The caller re-runs once on the web host, which is authoritative,
    so a remote problem can never fail a job that a local run would complete.
    Exception: retry_locally=False (the input itself is too big, see
    _is_out_of_memory), where a local re-run cannot succeed and could hang the
    web host.
    """

    def __init__(self, host: str, message: str, returncode: int | None = None,
                 output: str = "", retry_locally: bool = True):
        super().__init__(f"{host}: {message}")
        self.host = host
        self.returncode = returncode
        self.output = output
        self.retry_locally = retry_locally


class RemoteModelFailed(RemoteRunFailed):
    """The model exited non-zero or exceeded GPU_WORKER_MAX_RUN_SECONDS."""


def _is_out_of_memory(output: str) -> bool:
    """The model ran out of GPU memory on an otherwise idle worker.

    Workers are required to be idle with plenty of free memory, and bdmap1 has
    the same hardware with less free (it also runs the site and Ollama), so a
    scan that does not fit on a worker will not fit there either. Re-running it
    on the web host would fail again and, on GB10's shared CPU/GPU memory, can
    hang the machine that serves the website.
    """
    text = (output or "").lower()
    return "out of memory" in text or "outofmemoryerror" in text


class RemoteResultLost(RemoteRunFailed):
    """The model finished on a worker but its results could not be fetched."""


def _truthy(value) -> bool:
    """The one yes/no parser for environment flags (auto_segmentor uses it too),
    so a value like "y" can never mean yes to one setting and no to another."""
    return str(value or "").strip().lower() in ("1", "true", "yes", "y", "on")


def enabled() -> bool:
    return _truthy(os.getenv("GPU_WORKERS_ENABLED", "false")) and bool(hosts())


def hosts() -> list[str]:
    return [h.strip() for h in os.getenv("GPU_WORKER_HOSTS", "").split(",") if h.strip()]


def local_fallback_allowed() -> bool:
    return _truthy(os.getenv("GPU_WORKER_LOCAL_FALLBACK", "true"))


def _user() -> str:
    return os.getenv("GPU_WORKER_USER", "visitor").strip() or "visitor"


_SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"]


def _control_path(host: str) -> str:
    uid = getattr(os, "getuid", lambda: 0)()
    return f"/tmp/gpuw-{uid}-{re.sub(r'[^A-Za-z0-9.-]', '_', host)}"


def _mux_opts(host: str) -> list[str]:
    """Reuse one SSH connection per worker (about 0.02 s per call instead of a
    full handshake). Clients never create the master (ControlMaster=no) and
    connect directly if it is missing or dead, so this can only save time."""
    if not _truthy(os.getenv("GPU_WORKER_SSH_MULTIPLEX", "true")):
        return []
    return ["-o", "ControlMaster=no", "-o", f"ControlPath={_control_path(host)}"]


_master_locks: dict[str, threading.Lock] = {}
_master_locks_guard = threading.Lock()


def _ensure_master(host: str) -> None:
    """Start the shared SSH connection for a worker if it is not running.

    Started on its own with all stdio on /dev/null: a master spawned implicitly
    by a client (ControlMaster=auto + ControlPersist) inherits that client's
    output pipes and makes the caller wait until the master exits.
    """
    if not _truthy(os.getenv("GPU_WORKER_SSH_MULTIPLEX", "true")):
        return
    with _master_locks_guard:
        lock = _master_locks.setdefault(host, threading.Lock())
    with lock:  # two jobs must not both create (or remove) the same socket
        _ensure_master_locked(host)


def _ensure_master_locked(host: str) -> None:
    target = f"{_user()}@{host}"
    path = _control_path(host)
    check = subprocess.run(["ssh", "-o", f"ControlPath={path}", "-O", "check", target],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=5)
    if check.returncode == 0:
        return
    try:
        os.remove(path)  # stale socket from a master that died
    except OSError:
        pass
    master = subprocess.Popen(
        ["ssh", "-M", "-N", "-f", *_SSH_OPTS, "-o", "ConnectTimeout=5",
         "-o", f"ControlPath={path}", "-o", "ControlPersist=600", target],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        master.wait(timeout=10)  # -f: returns once connected and backgrounded
    except subprocess.TimeoutExpired:
        master.kill()


def _ssh_base(host: str, connect_timeout: int = 8) -> list[str]:
    return ["ssh", "-n", *_SSH_OPTS, "-o", f"ConnectTimeout={connect_timeout}",
            *_mux_opts(host), f"{_user()}@{host}"]


def _rsync_ssh_arg(host: str) -> str:
    return " ".join(["ssh", *_SSH_OPTS, "-o", "ConnectTimeout=8", *_mux_opts(host)])


def _rsync(host: str, *args) -> list[str]:
    # --timeout aborts after 120 s without I/O instead of waiting for the hard
    # cap. -W: whole files; the delta algorithm only costs CPU on a fast LAN.
    return ["rsync", "-a", "-W", "--timeout=120", "-e", _rsync_ssh_arg(host), *args]


def _run(cmd, timeout=None, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)


# ── Host selection ──────────────────────────────────────────────────────────

_busy_lock = threading.Lock()
_busy_cv = threading.Condition(_busy_lock)  # notified whenever a worker is released
_busy_hosts: set[str] = set()


def _min_free_kb() -> int:
    try:
        return int(float(os.getenv("GPU_WORKER_MIN_FREE_GB", "40")) * 1024 * 1024)
    except ValueError:
        return 40 * 1024 * 1024


# Tagged lines: HOST, one PROC per GPU compute process (its command line), GPU
# (temperature, utilization, slowdown flags), LOAD (1-min load, CPU count) and
# MEM (MemAvailable in kB). GB10 CPU and GPU share one memory pool, so an idle
# GPU does not imply free memory; both are checked.
_HEALTH_SCRIPT = (
    # No working GPU -> fail (nnU-Net would silently fall back to CPU).
    "nvidia-smi -L >/dev/null 2>&1 || exit 3; "
    "echo \"HOST $(hostname -s)\"; "
    "for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do "
    "echo \"PROC $(ps -o args= -p \"$p\" 2>/dev/null || echo unknown)\"; done; "
    "echo \"GPU $(nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,"
    "clocks_event_reasons.hw_slowdown,clocks_event_reasons.hw_thermal_slowdown,"
    "clocks_event_reasons.sw_thermal_slowdown --format=csv,noheader,nounits | head -1)\"; "
    "echo \"LOAD $(cut -d' ' -f1 /proc/loadavg) $(nproc)\"; "
    "awk '/^MemAvailable:/{print \"MEM \" $2}' /proc/meminfo"
)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def _local_hostname() -> str:
    return socket.gethostname().split(".")[0].lower()


def _num(text: str):
    """Number from an nvidia-smi field, or None for [N/A] / Not Supported."""
    try:
        return float(text.strip().rstrip("%").strip())
    except ValueError:
        return None


def health_score(output: str, local_hostname: str | None = None):
    """Parse the health script output. None = do not use this host; otherwise
    a sort key (lower is better: least GPU use, then least CPU load, then most
    free memory)."""
    tagged = {}
    procs = []
    for line in output.splitlines():
        tag, _, rest = line.strip().partition(" ")
        if tag == "PROC":
            procs.append(rest)
        elif tag in ("HOST", "GPU", "LOAD", "MEM"):
            tagged[tag] = rest.strip()
    if "HOST" not in tagged or not tagged.get("MEM", "").isdigit():
        return None  # unparseable -> unhealthy
    # Never treat the web host itself as a worker: cleanup deletes the remote
    # session copy, which on the web host would be the live session.
    if tagged["HOST"].split(".")[0].lower() == (local_hostname or _local_hostname()):
        return None
    mem_kb = int(tagged["MEM"])
    if mem_kb < _min_free_kb():
        return None
    # Resident warm predictors (epai_warm_server.py, lesionseg_warm_server.py)
    # are the worker's own serving processes, not someone else's job.
    if not all("_warm_server.py" in proc for proc in procs):
        return None
    # Fields a GPU doesn't report ([N/A]) are not held against it.
    gpu = [f.strip() for f in tagged.get("GPU", "").split(",")]
    temp = _num(gpu[0]) if len(gpu) > 0 else None
    util = _num(gpu[1]) if len(gpu) > 1 else None
    if any(f.lower() == "active" for f in gpu[2:5]):
        return None  # hardware or thermal slowdown: overheating or a fault
    if temp is not None and temp >= _env_float("GPU_WORKER_MAX_TEMP_C", 85):
        return None
    # Catches GPU work whose processes are not listed (e.g. in a container).
    if util is not None and util >= _env_float("GPU_WORKER_MAX_GPU_UTIL", 20):
        return None
    load = tagged.get("LOAD", "").split()
    try:
        load_ratio = float(load[0]) / max(1, int(load[1]))
    except (IndexError, ValueError):
        load_ratio = 0.0
    if load_ratio >= _env_float("GPU_WORKER_MAX_CPU_LOAD", 0.75):
        return None  # someone's CPU-heavy job would slow ours (and theirs)
    return (util or 0.0, load_ratio, -mem_kb)


def health_ok(output: str, local_hostname: str | None = None) -> bool:
    return health_score(output, local_hostname) is not None


def _host_score(host: str):
    try:
        _ensure_master(host)
        result = _run(_ssh_base(host, connect_timeout=5) + [_HEALTH_SCRIPT], timeout=20)
    except (subprocess.TimeoutExpired, OSError):
        result = None
    if result is None or result.returncode == _SSH_CONNECTION_ERROR:
        # Unreachable: skip it briefly so each job doesn't pay the connect timeout.
        mark_failed(host, _env_float("GPU_WORKER_UNREACHABLE_COOLDOWN_SECONDS", 60))
        return None
    return health_score(result.stdout) if result.returncode == 0 else None


# Hosts that failed during a job are skipped for a while, so a flapping or
# overheating worker doesn't cost every job an upload before it fails again.
_cooldown_until: dict[str, float] = {}


def mark_failed(host: str, secs: float | None = None) -> None:
    if secs is None:
        secs = _env_float("GPU_WORKER_COOLDOWN_SECONDS", 600)
    with _busy_lock:  # never shortens a longer cooldown already in place
        _cooldown_until[host] = max(_cooldown_until.get(host, 0), time.time() + secs)


def _max_wait_seconds() -> float:
    return _env_float("GPU_WORKER_MAX_WAIT_SECONDS", 300)


def _score_all(candidates) -> dict:
    """Health-check candidates in parallel (a dead host costs at most the SSH
    connect timeout, not one timeout per host). host -> score or None."""
    scores = {}

    def check(h):
        try:
            scores[h] = _host_score(h)
        except Exception as e:
            print(f"[gpu_workers] health check on {h} failed: {e}")
            scores[h] = None

    threads = [threading.Thread(target=check, args=(h,), daemon=True) for h in candidates]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    return scores


def acquire_host(exclude=(), cancelled=None) -> str | None:
    """Reserve the best healthy worker nobody holds. Caller must release.

    Safe with several jobs at once:
      * health checks run on the unreserved workers WITHOUT reserving them, so
        a concurrent job does not see them as taken while they are only being
        checked; the winner is reserved atomically afterwards, and a job that
        loses that race simply looks again;
      * the least loaded healthy worker wins, ties keep the configured order;
      * the winner is committed only if, under the lock, it is still unreserved
        and not in cooldown (its score may be a moment stale);
      * if no worker is usable right now but some are only busy with our own
        jobs, wait for one to be released (bounded by GPU_WORKER_MAX_WAIT_SECONDS,
        cancellable) instead of overflowing to the web host. Nothing to wait
        for (all down, cooling down or excluded) returns None at once.
    """
    deadline = time.monotonic() + _max_wait_seconds()
    announced = False
    while True:
        if cancelled is not None and cancelled():
            raise WorkerCancelled("cancelled while waiting for a GPU worker")
        now = time.time()
        with _busy_lock:
            eligible = [h for h in hosts() if h not in exclude and _cooldown_until.get(h, 0) <= now]
            free = [h for h in eligible if h not in _busy_hosts]
            holding = [h for h in eligible if h in _busy_hosts]
        if free:
            scores = _score_all(free)
            ranked = sorted((scores[h], i, h) for i, h in enumerate(free) if scores.get(h) is not None)
            for _, _, h in ranked:
                with _busy_lock:
                    # Re-check everything the choice depended on, under the lock
                    # mark_failed uses: another job may have reserved this worker,
                    # failed on it and put it in cooldown since we scored it.
                    if h not in _busy_hosts and _cooldown_until.get(h, 0) <= time.time():
                        _busy_hosts.add(h)
                        return h
            if ranked:
                continue  # healthy workers were all taken meanwhile: look again
        with _busy_lock:
            # Reservations can change while we were health-checking: another job
            # may have taken or released a worker. Reconsider newly free workers
            # before waiting or falling back; their health has not been checked.
            now = time.time()
            eligible = [h for h in hosts() if h not in exclude and _cooldown_until.get(h, 0) <= now]
            if any(h not in _busy_hosts and h not in free for h in eligible):
                continue
            holding = [h for h in eligible if h in _busy_hosts]
        if not holding:
            return None  # nobody will free up: the caller falls back
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        if not announced:
            print(f"[gpu_workers] all usable workers are busy with other jobs; waiting up to {remaining:.0f}s")
            announced = True
        with _busy_cv:
            if not any(h not in _busy_hosts for h in holding):  # none released since we looked
                _busy_cv.wait(timeout=min(remaining, 5.0))


def release_host(host: str) -> None:
    with _busy_cv:
        _busy_hosts.discard(host)
        _busy_cv.notify_all()


# ── Remote execution ────────────────────────────────────────────────────────

def forwarded_env(environ=None) -> dict:
    environ = os.environ if environ is None else environ
    out = {}
    for key, value in environ.items():
        if not key.startswith(_FORWARD_PREFIXES):
            continue
        if key.startswith(_NEVER_FORWARD_PREFIXES) or _NEVER_FORWARD.search(key):
            continue
        out[key] = value
    return out


def build_remote_command(cmd: str, cwd: str | None, pid_file: str, environ=None) -> str:
    """Remote shell line: own session (killable as a group), env, cwd, command."""
    env_prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in sorted(forwarded_env(environ).items()))
    inner = f"echo $$ > {shlex.quote(pid_file)}; "
    if cwd:
        inner += f"cd {shlex.quote(cwd)} && "
    inner += f"exec /bin/bash -c {shlex.quote(cmd)}"
    env_part = f"env {env_prefix} " if env_prefix else ""
    return f"{env_part}setsid -w /bin/bash -c {shlex.quote(inner)}"


def _scripts_dir() -> str:
    return os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "scripts"))


_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,}$")
# Never copied back: files the web app itself writes in the session dir (job
# status, owner marker, result zip), and worker-side pid/probe bookkeeping.
_BACK_EXCLUDES = (
    "--exclude=job.json", "--exclude=.owner", "--exclude=auto_masks.zip",
    "--exclude=.remote_*", "--exclude=.gpuw_probe_*",
)
_NETWORK_FS = re.compile(r"nfs|cifs|smb|fuse|lustre|gpfs|ceph|9p|afs|beegfs", re.I)


def _shares_session_filesystem(host: str, real_dir: str) -> bool:
    """True (or WorkerUnavailable) unless the worker's session path is provably
    a separate local disk.

    Cleanup deletes the worker copy; on a shared filesystem that would be the
    live session, so such a worker is refused. Two independent checks: a probe
    file created here must not be visible there, and the worker's session path
    must not be on a network filesystem (a probe alone can miss a share
    because of NFS lookup caching).
    """
    probe = os.path.join(real_dir, f".gpuw_probe_{uuid.uuid4().hex}")
    script = (
        f"test -e {shlex.quote(probe)} && echo SHARED; "
        f"d={shlex.quote(real_dir)}; while [ ! -e \"$d\" ]; do d=$(dirname \"$d\"); done; "
        "stat -f -c 'FSTYPE %T' \"$d\""
    )
    try:
        open(probe, "w").close()
        result = _run(_ssh_base(host) + [script], timeout=30)
    finally:
        try:
            os.remove(probe)
        except OSError:
            pass
    fstype = next((ln[7:].strip() for ln in result.stdout.splitlines() if ln.startswith("FSTYPE ")), "")
    if result.returncode != 0 or not fstype:
        raise WorkerUnavailable(f"{host}: filesystem check failed: {result.stderr.strip()[:300]}")
    return "SHARED" in result.stdout.split() or bool(_NETWORK_FS.search(fstype))


def _sync_to(host: str, raw_dir: str, real_dir: str) -> None:
    """Create the session path on the worker exactly as commands spell it.

    Commands use the session path as built by the web app, which can contain
    ".." (e.g. .../flask-server/api/../../tmp/<sid>). "mkdir -p" of that raw
    spelling creates every intermediate directory the worker's path resolution
    needs; the data itself is synced to the resolved path.
    """
    target = f"{_user()}@{host}"
    scripts = _scripts_dir()
    _prune_stale(host, real_dir)
    mk = _run(_ssh_base(host) + [
        f"mkdir -p {shlex.quote(raw_dir)} {shlex.quote(real_dir)} {shlex.quote(scripts)}"
    ], timeout=60)
    if mk.returncode != 0:
        raise WorkerUnavailable(f"{host}: mkdir failed: {mk.stderr.strip()[:300]}")
    for path, extra in ((real_dir, "--exclude=.gpuw_probe_*"), (scripts, "--exclude=__pycache__")):
        up = _run(_rsync(host, extra, f"{path}/", f"{target}:{path}/"), timeout=900)
        if up.returncode != 0:
            raise WorkerUnavailable(f"{host}: upload failed: {up.stderr.strip()[:300]}")


_ABS_PATH = re.compile(r"/home/[A-Za-z0-9_.+\-/]+")
_NOT_RUNNABLE = (126, 127)  # shell: not executable / command not found


def referenced_paths(cmd: str, session_dirs) -> list[str]:
    """Absolute paths a command depends on, excluding the synced session dir."""
    if isinstance(session_dirs, str):
        session_dirs = (session_dirs,)
    skip = tuple(d.rstrip("/") for d in session_dirs) + (_scripts_dir(),)
    found = {p.rstrip("/.,") for p in _ABS_PATH.findall(cmd)}
    # Only paths that exist here: an optional path absent on the web host too
    # must not make every worker look broken.
    return sorted(
        p for p in found
        if p and not p.startswith(skip) and os.path.exists(p)
    )


def _min_disk_kb() -> int:
    try:
        return int(float(os.getenv("GPU_WORKER_MIN_DISK_GB", "20")) * 1024 * 1024)
    except ValueError:
        return 20 * 1024 * 1024


def _preflight(host: str, cmd: str, session_dirs, cwd: str) -> None:
    """Before the model starts: model files, working dir, tools, disk space.

    Checks existence only, not versions; keep workers current with
    scripts/sync_gpu_workers.sh.
    """
    checks = [f"test -e {shlex.quote(p)}" for p in referenced_paths(cmd, session_dirs)]
    checks.append(f"test -d {shlex.quote(cwd)}")
    checks.append("command -v setsid >/dev/null && command -v rsync >/dev/null")
    checks.append(
        f"[ \"$(df -Pk {shlex.quote(session_dirs[-1])} | awk 'NR==2{{print $4}}')\" -ge {_min_disk_kb()} ]"
    )
    result = _run(_ssh_base(host) + [" && ".join(checks)], timeout=60)
    if result.returncode != 0:
        raise WorkerUnavailable(
            f"{host}: missing model files, tools or disk space (run scripts/sync_gpu_workers.sh)")


def _sync_back(host: str, real_dir: str, attempts: int = 3, cancelled=None) -> None:
    """Fetch results. Retried, and never a reason to re-run the model.

    No --update: it compares mtimes across two hosts' clocks and could keep a
    stale local file. Files the web app writes during a run are excluded instead.
    """
    target = f"{_user()}@{host}"
    last = ""
    for attempt in range(1, attempts + 1):
        if cancelled is not None and cancelled():
            raise WorkerCancelled(f"{host}: cancelled while fetching results")
        try:
            down = _run(_rsync(host, *_BACK_EXCLUDES, f"{target}:{real_dir}/", f"{real_dir}/"),
                        timeout=900)
            if down.returncode == 0:
                return
            last = down.stderr.strip()[:300]
        except (subprocess.TimeoutExpired, OSError) as e:
            last = str(e)
        if attempt < attempts:
            time.sleep(5 * attempt)
    raise RemoteResultLost(host, f"results could not be fetched after {attempts} attempts: {last}")


def _is_session_path(session_dir: str) -> bool:
    """Absolute, deep, inside a tmp/ dir, with a session-id basename."""
    parts = [p for p in session_dir.split("/") if p]
    return (session_dir.startswith("/") and len(parts) >= 4 and "tmp" in parts[:-1]
            and bool(_SESSION_ID.match(parts[-1])))


def _prune_stale(host: str, real_dir: str) -> None:
    """Delete worker session copies older than 2 days. Best-effort.

    Normally every job deletes its own copy; this catches copies left when the
    web app restarted mid-job, so a worker's disk never fills up over time.
    Only called after the shared-filesystem check has passed.
    """
    if not _truthy(os.getenv("GPU_WORKER_CLEANUP", "true")) or not _is_session_path(real_dir):
        return
    parent = shlex.quote(os.path.dirname(real_dir))
    script = (
        f"[ -d {parent} ] || exit 0; "
        f"find {parent} -mindepth 1 -maxdepth 1 -type d -mmin +2880 "
        "-regextype posix-extended -regex '.*/[A-Za-z0-9][A-Za-z0-9_-]{7,}' "
        "-exec rm -rf -- {} +"
    )
    try:
        _run(_ssh_base(host) + [script], timeout=120)
    except Exception as e:
        print(f"[gpu_workers] stale cleanup on {host} failed: {e}")


def _cleanup(host: str, session_dir: str) -> None:
    if not _truthy(os.getenv("GPU_WORKER_CLEANUP", "true")):
        return
    if not _is_session_path(session_dir):
        print(f"[gpu_workers] refusing to clean suspicious path {session_dir!r} on {host}")
        return
    try:
        _run(_ssh_base(host) + [f"rm -rf -- {shlex.quote(session_dir)}"], timeout=120)
    except Exception as e:  # cleanup must never fail a finished job
        print(f"[gpu_workers] cleanup on {host} failed: {e}")


def kill_remote(host: str, pid_file: str) -> None:
    """SIGTERM the remote process group, SIGKILL if still alive after 5 s.

    Best-effort and idempotent: a group that is already gone returns at once.
    Waits up to 10 s for the pid file, so a cancel that races the remote
    start still finds the process.
    """
    pf = shlex.quote(pid_file)
    script = (
        f"for i in $(seq 20); do [ -s {pf} ] && break; sleep 0.5; done; "
        f"pid=$(cat {pf} 2>/dev/null) || exit 0; [ -n \"$pid\" ] || exit 0; "
        "kill -TERM -- -$pid 2>/dev/null || exit 0; "
        "for i in $(seq 10); do kill -0 -- -$pid 2>/dev/null || exit 0; sleep 0.5; done; "
        "kill -KILL -- -$pid 2>/dev/null; true"
    )
    try:
        _run(_ssh_base(host) + [script], timeout=40)
    except Exception as e:
        print(f"[gpu_workers] remote kill on {host} failed: {e}")


def _never_cancelled() -> bool:
    return False


def run_on_worker(host: str, cmd: str, session_dir: str, cwd: str | None, popen,
                  cancelled=_never_cancelled) -> subprocess.CompletedProcess:
    """Run one command on one worker.

    Raises WorkerUnavailable for problems before or instead of a model run
    (the caller may try elsewhere), WorkerCancelled on user cancel, and
    RemoteResultLost if the model finished but its results could not be fetched.

    popen: callable(argv) -> Popen-like with communicate()/returncode, used so the
    caller can register the SSH process for per-session cancel.
    """
    raw_dir = session_dir.rstrip("/")
    real_dir = os.path.realpath(raw_dir)
    pid_file = os.path.join(real_dir, f".remote_pid_{uuid.uuid4().hex[:8]}")
    if not cwd:
        try:
            cwd = os.getcwd()  # same working directory as the web process
        except OSError:
            cwd = "/"

    def _check_cancel():
        if cancelled():
            raise WorkerCancelled("cancelled before the remote model started")

    _check_cancel()
    # Before the try: a refused (shared-filesystem) worker must never reach
    # _cleanup, which would delete the live session through the share.
    if _shares_session_filesystem(host, real_dir):
        raise WorkerUnavailable(f"{host}: shares the web host's session filesystem")
    try:
        _sync_to(host, raw_dir, real_dir)
        _check_cancel()
        _preflight(host, cmd, (raw_dir, real_dir), cwd)
        _check_cancel()
        remote = build_remote_command(cmd, cwd, pid_file)
        started = time.time()
        proc = popen(_ssh_base(host) + [remote])
        proc.kill_remote = lambda: kill_remote(host, pid_file)
        max_run = _env_float("GPU_WORKER_MAX_RUN_SECONDS", 3600)
        try:
            # A hung worker (e.g. a GB10 unified-memory stall with sshd still
            # alive) must not hold the GPU queue forever.
            stdout, stderr = proc.communicate(timeout=max_run)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            kill_remote(host, pid_file)
            if cancelled():
                raise WorkerCancelled(f"{host}: cancelled during the remote run")
            raise RemoteModelFailed(host, f"no result after {max_run:.0f}s; killed")
        rc = proc.returncode
        if cancelled():
            kill_remote(host, pid_file)  # leave nothing on the worker's GPU
            raise WorkerCancelled(f"{host}: cancelled during the remote run")
        if rc < 0:
            # Local ssh killed by a signal without a cancel (e.g. OOM killer):
            # stop the remote side and fail like a signalled local run. No
            # fallback: this host is the one under pressure.
            kill_remote(host, pid_file)
            return subprocess.CompletedProcess(cmd, rc, stdout, stderr)
        if rc == _SSH_CONNECTION_ERROR:
            # ssh lost the connection (e.g. the worker rebooted). Kill any
            # orphan in case the host is still up, then let the caller retry.
            # (A model that itself exits 255 is treated the same way.)
            kill_remote(host, pid_file)
            raise WorkerUnavailable(f"{host}: connection lost after {time.time() - started:.0f}s")
        if rc in _NOT_RUNNABLE:
            raise WorkerUnavailable(f"{host}: command not runnable (exit {rc})")
        if rc != 0:
            # Could be bad input or a broken worker (env drift, driver, GPU
            # fault, OOM kill); the local re-run tells which. Nothing is copied back.
            out = "\n".join(o for o in (stderr, stdout) if isinstance(o, str) and o)
            tail = out[-2000:]
            raise RemoteModelFailed(
                host, f"model exited {rc}{': ' + tail if tail else ''}",
                returncode=rc, output=tail, retry_locally=not _is_out_of_memory(out))
        _sync_back(host, real_dir, cancelled=cancelled)
    finally:
        _cleanup(host, real_dir)
    return subprocess.CompletedProcess(cmd, rc, stdout, stderr)


def run(cmd: str, session_dir: str, cwd: str | None, popen,
        cancelled=_never_cancelled) -> subprocess.CompletedProcess:
    """Try each healthy worker once; raise WorkerUnavailable if none could run it.

    WorkerCancelled and RemoteRunFailed propagate unchanged: a cancel is never
    re-run, and a started-but-failed run goes straight to the local re-run.
    """
    tried = []
    while True:
        if cancelled():
            raise WorkerCancelled("cancelled before dispatch")
        host = acquire_host(exclude=tried, cancelled=cancelled)
        if host is None:
            raise WorkerUnavailable(f"no idle GPU worker (tried: {tried or 'none idle'})")
        tried.append(host)
        try:
            print(f"[gpu_workers] running on {host}")
            result = run_on_worker(host, cmd, session_dir, cwd, popen, cancelled)
            result.host = host  # which worker ran it, for the job record
            return result
        except WorkerUnavailable as e:
            mark_failed(host)
            print(f"[gpu_workers] {e}; skipping {host} for a while, trying next worker")
        except (subprocess.TimeoutExpired, OSError) as e:
            mark_failed(host)
            print(f"[gpu_workers] {host}: {e}; skipping it for a while, trying next worker")
        finally:
            release_host(host)
