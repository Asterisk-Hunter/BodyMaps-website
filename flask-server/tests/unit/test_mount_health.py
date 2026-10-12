"""Dataset-mount monitor (services/mount_health.py).

The outage this guards against: the NFS server behind the dataset mount stops answering, every
read parks a gunicorn thread forever, and within seconds the whole site is dead. The monitor
keeps a cached verdict so dataset routes can answer 503 at once instead.

All timing here is driven by fake probes and a fake clock; nothing waits on a real mount.
"""
import os
import threading
import time

import pytest

from services import mount_health as mh


class FakeClock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def make(paths=("/data/a",), probe=None, **kw):
    clock = kw.pop("clock", FakeClock())
    kw.setdefault("probe_timeout", 0.2)
    kw.setdefault("fail_threshold", 2)
    return mh.MountMonitor(paths, probe=probe or (lambda p: True), clock=clock, **kw), clock


# ------------------------------------------------------------------ verdict logic
def test_healthy_mount_stays_ok():
    mon, _ = make()
    for _ in range(3):
        assert mon.check_once() is True
    assert mon.is_ok() and mon.snapshot()["consecutive_failures"] == 0


def test_one_failure_is_not_an_outage_two_are():
    answers = iter([True, False, False, True])
    mon, clock = make(probe=lambda p: next(answers))
    assert mon.check_once() is True           # healthy
    assert mon.check_once() is True           # one bad answer: a slow server, not a dead one
    clock.t += 10
    assert mon.check_once() is False          # second in a row: down
    assert not mon.is_ok()
    assert mon.snapshot()["down_for_s"] == 0.0
    clock.t += 7
    assert mon.snapshot()["down_for_s"] == 7.0
    assert mon.check_once() is True           # answers again: recovered at once
    assert mon.is_ok() and mon.snapshot()["down_for_s"] is None


def test_hung_probe_counts_as_failure_and_is_not_stacked():
    release = threading.Event()
    started = []

    def hang(path):
        started.append(path)
        release.wait(5)                        # a read parked on a dead mount
        return True

    mon, _ = make(probe=hang, probe_timeout=0.05)
    assert mon.check_once() is True            # first timeout: failure 1 of 2
    assert mon.check_once() is False           # second: down, WITHOUT starting a second probe thread
    assert len(started) == 1, "a stuck probe must not be joined by more probe threads"
    assert not mon.is_ok()
    release.set()                              # the mount comes back; the stuck probe finally returns
    deadline = time.time() + 2
    while time.time() < deadline and mon._inflight.is_alive():
        time.sleep(0.01)
    assert mon.check_once() is True and mon.is_ok()
    assert len(started) == 2


def test_probe_exception_is_a_failure_not_a_crash():
    def boom(path):
        raise OSError(5, "Input/output error")

    mon, _ = make(probe=boom)
    mon.check_once()
    assert mon.check_once() is False


def test_folder_that_answered_then_vanished_is_an_outage():
    state = {"up": True}
    mon, _ = make(probe=lambda p: state["up"])
    assert mon.check_once() is True            # seen answering
    state["up"] = False                        # unmounted / gone
    mon.check_once()
    assert mon.check_once() is False


def test_never_seen_path_alone_does_not_trip_the_guard():
    mon, _ = make(paths=("/data/absent",), probe=lambda p: False)
    for _ in range(5):
        assert mon.check_once() is True
    assert mon.is_ok()


def test_all_paths_are_probed_and_one_bad_one_is_enough():
    state = {"/data/a": True, "/data/b": True}
    mon, _ = make(paths=("/data/a", "/data/b"), probe=lambda p: state[p])
    assert mon.check_once() is True
    state["/data/b"] = False
    mon.check_once()
    assert mon.check_once() is False


def test_duplicate_and_blank_paths_are_dropped():
    mon, _ = make(paths=("/x", "/x", "", "  ", "/y"))
    assert mon.paths == ["/x", "/y"]


def test_no_paths_means_disabled_and_always_ok():
    mon, _ = make(paths=())
    assert not mon.enabled and mon.check_once() is True and mon.is_ok()
    mon.start()                                 # must not spawn anything
    assert mon._thread is None


def test_snapshot_does_not_leak_filesystem_paths():
    mon, _ = make(paths=("/mnt/bodymaps/secret/data",))
    mon.check_once()
    assert "bodymaps" not in repr(mon.snapshot())


def test_background_loop_updates_the_verdict_and_stops():
    state = {"up": True}
    mon, _ = make(probe=lambda p: state["up"], interval=0.02, probe_timeout=0.1)
    mon.check_once()
    mon.start()
    state["up"] = False
    deadline = time.time() + 3
    while time.time() < deadline and mon.is_ok():
        time.sleep(0.02)
    assert not mon.is_ok(), "the loop must notice the outage on its own"
    mon.stop()
    state["up"] = True


# --------------------------------------------------------------- the real probe
def test_default_probe_on_a_real_folder_and_a_missing_one(tmp_path):
    assert mh.default_probe(str(tmp_path)) is True
    assert mh.default_probe(str(tmp_path / "nope")) is False       # folder itself absent
    f = tmp_path / "file.txt"
    f.write_text("x")
    assert mh.default_probe(str(f)) is False                       # a file is not a dataset folder


