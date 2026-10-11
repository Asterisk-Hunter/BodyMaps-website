"""deploy/deploy.sh: the parts added for safe deploys, run for real against a throwaway git repo.

* one deploy at a time (and never under the watchdog's restart): the deploy lock;
* a restart ends running inference jobs, so the script waits for them and refuses to restart over them;
* a backend that predates /api/health cannot report jobs: the script says so and carries on;
* when the restart fails it prints how to go back to the previous version.

Everything the script calls (npm, pip, alembic, the start script, curl) is a stub; git and flock are real.
"""
import fcntl
import os
import shutil
import subprocess

import pytest

DEPLOY_SH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "deploy.sh"))

pytestmark = pytest.mark.skipif(
    os.name != "posix" or not shutil.which("bash") or not shutil.which("flock") or not shutil.which("git"),
    reason="needs bash, flock and git (Linux)",
)

STUB_OK = "#!/bin/bash\nexit 0\n"
START_STUB = '#!/bin/bash\necho "$@ start" >> "$FAKE_START_LOG"\nexit "${FAKE_START_RC:-0}"\n'
CURL_STUB = r"""#!/bin/bash
url=""; for a in "$@"; do url="$a"; done
case "$url" in
  */api/health) if [ "${FAKE_HEALTH:-}" = "old" ]; then exit 22; fi
                printf '{"status":"ok","inference":{"active":%s}}' "${FAKE_ACTIVE:-0}";;
  *) exit 22;;
esac
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

    def run(**extra):
        env = {
            "PATH": f"{pathbin}:{os.environ['PATH']}", "HOME": str(tmp_path),
            "BODYMAPS_REPO": str(repo), "BODYMAPS_CONDA_BIN": str(bin_conda),
            "BODYMAPS_PORT": "18999", "BODYMAPS_DEPLOY_LOCK": str(r.lock),
            "BODYMAPS_WAIT_FOR_JOBS": "0", "FAKE_START_LOG": str(r.start_log),
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
               "BODYMAPS_DEPLOY_LOCK": str(rig.lock)}
        res = subprocess.run(["bash", DEPLOY_SH, "check"], env=env, capture_output=True, text=True, timeout=60)
    assert res.returncode == 0 and "check mode" in res.stdout
