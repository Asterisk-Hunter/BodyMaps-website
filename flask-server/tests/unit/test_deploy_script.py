"""deploy/deploy.sh: the parts added for safe deploys, run for real against a throwaway git repo.

* one deploy at a time (and never under the watchdog's restart): the deploy lock;
* a restart ends running inference jobs, so the script waits for them and refuses to restart over them;
* a backend that predates /api/health cannot report jobs: the script says so and carries on;
* when the restart fails it prints how to go back to the previous version.

Everything the script calls (npm, pip, alembic, the start script, curl) is a stub; git and flock are real.
"""
import base64
import os
import shutil
import sqlite3
import subprocess

import pytest

fcntl = pytest.importorskip("fcntl", reason="deploy regression requires Linux flock")

DEPLOY_SH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "deploy.sh"))

pytestmark = pytest.mark.skipif(
    os.name != "posix" or not shutil.which("bash") or not shutil.which("flock") or not shutil.which("git"),
    reason="needs bash, flock and git (Linux)",
)

STUB_OK = "#!/bin/bash\nexit 0\n"
START_STUB = '#!/bin/bash\necho "$@ start" >> "$FAKE_START_LOG"\nexit "${FAKE_START_RC:-0}"\n'
CURL_STUB = r"""#!/bin/bash
url=""; out=""; status=0; cookie=0; jar=""; method=GET; websocket_nonce=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) status=1; shift 2;;
    -b) cookie=1; shift 2;;
    -c) jar="$2"; shift 2;;
    -X) method="$2"; shift 2;;
    -H) case "$2" in 'Sec-WebSocket-Key: '*) websocket_nonce="${2#Sec-WebSocket-Key: }";; esac; shift 2;;
    -m|-d) shift 2;;
    -I) method=HEAD; shift;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
printf '%s %s auth=%s\n' "$method" "${url#http://}" "$cookie" >> "$FAKE_CURL_LOG"
code=200; body='{}'
case "$url" in
  */api/health)
    code="${FAKE_HEALTH_CODE:-200}"
    [ "${FAKE_HEALTH:-}" = old ] && code=404
    body=$(printf '{"status":"ok","inference":{"active":%s}}' "${FAKE_ACTIVE:-0}")
    [ "${FAKE_HEALTH:-}" = malformed ] && body='{}';;
  */health) body='{"status":"ok"}';;
  */ws/live-rooms/*) code="${FAKE_WS_GUEST_CODE:-401}"; printf '%s\n' "$websocket_nonce" >> "$FAKE_WS_NONCE_LOG";;
  */api/ping) body='{"message":"pong"}';;
  */api/search*) if [ "$cookie" = 1 ]; then body='{"items":[]}'
                else code="${FAKE_GUEST_SEARCH_CODE:-401}"; fi;;
  */api/get-segmentations/*) if [ "$cookie" = 1 ]; then code="${FAKE_SEG_CODE:-200}"
                else code=401; fi;;
  */api/upload-inference-chunk) code=401;;
  */api/auth/register) code="${FAKE_REGISTER_CODE:-201}"; [ -z "$jar" ] || printf 'synthetic-cookie' > "$jar";;
  */api/me/usage) body='{"plan":"free","limits":{"daily_scans":1}}';;
  */api/auth/logout) body='{"ok":true}';;
  *) code=404;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ "$status" = 0 ] || printf '%s' "$code"
exit 0
"""
LIVE_HOOK_STUB = r"""#!/bin/bash
echo "$1" >> "$FAKE_LIVE_LOG"
[ "$1" != "${FAKE_LIVE_FAIL:-none}" ]
"""


