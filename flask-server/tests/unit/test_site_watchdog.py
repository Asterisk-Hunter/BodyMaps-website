"""deploy/site_watchdog.sh and deploy/start_backend.sh, run for real against stub curl/start commands.

What must hold: a hung dataset mount produces an alert and NEVER a restart (a restart cannot fix it
and ends running inference jobs); a backend that stops answering while the mount is fine is
restarted after several bad minutes, at most once per cooldown and a few times a day; a running
deploy is never interfered with; the shared start script stops only the gunicorn on its own port.
"""
import json
import os
import shutil
import subprocess
import time

import pytest

DEPLOY = os.path.join(os.path.dirname(__file__), "..", "..", "deploy")
WATCHDOG = os.path.abspath(os.path.join(DEPLOY, "site_watchdog.sh"))
START = os.path.abspath(os.path.join(DEPLOY, "start_backend.sh"))

pytestmark = pytest.mark.skipif(
    os.name != "posix" or not shutil.which("bash") or not shutil.which("flock"),
    reason="needs bash and flock (Linux)",
)

CURL_STUB = r"""#!/bin/bash
# stub curl: answers /api/health, /api/ping and webhook POSTs from environment variables
out=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -d) data="$2"; shift 2;;
    -m|-w|-H|-X) shift 2;;
    -s|-f|-sf|-sS) shift;;
    *) url="$1"; shift;;
  esac
done
case "$url" in
  */api/health) [ -n "$out" ] && printf '%s' "${FAKE_HEALTH_BODY:-}" > "$out"; printf '%s' "${FAKE_HEALTH_CODE:-000}";;
  */api/ping)   [ -n "$out" ] && printf '%s' '{"message":"pong"}' > "$out"; printf '%s' "${FAKE_PING_CODE:-000}";;
  *) printf '%s\n' "$data" >> "$FAKE_WEBHOOK_LOG"; printf '200';;
esac
exit 0
"""

START_STUB = """#!/bin/bash
echo "restart" >> "$FAKE_START_LOG"
exit "${FAKE_START_RC:-0}"
"""

OK_BODY = '{"status":"ok","mount":{"ok":true},"inference":{"active":0}}'
DEGRADED_BODY = '{"status":"degraded","mount":{"ok":false},"inference":{"active":0}}'