# ------------------------------------------------------------- the route decorator
def _app():
    flask = pytest.importorskip("flask")
    app = flask.Flask(__name__)

    @app.route("/needs-data")
    @mh.requires_dataset_mount
    def needs_data():
        return flask.jsonify(served=True)

    @app.route("/no-data")
    def no_data():
        return flask.jsonify(served=True)

    return app


def test_decorator_serves_when_ok_and_503s_fast_when_down():
    app = _app()
    mon, _ = make(probe=lambda p: True)
    mh.reset_for_tests(mon)
    try:
        client = app.test_client()
        assert client.get("/needs-data").status_code == 200
        mon._down = True
        t0 = time.time()
        resp = client.get("/needs-data")
        assert resp.status_code == 503
        assert time.time() - t0 < 0.5
        assert resp.headers["Retry-After"] == str(mh.RETRY_AFTER_SECONDS)
        assert resp.headers["Cache-Control"] == "no-store"
        assert resp.get_json()["error"] == "dataset_storage_unavailable"
        assert client.get("/no-data").status_code == 200          # routes without the gate keep working
    finally:
        mh.reset_for_tests(None)


def test_decorator_never_runs_the_view_while_down():
    flask = pytest.importorskip("flask")
    app = flask.Flask(__name__)
    calls = []

    @app.route("/x")
    @mh.requires_dataset_mount
    def x():
        calls.append(1)
        return "ok"

    mon, _ = make()
    mon._down = True
    mh.reset_for_tests(mon)
    try:
        assert app.test_client().get("/x").status_code == 503
        assert calls == []
        assert getattr(x, "requires_dataset_mount", False) is True
    finally:
        mh.reset_for_tests(None)


def test_decorator_supports_async_views():
    """Two real routes (get-segmentations, get-specific-segmentations) are `async def`; a plain
    wrapper would hand Flask a coroutine object instead of a response."""
    flask = pytest.importorskip("flask")
    pytest.importorskip("asgiref")      # Flask runs async views through asgiref
    app = flask.Flask(__name__)

    @app.route("/a")
    @mh.requires_dataset_mount
    async def a():
        return flask.jsonify(served=True)

    mon, _ = make()
    mh.reset_for_tests(mon)
    try:
        client = app.test_client()
        assert client.get("/a").status_code == 200
        mon._down = True
        resp = client.get("/a")
        assert resp.status_code == 503 and resp.get_json()["error"] == "dataset_storage_unavailable"
    finally:
        mh.reset_for_tests(None)


def test_async_view_wrapper_is_still_a_coroutine_function_and_gates():
    """Needs no asgiref: the wrapper itself must stay async (Flask decides how to call a view by
    looking at it) and must short-circuit with the 503 without awaiting the real view."""
    import asyncio
    import inspect
    flask = pytest.importorskip("flask")
    calls = []

    async def real_view():
        calls.append(1)
        return "served"

    gated = mh.requires_dataset_mount(real_view)
    assert inspect.iscoroutinefunction(gated) and gated.requires_dataset_mount is True
    mon, _ = make()
    mh.reset_for_tests(mon)
    try:
        with flask.Flask(__name__).app_context():
            assert asyncio.run(gated()) == "served"
            mon._down = True
            resp = asyncio.run(gated())
        assert resp.status_code == 503 and calls == [1]
    finally:
        mh.reset_for_tests(None)


def test_mount_down_response_for_inline_checks():
    flask = pytest.importorskip("flask")
    mon, _ = make()
    mh.reset_for_tests(mon)
    try:
        assert mh.mount_down_response() is None
        mon._down = True
        with flask.Flask(__name__).app_context():
            resp = mh.mount_down_response()
        assert resp.status_code == 503
    finally:
        mh.reset_for_tests(None)


# ------------------------------------------------------------------ configuration
def test_env_configuration(monkeypatch):
    mh.reset_for_tests(None)
    monkeypatch.setenv("PANTS_PATH", "/a")
    monkeypatch.setenv("CANCERVERSE_PATH", "/b")
    monkeypatch.delenv("MOUNT_GUARD_PATHS", raising=False)
    monkeypatch.setenv("MOUNT_GUARD_TIMEOUT", "7")
    monkeypatch.setenv("MOUNT_GUARD_FAILS", "3")
    try:
        mon = mh.get_monitor()
        assert mon.paths == ["/a", "/b"] and mon.probe_timeout == 7.0 and mon.fail_threshold == 3
        mh.reset_for_tests(None)
        monkeypatch.setenv("MOUNT_GUARD", "0")
        assert mh.get_monitor().enabled is False
        mh.reset_for_tests(None)
        monkeypatch.setenv("MOUNT_GUARD", "1")
        monkeypatch.setenv("MOUNT_GUARD_PATHS", "/only")
        assert mh.get_monitor().paths == ["/only"]
        mh.reset_for_tests(None)
        monkeypatch.setenv("MOUNT_GUARD_TIMEOUT", "garbage")
        assert mh.get_monitor().probe_timeout == mh.DEFAULT_PROBE_TIMEOUT
    finally:
        mh.reset_for_tests(None)