def sh(cmd, cwd, env=None):
    return subprocess.run(cmd, cwd=cwd, shell=True, check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", **(env or {})})


@pytest.fixture()
def rig(tmp_path):
    bare, repo = tmp_path / "origin.git", tmp_path / "repo"
    sh(f"git init -q --bare {bare}", tmp_path)
    sh(f"git clone -q {bare} {repo}", tmp_path)
    (repo / "flask-server" / "deploy").mkdir(parents=True)
    (repo / "PanTS-Demo").mkdir()
    (repo / "flask-server" / "requirements.txt").write_text("")
    start = repo / "flask-server" / "deploy" / "start_backend.sh"
    start.write_text(START_STUB)
    start.chmod(0o755)
    sh("git checkout -q -b main && git add -A && git commit -q -m one && git push -q -u origin main", repo)
    old_sha = sh("git rev-parse --short HEAD", repo).stdout.strip()
    # a newer commit on origin so the deploy has something to pull
    other = tmp_path / "other"
    sh(f"git clone -q -b main {bare} {other}", tmp_path)
    (other / "flask-server" / "new.txt").write_text("x")
    sh("git add -A && git commit -q -m two && git push -q origin main", other)

    bin_conda = tmp_path / "conda_bin"
    bin_conda.mkdir()
    for name in ("gunicorn", "pip", "alembic"):
        (bin_conda / name).write_text(STUB_OK)
        (bin_conda / name).chmod(0o755)
    (bin_conda / "python").symlink_to(shutil.which("python3") or shutil.which("python"))
    pathbin = tmp_path / "pathbin"
    pathbin.mkdir()
    (pathbin / "npm").write_text(STUB_OK)
    (pathbin / "curl").write_text(CURL_STUB)
    for p in (pathbin / "npm", pathbin / "curl"):
        p.chmod(0o755)

    class Rig:
        pass
    r = Rig()
    r.tmp, r.repo, r.old_sha = tmp_path, repo, old_sha
    r.lock = tmp_path / "deploy.lock"
    r.start_log = tmp_path / "start.log"
    r.live_log = tmp_path / "live.log"
    r.curl_log = tmp_path / "curl.log"
    r.ws_nonce_log = tmp_path / "websocket-nonces.log"
    r.live_hook = tmp_path / "live-hook"
    r.live_hook.write_text(LIVE_HOOK_STUB)
    r.live_hook.chmod(0o755)

    def run(**extra):
        env = {
            "PATH": f"{pathbin}:{os.environ['PATH']}", "HOME": str(tmp_path),
            "BODYMAPS_REPO": str(repo), "BODYMAPS_CONDA_BIN": str(bin_conda),
            "BODYMAPS_PORT": "18999", "BODYMAPS_DEPLOY_LOCK": str(r.lock),
            "BODYMAPS_WAIT_FOR_JOBS": "0", "FAKE_START_LOG": str(r.start_log),
            "BODYMAPS_LIVE_ROOMS_RESTART_HOOK": str(r.live_hook),
            "FAKE_LIVE_LOG": str(r.live_log), "FAKE_CURL_LOG": str(r.curl_log),
            "FAKE_WS_NONCE_LOG": str(r.ws_nonce_log),
        }
        env.update(extra)
        return subprocess.run(["bash", DEPLOY_SH], env=env, capture_output=True, text=True, timeout=120)

    r.run = run
    return r


def test_a_second_deploy_is_refused_while_one_holds_the_lock(rig):
    rig.lock.write_text("")
    with open(rig.lock, "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        res = rig.run()
    assert res.returncode == 1
    assert "holds" in res.stdout and "right now" in res.stdout
    assert not rig.start_log.exists()


def test_running_inference_jobs_block_the_restart(rig):
    res = rig.run(FAKE_ACTIVE="2")
    assert res.returncode == 1
    assert "2 inference job(s) are still running" in res.stdout and "Nothing was restarted" in res.stdout
    assert not rig.start_log.exists(), "the backend must not be restarted over running jobs"


def test_no_jobs_means_the_backend_is_restarted(rig):
    res = rig.run(FAKE_ACTIVE="0", FAKE_START_RC="1")        # fail at step 5 so the rest need no stubs
    assert "no inference jobs running" in res.stdout
    assert rig.start_log.exists(), "with no jobs the shared start script must be called"


def test_old_backend_without_health_endpoint_continues_with_a_note(rig):
    res = rig.run(FAKE_HEALTH="old", FAKE_START_RC="1")
    assert "predates /api/health" in res.stdout
    assert rig.start_log.exists()


def test_failed_restart_prints_how_to_go_back(rig):
    res = rig.run(FAKE_ACTIVE="0", FAKE_START_RC="1")
    assert res.returncode == 1
    assert "DEPLOY FAILED at: 5. restart the backend" in res.stdout
    assert f"git checkout --detach {rig.old_sha}" in res.stdout
    assert "start_backend.sh" in res.stdout


def test_the_deploy_pulls_main_before_it_restarts(rig):
    res = rig.run(FAKE_ACTIVE="0", FAKE_START_RC="1")
    assert f"main: {rig.old_sha} ->" in res.stdout


def test_check_mode_changes_nothing_and_takes_no_lock(rig):
    rig.lock.write_text("")
    with open(rig.lock, "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = {"PATH": f"{rig.tmp / 'pathbin'}:{os.environ['PATH']}", "HOME": str(rig.tmp),
               "BODYMAPS_REPO": str(rig.repo), "BODYMAPS_CONDA_BIN": str(rig.tmp / "conda_bin"),
               "BODYMAPS_DEPLOY_LOCK": str(rig.lock),
               "BODYMAPS_LIVE_ROOMS_RESTART_HOOK": str(rig.live_hook),
               "FAKE_LIVE_LOG": str(rig.live_log)}
        res = subprocess.run(["bash", DEPLOY_SH, "check"], env=env, capture_output=True, text=True, timeout=60)
    assert res.returncode == 0 and "check mode" in res.stdout


@pytest.mark.parametrize("code", ["401", "403", "500", "000"])
def test_unexpected_health_status_refuses_restart(rig, code):
    res = rig.run(FAKE_HEALTH_CODE=code)
    assert res.returncode == 1
    assert "cannot confirm the active job count" in res.stdout
    assert not rig.start_log.exists()


@pytest.mark.parametrize("value", ["-1", "true", '"0"'])
def test_invalid_job_count_refuses_restart(rig, value):
    res = rig.run(FAKE_ACTIVE=value)
    assert res.returncode == 1
    assert not rig.start_log.exists()


def test_missing_job_count_refuses_restart(rig):
    res = rig.run(FAKE_HEALTH="malformed")
    assert res.returncode == 1
    assert not rig.start_log.exists()


def test_degraded_health_still_blocks_restart_over_active_jobs(rig):
    res = rig.run(FAKE_HEALTH_CODE="503", FAKE_ACTIVE="2")
    assert res.returncode == 1
    assert "2 inference job(s) are still running" in res.stdout
    assert not rig.start_log.exists()


def test_missing_live_hook_stops_before_deploy_changes(rig):
    res = rig.run(BODYMAPS_LIVE_ROOMS_RESTART_HOOK="")
    assert res.returncode == 1
    assert "BODYMAPS_LIVE_ROOMS_RESTART_HOOK" in res.stdout
    assert not rig.start_log.exists()
    assert sh("git rev-parse --short HEAD", rig.repo).stdout.strip() == rig.old_sha


def test_live_restart_preflight_blocks_changes(rig):
    res = rig.run(FAKE_LIVE_FAIL="check")
    assert res.returncode == 1 and "preflight failed" in res.stdout
    assert not rig.start_log.exists()
    assert sh("git rev-parse --short HEAD", rig.repo).stdout.strip() == rig.old_sha


def test_backup_contains_committed_wal_data_before_migration(rig):
    database = rig.repo / "flask-server" / "accounts.db"
    with sqlite3.connect(database) as active:
        active.execute("PRAGMA journal_mode=WAL")
        active.execute("PRAGMA wal_autocheckpoint=0")
        active.execute("CREATE TABLE account (name TEXT)")
        active.execute("INSERT INTO account VALUES ('local-fixture')")
        active.commit()
        res = rig.run(FAKE_START_RC="1")
        backups = list(rig.tmp.glob("db-backup-*-accounts.db"))
        assert len(backups) == 1, res.stdout + res.stderr
        with sqlite3.connect(backups[0]) as saved:
            assert saved.execute("SELECT name FROM account").fetchall() == [("local-fixture",)]


def test_full_deploy_checks_guest_denial_and_authenticated_dataset(rig):
    res = rig.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "authenticated search ok" in res.stdout
    assert "authenticated segmentations ok" in res.stdout
    assert rig.live_log.read_text().splitlines() == ["check", "restart"]
    calls = rig.curl_log.read_text()
    assert "GET 127.0.0.1:18999/api/search auth=0" in calls
    assert "GET 127.0.0.1:18999/api/search?limit=1 auth=1" in calls
    assert "HEAD 127.0.0.1:18999/api/get-segmentations/17.nii.gz auth=1" in calls
    assert "POST 127.0.0.1:18999/api/auth/logout auth=1" in calls


def test_live_handshake_uses_a_fresh_valid_nonce_for_each_deploy(rig):
    for _ in range(2):
        result = rig.run()
        assert result.returncode == 0, result.stdout + result.stderr
    nonces = [base64.b64decode(value, validate=True) for value in rig.ws_nonce_log.read_text().splitlines()]
    assert len(nonces) == 2
    assert all(len(value) == 16 for value in nonces)
    assert len(set(nonces)) == 2


@pytest.mark.parametrize("override", [
    {"FAKE_WS_GUEST_CODE": "101"}, {"FAKE_GUEST_SEARCH_CODE": "200"},
    {"FAKE_REGISTER_CODE": "500"}, {"FAKE_SEG_CODE": "401"},
    {"FAKE_LIVE_FAIL": "restart"},
])
def test_deploy_never_reports_success_for_failed_access_checks(rig, override):
    res = rig.run(**override)
    assert res.returncode == 1
    assert "DEPLOY OK" not in res.stdout