class Env:
    def __init__(self, tmp_path):
        self.dir = tmp_path
        self.state = tmp_path / "state"
        self.curl = tmp_path / "curl"
        self.start = tmp_path / "start.sh"
        self.curl.write_text(CURL_STUB)
        self.start.write_text(START_STUB)
        for p in (self.curl, self.start):
            p.chmod(0o755)
        self.start_log = tmp_path / "start.log"
        self.hook_log = tmp_path / "hook.log"
        self.lock = tmp_path / "deploy.lock"
        self.now = 1_700_000_000

    def run(self, health=("000", ""), ping="000", mount_ok=True, advance=60, **extra):
        self.now += advance
        env = {
            "PATH": os.environ["PATH"], "HOME": str(self.dir),
            "WATCHDOG_ENV_FILE": str(self.dir / "none.env"),
            "WATCHDOG_STATE_DIR": str(self.state),
            "BODYMAPS_DEPLOY_LOCK": str(self.lock),
            "WATCHDOG_CURL": str(self.curl),
            "WATCHDOG_START_CMD": str(self.start),
            "WATCHDOG_MOUNT_PROBE_CMD": "true" if mount_ok else "false",
            "WATCHDOG_NOW": str(self.now),
            "BODYMAPS_ALERT_WEBHOOK": "http://hook.invalid/x",
            "FAKE_HEALTH_CODE": health[0], "FAKE_HEALTH_BODY": health[1], "FAKE_PING_CODE": ping,
            "FAKE_WEBHOOK_LOG": str(self.hook_log), "FAKE_START_LOG": str(self.start_log),
        }
        env.update(extra)
        r = subprocess.run(["bash", WATCHDOG], env=env, capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        return r

    @property
    def restarts(self):
        return len(self.start_log.read_text().split()) if self.start_log.exists() else 0

    @property
    def alerts(self):
        if not self.hook_log.exists():
            return []
        return [json.loads(line)["text"] for line in self.hook_log.read_text().splitlines() if line.strip()]


@pytest.fixture()
def wd(tmp_path):
    return Env(tmp_path)


def dead(wd, n, **kw):
    for _ in range(n):
        wd.run(health=("000", ""), ping="000", **kw)


# ------------------------------------------------------------------------------- healthy / quiet
def test_healthy_site_does_nothing(wd):
    for _ in range(5):
        wd.run(health=("200", OK_BODY))
    assert wd.restarts == 0 and wd.alerts == []


@pytest.mark.parametrize("status", ["401", "403"])
def test_health_authentication_error_alerts_without_restarting(wd, status):
    for _ in range(8):
        wd.run(health=(status, '{"error":"Authentication required"}'))
    assert wd.restarts == 0
    assert len(wd.alerts) == 1 and "access/proxy" in wd.alerts[0]
    wd.run(health=("200", OK_BODY))
    assert any("site is back" in alert for alert in wd.alerts)


# ------------------------------------------------------------------- hung mount: alert, never restart
def test_degraded_site_alerts_once_and_never_restarts(wd):
    for _ in range(12):
        wd.run(health=("503", DEGRADED_BODY))
    assert wd.restarts == 0
    assert len(wd.alerts) == 1 and "storage" in wd.alerts[0].lower() and "restart would not help" in wd.alerts[0]


def test_dead_backend_with_a_hung_mount_is_not_restarted(wd):
    """Nothing answers because the mount hung: classified as a storage problem, not a backend one."""
    dead(wd, 10, mount_ok=False)
    assert wd.restarts == 0
    assert len(wd.alerts) == 1 and "storage" in wd.alerts[0].lower()


# --------------------------------------------------------------------- dead backend: restart, carefully
def test_dead_backend_is_restarted_only_after_several_bad_minutes(wd):
    dead(wd, 3)
    assert wd.restarts == 0, "three bad minutes is not enough"
    dead(wd, 1)
    assert wd.restarts == 1
    assert any("restarting" in a for a in wd.alerts) and any("restarted and answering" in a for a in wd.alerts)


def test_restart_cooldown_and_daily_cap(wd):
    dead(wd, 4)
    assert wd.restarts == 1
    dead(wd, 10)                                   # still bad (stub does not fix it), 10 more minutes
    assert wd.restarts == 1, "cooldown (30 min) must hold"
    # Past the cooldown a restart is allowed again once four more bad minutes have passed (each
    # successful restart resets the count), until the daily cap of 4 is reached.
    for i in range(20):
        wd.run(health=("000", ""), ping="000", advance=1900)
    assert wd.restarts == 4, "the daily cap is 4 restarts in 24 hours"
    assert sum("not restarting again" in a for a in wd.alerts) == 1, "the cap is announced once, not every minute"


def test_failed_restart_is_reported_and_not_retried_immediately(wd):
    dead(wd, 4, FAKE_START_RC="1")
    assert wd.restarts == 1 and any("restart FAILED" in a for a in wd.alerts)
    dead(wd, 3, FAKE_START_RC="1")
    assert wd.restarts == 1


def test_autorestart_off_only_alerts(wd):
    dead(wd, 8, WATCHDOG_AUTORESTART="0")
    assert wd.restarts == 0
    assert len(wd.alerts) == 1 and "automatic restart is off" in wd.alerts[0]


def test_recovery_is_announced_once(wd):
    dead(wd, 2)
    wd.run(health=("200", OK_BODY))
    wd.run(health=("200", OK_BODY))
    assert sum("site is back" in a for a in wd.alerts) == 1


# ------------------------------------------------------------------------------- older backends
def test_backend_without_health_endpoint_falls_back_to_ping(wd):
    wd.run(health=("404", ""), ping="200")
    assert wd.restarts == 0 and wd.alerts == []
    for _ in range(4):
        wd.run(health=("404", ""), ping="000")
    assert wd.restarts == 1


# --------------------------------------------------------------------------- never during a deploy
def test_a_running_deploy_is_never_interfered_with(wd):
    import fcntl
    wd.lock.write_text("")
    with open(wd.lock, "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)      # what deploy.sh holds while it runs
        dead(wd, 10)
        assert wd.restarts == 0
        assert not (wd.state / "fails").exists() or (wd.state / "fails").read_text() in ("", "0")
    # released: now it counts again
    dead(wd, 4)
    assert wd.restarts == 1


def test_restart_holds_the_deploy_lock_so_a_deploy_cannot_start_underneath(wd):
    """The restart command runs with the deploy lock held; prove it by trying to take it from inside."""
    probe = wd.dir / "start_probe.sh"
    probe.write_text("#!/bin/bash\nflock -n %s -c true && echo FREE >> %s || echo HELD >> %s\n"
                     % (wd.lock, wd.start_log, wd.start_log))
    probe.chmod(0o755)
    dead(wd, 4, WATCHDOG_START_CMD=str(probe))
    assert wd.start_log.read_text().split() == ["HELD"]


# -------------------------------------------------------------------------------------- the webhook
def test_alert_text_is_valid_json_even_with_quotes_in_it(wd):
    wd.run(health=("503", DEGRADED_BODY))
    for text in wd.alerts:
        assert '"' not in text and "\\" not in text and text.startswith("[BodyMaps]")


def test_no_webhook_means_log_only(wd):
    wd.run(health=("503", DEGRADED_BODY), BODYMAPS_ALERT_WEBHOOK="")
    assert not wd.hook_log.exists()
    assert "ALERT:" in (wd.state / "watchdog.log").read_text()


# ---------------------------------------------------------------------------------- start_backend.sh
@pytest.fixture()
def fake_backend(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    gun = bindir / "gunicorn"
    gun.write_text("#!/bin/bash\nsleep 30\n")                # a stand-in that stays alive (no exec: keeps its command line)
    gun.chmod(0o755)
    (tmp_path / "repo" / "flask-server").mkdir(parents=True)
    curl = tmp_path / "pathbin"
    curl.mkdir()
    (curl / "curl").write_text("#!/bin/bash\nexit 0\n")           # /api/ping answers
    (curl / "curl").chmod(0o755)
    return tmp_path


def _spawn_fake(tmp_path, port):
    """A process whose command line looks like a gunicorn bound to `port`."""
    script = tmp_path / "bin" / "gunicorn"
    return subprocess.Popen([str(script), "--worker-class", "gthread", "--bind", f"127.0.0.1:{port}",
                             "--timeout", "3600", "--chdir", "/x", "app:app"])


def _env(tmp_path, port, extra_path=""):
    return {
        "PATH": f"{tmp_path / 'pathbin'}:{extra_path}{os.environ['PATH']}",
        "BODYMAPS_REPO": str(tmp_path / "repo"), "BODYMAPS_CONDA_BIN": str(tmp_path / "bin"),
        "BODYMAPS_PORT": str(port), "BODYMAPS_GUNICORN_LOG": str(tmp_path / "g.log"),
        "BODYMAPS_START_WAIT": "2", "HOME": str(tmp_path),
    }


def test_start_backend_stops_only_the_gunicorn_on_its_own_port(fake_backend):
    mine = _spawn_fake(fake_backend, 18000)
    other = _spawn_fake(fake_backend, 18013)        # e.g. a recovery preview on another port
    try:
        time.sleep(0.3)
        r = subprocess.run(["bash", START], env=_env(fake_backend, 18000), capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        time.sleep(0.3)
        assert mine.poll() is not None, "the gunicorn on the live port must be stopped"
        assert other.poll() is None, "a gunicorn on another port must be left alone"
        assert "16 threads" in r.stdout
    finally:
        other.kill()
        subprocess.run(["pkill", "-f", str(fake_backend / "bin" / "gunicorn")], capture_output=True)


def test_start_backend_refuses_when_systemd_manages_the_service(fake_backend):
    sysd = fake_backend / "sysbin"
    sysd.mkdir()
    (sysd / "systemctl").write_text("#!/bin/bash\nexit 0\n")      # `is-active --quiet` succeeds
    (sysd / "systemctl").chmod(0o755)
    r = subprocess.run(["bash", START], env=_env(fake_backend, 18002, extra_path=f"{sysd}:"),
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 1 and "managed by systemd" in r.stderr


def test_start_backend_fails_loudly_when_the_backend_never_answers(fake_backend):
    (fake_backend / "pathbin" / "curl").write_text("#!/bin/bash\nexit 7\n")
    try:
        r = subprocess.run(["bash", START], env=_env(fake_backend, 18003), capture_output=True, text=True, timeout=60)
        assert r.returncode == 1 and "did not answer /api/ping" in r.stderr
    finally:
        subprocess.run(["pkill", "-f", str(fake_backend / "bin" / "gunicorn")], capture_output=True)


def test_a_started_backend_does_not_inherit_the_callers_lock(fake_backend):
    """flock locks belong to the open file. deploy.sh and the watchdog hold one while they call
    start_backend.sh; if the long-lived gunicorn inherited it, the lock would stay held for as long as
    the backend runs and every later deploy / watchdog run would be refused."""
    lock = fake_backend / "caller.lock"
    lock.write_text("")
    env = _env(fake_backend, 18004)
    # the caller: take the lock on fd 9 (as deploy.sh does), start the backend, and exit
    subprocess.run(["bash", "-c", f'( flock -n 9 || exit 99; bash "{START}" ) 9>>"{lock}"'],
                   env=env, capture_output=True, text=True, timeout=60, check=True)
    try:
        # the caller is gone but the stand-in gunicorn is still running: the lock must be free
        probe = subprocess.run(["flock", "-n", str(lock), "true"], capture_output=True, timeout=10)
        assert probe.returncode == 0, "the running backend inherited the caller's lock"
        assert subprocess.run(["pgrep", "-f", str(fake_backend / "bin" / "gunicorn")],
                              capture_output=True).returncode == 0, "the stand-in backend should still be running"
    finally:
        subprocess.run(["pkill", "-f", str(fake_backend / "bin" / "gunicorn")], capture_output=True)
