"""scripts/smoke_test_pull_queue.sh sends what the job routes accept.

Queuing a pull job (POST /api/jobs) needs a signed-in session and the worker token in
X-Worker-Token; the job status route takes either; the result download takes only a
session. curl is a stub that answers by those rules and logs what each call sent, so the
script is run for real without a server.
"""
import os
import shutil
import subprocess
import sys
import textwrap

import pytest

SCRIPT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "smoke_test_pull_queue.sh"))

pytestmark = pytest.mark.skipif(os.name != "posix" or not shutil.which("bash"), reason="needs bash")

CURL_STUB = textwrap.dedent(f"""\
    #!{sys.executable}
    import json, os, sys
    args = sys.argv[1:]
    out = write_code = cookie = token = None
    url = ""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-o", "-w", "-b", "-H", "-F", "-X"):
            value = args[i + 1]
            if arg == "-o":
                out = value
            elif arg == "-w":
                write_code = value
            elif arg == "-b":
                cookie = value
            elif arg == "-H" and value.startswith("X-Worker-Token: "):
                token = value[len("X-Worker-Token: "):]
            i += 2
            continue
        if not arg.startswith("-"):
            url = arg
        i += 1
    signed_in = cookie == os.environ["EXPECT_COOKIE"]
    worker = token == os.environ["EXPECT_TOKEN"]
    with open(os.environ["CURL_LOG"], "a") as log:
        log.write(json.dumps({{"url": url, "cookie": cookie, "token": token}}) + "\\n")
    if url.endswith("/api/jobs"):
        code, body = (201, {{"job_id": "job-1"}}) if signed_in and worker else (401, {{"error": "refused"}})
        body = json.dumps(body).encode()
    elif url.endswith("/download"):
        code, body = (200, b"PK zip") if signed_in else (401, b"")
    else:
        status = "succeeded" if signed_in or worker else ""
        code, body = 200, json.dumps({{"status": status}}).encode()
    with open(out, "wb") as stream:
        stream.write(body)
    if write_code:
        sys.stdout.write(str(code))
    """)


@pytest.fixture
def run(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "curl"
    stub.write_text(CURL_STUB)
    stub.chmod(0o755)
    # The script parses JSON with `python`; make that this interpreter.
    os.symlink(sys.executable, bin_dir / "python")
    ct = tmp_path / "ct.nii.gz"
    ct.write_bytes(b"ct")
    log = tmp_path / "curl.log"

    def _run(**overrides):
        env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "INPUT_PATH": str(ct),
            "OUTPUT_DIR": str(tmp_path / "out"),
            "API_BASE": "http://server-a",
            "POLL_SECONDS": "0",
            "SESSION_COOKIE": "bm_session=signed-in",
            "WORKER_API_TOKEN": "worker-secret",
            "EXPECT_COOKIE": "bm_session=signed-in",
            "EXPECT_TOKEN": "worker-secret",
            "CURL_LOG": str(log),
        }
        env.update(overrides)
        env = {key: value for key, value in env.items() if value is not None}
        result = subprocess.run(["bash", SCRIPT], env=env, capture_output=True, text=True, timeout=60)
        calls = []
        if log.exists():
            import json
            calls = [json.loads(line) for line in log.read_text().splitlines()]
        return result, calls

    return _run


def test_the_smoke_test_queues_polls_and_downloads_a_job(run, tmp_path):
    result, calls = run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert [call["url"].rsplit("/api/", 1)[1] for call in calls] == ["jobs", "jobs/job-1", "jobs/job-1/download"]
    create, status, download = calls
    assert (create["cookie"], create["token"]) == ("bm_session=signed-in", "worker-secret")
    assert status["cookie"] == "bm_session=signed-in"
    assert download["cookie"] == "bm_session=signed-in"
    # The worker secret goes only where it is required.
    assert status["token"] is None and download["token"] is None
    assert (tmp_path / "out" / "job-1_auto_masks.zip").read_bytes() == b"PK zip"


@pytest.mark.parametrize("missing", ["SESSION_COOKIE", "WORKER_API_TOKEN"])
def test_the_smoke_test_stops_before_any_request_without_both_credentials(run, missing):
    result, calls = run(**{missing: None})

    assert result.returncode == 1
    assert f"{missing} is required" in result.stdout
    assert calls == []
