"""Tests for the second-opinion runner (services/user_dataset_models.py, scripts/user_dataset_second_opinions.py).

No GPU, no network, no website: every outside dependency is injected. The drift guards at the bottom read
auto_segmentor.py and gpu_workers.py, because the safety of this feature (never the web host's GPU, cancel on
activity) rests on how those behave.
"""
import hashlib
import http.server
import importlib
import json
import os
import sys
import threading
import types
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
nib = pytest.importorskip("nibabel")

import services.user_dataset as ud  # noqa: E402
import services.user_dataset_models as M  # noqa: E402

SERVER = Path(__file__).resolve().parents[2]
SHAPE = (16, 16, 16)
IDLE = {"inference": {"active": 0, "queued": 0, "running": 0}, "status": "ok"}


@pytest.fixture(autouse=True)
def small_volumes(monkeypatch):
    monkeypatch.setattr(ud, "MIN_ORGAN_VOXELS", 100)
    monkeypatch.setattr(ud, "MIN_DISTINCT_ORGANS", 2)


def _labels(*, liver=True, shape=SHAPE):
    vol = np.zeros(shape, "uint8")
    if liver:
        vol[2:10, 2:10, 4:12] = 14
        vol[10:14, 10:14, 4:12] = 17
    return vol


def make_case(root, case_id, model, *, sha=None):
    root = Path(root)
    (root / "image_only" / case_id).mkdir(parents=True, exist_ok=True)
    (root / "mask_only" / case_id).mkdir(parents=True, exist_ok=True)
    ct = np.full(SHAPE, -1000, "int16"); ct[3:13, 3:13, 3:13] = 60
    nib.save(nib.Nifti1Image(ct, np.eye(4)), str(root / "image_only" / case_id / "ct.nii.gz"))
    nib.save(nib.Nifti1Image(_labels(), np.eye(4)), str(root / "mask_only" / case_id / "combined_labels.nii.gz"))
    meta = {"case_id": case_id, "model": model, "shape": list(SHAPE), "spacing_mm": [1.0, 1.0, 1.0],
            "sha256": sha or hashlib.sha256(case_id.encode()).hexdigest(), "user_id": "u1", "session_id": "s1",
            "pipeline": {"segmentation_input": "original"}, "quality_tier": "high"}
    (root / "mask_only" / case_id / "metadata.json").write_text(json.dumps(meta))
    return meta


class Recorder:
    """Fake outside world with the same shape as Deps."""

    def __init__(self, root, *, health=IDLE, memory=100.0, workers=("bdmap2",), ran_on=("bdmap2",), fell_back=False):
        self.root = root
        self.health, self.memory, self.workers = health, memory, list(workers)
        self.ran_on, self.fell_back = list(ran_on), fell_back
        self.calls, self.cancelled_sids, self.sleeps = [], [], []
        self.clock = 1_000_000.0
        self.output_shape = SHAPE
        self.output = {"liver": True}
        self.run_model_impl = None
        self.cancel_event = threading.Event()

    # --- Deps surface
    def website_health(self):
        return self.health() if callable(self.health) else self.health

    def available_gb(self):
        return self.memory

    def free_workers(self):
        return list(self.workers)

    def run_model(self, input_path, session_dir, model, session_id, on_start):
        self.calls.append((model, session_id, input_path))
        assert os.path.isfile(input_path) and Path(session_dir) in Path(input_path).parents
        if self.run_model_impl:
            return self.run_model_impl(input_path, session_dir, model, session_id, on_start)
        if on_start() is False:
            return None
        out = Path(session_dir) / "outputs" / "ct"
        out.mkdir(parents=True)
        nib.save(nib.Nifti1Image(_labels(shape=self.output_shape, **self.output), np.eye(4)),
                 str(out / "combined_labels.nii.gz"))
        return str(out)

    def cancel(self, sid):
        self.cancelled_sids.append(sid)
        self.cancel_event.set()
        return True

    def pop_run_info(self, sid):
        return {"ran_on": self.ran_on, "fell_back": self.fell_back}

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    def now(self):
        return self.clock

    def deps(self):
        return M.Deps(website_health=self.website_health, available_gb=self.available_gb, free_workers=self.free_workers,
                      run_model=self.run_model, cancel=self.cancel, pop_run_info=self.pop_run_info,
                      local_hostname=lambda: "bdmap1", now=self.now, sleep=self.sleep)


@pytest.fixture()
def world(tmp_path):
    root = tmp_path / "UserData"
    sessions = tmp_path / "tmp"
    sessions.mkdir()
    return types.SimpleNamespace(root=str(root), sessions=str(sessions), rec=Recorder(str(root)),
                                 cfg=M.Config(idle_checks=2, check_interval=0, poll_seconds=0.02, max_run_seconds=30,
                                              loop_sleep=0, idle_sleep=0))


def run(world, **kw):
    return M.run_loop(world.root, world.cfg, world.rec.deps(), world.sessions, log=lambda *_: None, **kw)


def tree(path):
    return sorted(str(p.relative_to(path)) for p in Path(path).rglob("*") if p.is_file())


# ------------------------------------------------------------------ choosing the work
def test_pending_tasks_skip_the_users_own_model_finished_versions_and_backoff(world):
    make_case(world.root, "USER_00000001", "ePAI")
    make_case(world.root, "USER_00000002", "LesionSegmenter")
    state = M.load_state(world.root)
    tasks = M.pending_tasks(world.root, M.DEFAULT_MODELS, state, 1000.0)
    assert [(t.case_id, t.model) for t in tasks] == [
        ("USER_00000001", "Atlas-Net"), ("USER_00000001", "LesionSegmenter"),
        ("USER_00000002", "ePAI"), ("USER_00000002", "Atlas-Net")]
    assert all(t.model != t.origin for t in tasks)
    M.note_result(state, tasks[0], "failed", 1000.0, "boom")
    assert tasks[0].key not in {t.key for t in M.pending_tasks(world.root, M.DEFAULT_MODELS, state, 1001.0)}
    assert tasks[0].key in {t.key for t in M.pending_tasks(world.root, M.DEFAULT_MODELS, state, 1000.0 + 3601)}
    # a model the user ran that is not in the configured set still gets every configured model
    make_case(world.root, "USER_00000003", "SuPreM")
    assert len([t for t in M.pending_tasks(world.root, M.DEFAULT_MODELS, M.load_state(world.root), 0) if t.case_id == "USER_00000003"]) == 3


def test_failures_back_off_then_give_up_and_preemption_is_not_a_failure():
    task = M.Task("USER_00000001", "Atlas-Net", "ePAI")
    state = {"tasks": {}, "runs": []}
    M.note_result(state, task, "failed", 100.0, "x" * 500)
    e = state["tasks"][task.key]
    assert e["attempts"] == 1 and e["next_try"] == 100.0 + 3600 and e["status"] == "failed" and len(e["last_error"]) == 300
    M.note_result(state, task, "failed", 5000.0, "again")
    assert state["tasks"][task.key]["next_try"] == 5000.0 + 6 * 3600
    M.note_result(state, task, "failed", 90000.0, "third")
    assert state["tasks"][task.key]["status"] == "given_up"
    other = M.Task("USER_00000002", "ePAI", "Atlas-Net")
    M.note_result(state, other, "preempted", 100.0)
    assert state["tasks"][other.key].get("attempts", 0) == 0 and state["tasks"][other.key]["next_try"] == 160.0
    M.note_result(state, other, "ok", 200.0)
    assert other.key not in state["tasks"] and 200.0 in state["runs"]
    old = {"tasks": {}, "runs": [1.0]}
    M.note_result(old, other, "ok", 1.0 + 25 * 3600)
    assert old["runs"] == [1.0 + 25 * 3600]                         # runs older than a day are dropped


# ------------------------------------------------------------------ the idle gate
@pytest.mark.parametrize("health,expect_busy", [
    (None, True), ({}, True), ({"inference": "x"}, True), ({"inference": {"active": "many"}}, True),
    ({"inference": {"active": 1, "queued": 0, "running": 0}}, True),
    ({"inference": {"active": 0, "queued": 2, "running": 0}}, True),
    ({"inference": {"active": 0, "queued": 0, "running": 1}}, True),
    ({"inference": {"active": 0, "queued": 0, "running": 0}}, False)])
def test_website_gate_fails_closed(health, expect_busy):
    deps = Recorder("x", health=health).deps()
    assert (M.website_reason(deps) is not None) is expect_busy


def test_confirm_idle_needs_consecutive_idle_samples_memory_and_a_free_worker(world):
    cfg = M.Config(idle_checks=3, check_interval=7, min_available_gb=20)
    rec = Recorder("x")
    assert M.confirm_idle(rec.deps(), cfg) is None and rec.sleeps == [7, 7]          # 3 samples, 2 gaps
    samples = iter([IDLE, IDLE, {"inference": {"active": 1, "queued": 0, "running": 0}}])
    rec = Recorder("x", health=lambda: next(samples))
    assert "busy" in M.confirm_idle(rec.deps(), cfg)                                  # a user appears at the 3rd look
    assert "memory" in M.confirm_idle(Recorder("x", memory=5.0).deps(), cfg)
    assert "memory" in M.confirm_idle(Recorder("x", memory=None).deps(), cfg)
    asked = []
    rec = Recorder("x", workers=[])
    rec.free_workers = lambda: asked.append(1) or []
    assert M.confirm_idle(rec.deps(), cfg) == "no GPU worker is free" and len(asked) == 1   # SSH health once, at the end


def test_assert_safe_environment_refuses_everything_but_idle_workers():
    gw = lambda enabled=True, fallback=False, hosts=("bdmap2",): types.SimpleNamespace(
        enabled=lambda: enabled, local_fallback_allowed=lambda: fallback, hosts=lambda: list(hosts))
    M.assert_safe_environment(gw(), env={})
    for bad, env in ((gw(enabled=False), {}), (gw(fallback=True), {}), (gw(hosts=()), {}),
                     (gw(), {"EPAI_REMOTE_ENABLED": "true"})):
        with pytest.raises(M.UnsafeEnvironment):
            M.assert_safe_environment(bad, env=env)


def test_config_validates_model_names_and_paths_cannot_escape():
    assert M.Config.from_env({"SECOND_OPINIONS_MODELS": "ePAI, Atlas-Net"}).models == ("ePAI", "Atlas-Net")
    with pytest.raises(ValueError):
        M.Config.from_env({"SECOND_OPINIONS_MODELS": "ePAI,../../etc"})
    with pytest.raises(ValueError):
        M.version_dir("/r", "USER_00000001", "../x")
    assert M.Config.from_env({"SECOND_OPINIONS_IDLE_CHECKS": "zero"}).idle_checks == 3


def test_fetch_health_reads_200_503_and_unreachable():
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            code = 503 if self.server.down else 200
            body = json.dumps(IDLE).encode()
            self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), H); srv.down = False
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    try:
        assert M.fetch_health(base) == IDLE
        srv.down = True
        assert M.fetch_health(base) == IDLE                  # 503 (dataset mount down) still carries the report
    finally:
        srv.shutdown(); srv.server_close()
    assert M.fetch_health(base, timeout=1) is None            # nothing listening any more


# ------------------------------------------------------------------ one task
def test_a_finished_task_is_saved_beside_the_original_and_changes_nothing_else(world):
    make_case(world.root, "USER_00000001", "ePAI")
    before = {p: hashlib.sha256(Path(world.root, p).read_bytes()).hexdigest() for p in tree(world.root)
              if not p.endswith("metadata.json")}
    task = M.Task("USER_00000001", "LesionSegmenter", "ePAI")
    res = M.execute(task, world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "ok" and res.detail == "bdmap2"
    base = Path(world.root, "mask_only", "USER_00000001", "by_model", "LesionSegmenter")
    assert sorted(p.name for p in base.iterdir()) == ["combined_labels.nii.gz", "segmentations", "version.json"]
    assert {p.name for p in (base / "segmentations").iterdir()} == {"liver.nii.gz", "pancreas.nii.gz"}
    assert not (base.parent / "LesionSegmenter.partial").exists()
    v = json.loads((base / "version.json").read_text())
    assert (v["status"], v["role"], v["model"], v["user_ran_model"]) == ("ok", "second_opinion", "LesionSegmenter", "ePAI")
    assert v["executor"] == {"ran_on": ["bdmap2"], "fell_back_to_web_host": False}
    assert v["input"]["pipeline"] == {"segmentation_input": "original", "preprocessing": None, "postprocessing": None}
    assert v["input"]["sha256"] == hashlib.sha256(b"USER_00000001").hexdigest()
    assert v["provenance"]["model"] == "LesionSegmenter" and v["label_support"]["known"] is True
    assert v["segmentation_ok"] is True and "liver" in v["organ_volumes_ml"]
    meta = json.loads(Path(world.root, "mask_only", "USER_00000001", "metadata.json").read_text())
    assert [(x["model"], x["role"], x["mask"]) for x in meta["model_versions"]] == [
        ("ePAI", "user_run", "."), ("LesionSegmenter", "second_opinion", "by_model/LesionSegmenter")]
    assert meta["user_id"] == "u1" and meta["quality_tier"] == "high"             # the rest of the case is untouched
    after = {p: hashlib.sha256(Path(world.root, p).read_bytes()).hexdigest() for p in before}
    assert before == after                                                         # CT, original mask, all unchanged
    assert os.listdir(world.sessions) == []                                       # the temporary session folder is gone
    model, sid, input_path = world.rec.calls[0]
    assert sid.startswith("so-USER_00000001-LesionSegmenter-") and input_path.endswith("USER_00000001.nii.gz")


def test_an_empty_result_is_still_saved_and_says_so(world):
    make_case(world.root, "USER_00000001", "ePAI")
    world.rec.output = {"liver": False}
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "ok"
    v = json.loads(Path(world.root, "mask_only", "USER_00000001", "by_model", "Atlas-Net", "version.json").read_text())
    assert v["segmentation_ok"] is False and v["segmentation_note"].startswith("too_few_organ_voxels")


def test_a_user_job_appearing_cancels_the_run_and_requeues_it(world):
    make_case(world.root, "USER_00000001", "ePAI")
    rec = world.rec

    def blocking(input_path, session_dir, model, sid, on_start):
        assert on_start() is True                                    # idle when the model is dispatched ...
        rec.health = {"inference": {"active": 1, "queued": 0, "running": 0}}      # ... then a user arrives
        assert rec.cancel_event.wait(5), "the watcher never cancelled"
        raise RuntimeError("Inference cancelled")
    rec.run_model_impl = blocking
    res = M.execute(M.Task("USER_00000001", "LesionSegmenter", "ePAI"), world.root, world.cfg, rec.deps(), world.sessions)
    assert res.outcome == "preempted" and "busy" in res.detail
    assert len(rec.cancelled_sids) == 1 and rec.cancelled_sids[0].startswith("so-USER_00000001-LesionSegmenter-")
    assert not Path(world.root, "mask_only", "USER_00000001", "by_model").exists() and os.listdir(world.sessions) == []
    state = {"tasks": {}, "runs": []}
    M.note_result(state, M.Task("USER_00000001", "LesionSegmenter", "ePAI"), res.outcome, 10.0)
    assert state["tasks"]["USER_00000001|LesionSegmenter"].get("attempts", 0) == 0 and state["runs"] == []


def test_a_stop_request_also_cancels_a_running_model(world):
    make_case(world.root, "USER_00000001", "ePAI")
    rec = world.rec
    rec.run_model_impl = lambda *a: (rec.cancel_event.wait(5), (_ for _ in ()).throw(RuntimeError("Inference cancelled")))[1]
    flag = {"stop": False}
    threading.Timer(0.1, lambda: flag.update(stop=True)).start()
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, rec.deps(), world.sessions,
                    should_stop=lambda: flag["stop"])
    assert res.outcome == "preempted" and res.detail == "stop requested" and rec.cancelled_sids


def test_a_run_past_the_time_limit_is_cancelled_and_counts_as_a_failure(world):
    make_case(world.root, "USER_00000001", "ePAI")
    rec = world.rec
    rec.run_model_impl = lambda *a: (rec.cancel_event.wait(5), (_ for _ in ()).throw(RuntimeError("Inference cancelled")))[1]
    cfg = M.Config(poll_seconds=0.02, max_run_seconds=0.1, idle_checks=1, check_interval=0)
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, cfg, rec.deps(), world.sessions)
    assert res.outcome == "failed" and "exceeded" in res.detail and rec.cancelled_sids


@pytest.mark.parametrize("ran_on,fell_back", [([], False), (["bdmap1"], False), (["bdmap1.wse.jhu.edu"], False),
                                                (["bdmap2"], True)])
def test_a_result_that_did_not_run_on_a_worker_is_discarded(world, ran_on, fell_back):
    make_case(world.root, "USER_00000001", "ePAI")
    world.rec.ran_on, world.rec.fell_back = ran_on, fell_back
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "failed" and "not on a GPU worker" in res.detail
    assert not Path(world.root, "mask_only", "USER_00000001", "by_model").exists()


def test_the_last_look_before_dispatch_defers_the_task(world):
    make_case(world.root, "USER_00000001", "ePAI")
    seen = {"n": 0}

    def health():
        seen["n"] += 1
        return {"inference": {"active": 1, "queued": 0, "running": 0}}      # busy by the time on_start asks

    world.rec.health = health
    cfg = M.Config(idle_checks=1, check_interval=0, poll_seconds=60, max_run_seconds=30)   # the watcher never polls
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "deferred" and seen["n"] == 1                      # only on_start looked, and it said no
    assert not Path(world.root, "mask_only", "USER_00000001", "by_model").exists() and os.listdir(world.sessions) == []


def test_a_mask_on_the_wrong_grid_is_never_published(world):
    make_case(world.root, "USER_00000001", "ePAI")
    world.rec.output_shape = (16, 16, 12)
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "failed" and "grid_mismatch" in res.detail
    assert not Path(world.root, "mask_only", "USER_00000001", "by_model").exists()       # not even a .partial folder


def test_worker_errors_are_failures_with_the_reason(world):
    make_case(world.root, "USER_00000001", "ePAI")

    def boom(*a):
        raise RuntimeError("GPU worker run failed and local fallback is disabled: no idle GPU worker")
    world.rec.run_model_impl = boom
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "failed" and "local fallback is disabled" in res.detail


def test_a_failed_publish_leaves_no_partial_folder(world, monkeypatch):
    make_case(world.root, "USER_00000001", "ePAI")
    monkeypatch.setattr(ud, "_write_sublabels", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    res = M.execute(M.Task("USER_00000001", "Atlas-Net", "ePAI"), world.root, world.cfg, world.rec.deps(), world.sessions)
    assert res.outcome == "failed" and "disk full" in res.detail
    assert not any("by_model" in p for p in tree(world.root))


# ------------------------------------------------------------------ the loop
def test_the_whole_backlog_is_worked_through_once_and_never_repeated(world):
    for i, model in enumerate(["ePAI", "LesionSegmenter", "Atlas-Net"], 1):
        make_case(world.root, f"USER_0000000{i}", model)
    counts = run(world, once=True)
    assert counts["ok"] == 6 and counts["failed"] == 0 and len(world.rec.calls) == 6
    for i, model in enumerate(["ePAI", "LesionSegmenter", "Atlas-Net"], 1):
        meta = json.loads(Path(world.root, "mask_only", f"USER_0000000{i}", "metadata.json").read_text())
        assert sorted(v["model"] for v in meta["model_versions"]) == sorted(M.DEFAULT_MODELS)
        assert meta["model_versions"][0] == {"model": model, "role": "user_run", "mask": ".", "pipeline": {"segmentation_input": "original"}}
    assert os.listdir(world.sessions) == []
    again = run(world, once=True)
    assert again["ok"] == 0 and len(world.rec.calls) == 6                    # idempotent
    audit = Path(world.root, M.AUDIT_FILE).read_text().splitlines()
    assert len(audit) == 6 and all(json.loads(l)["outcome"] == "ok" for l in audit)
    report = M.status_report(world.root, world.cfg, now=world.rec.clock)
    assert report["cases"] == 3 and report["runs_last_24h"] == 6
    assert all(c["pending"] == 0 and c["done"] == 2 and c["is_users_run"] == 1 for c in report["models"].values())


def test_a_closed_gate_runs_nothing(world):
    make_case(world.root, "USER_00000001", "ePAI")
    world.rec.health = {"inference": {"active": 1, "queued": 0, "running": 0}}
    counts = run(world, once=True)
    assert counts["gate_closed"] == 1 and counts["ok"] == 0 and world.rec.calls == []
    assert json.loads(Path(world.root, M.STATUS_FILE).read_text())["state"] in ("gate_closed", "stopped")
    world.rec.health, world.rec.workers = IDLE, []
    assert run(world, once=True)["gate_closed"] == 1 and world.rec.calls == []        # no free worker either


def test_the_daily_cap_pauses_the_work(world):
    for i in range(1, 4):
        make_case(world.root, f"USER_0000000{i}", "ePAI")
    world.cfg.daily_cap = 3
    assert run(world, once=True)["ok"] == 3                                    # 3 of 6, then the cap
    assert len(world.rec.calls) == 3
    world.rec.clock += 25 * 3600                                               # a day later the cap has reset
    assert run(world, once=True)["ok"] == 3


def test_a_stop_file_ends_the_loop_at_once(world):
    make_case(world.root, "USER_00000001", "ePAI")
    Path(world.root, M.STOP_FILE).write_text("")
    assert run(world) == {"ok": 0, "failed": 0, "preempted": 0, "deferred": 0, "gate_closed": 0}
    assert world.rec.calls == []


def test_only_one_instance_may_run(world):
    pytest.importorskip("fcntl")
    make_case(world.root, "USER_00000001", "ePAI")
    with M.single_instance(world.root) as first:
        assert first is True
        counts = run(world, once=True)
        assert counts.get("already_running") == 1 and world.rec.calls == []
    assert run(world, once=True)["ok"] == 2


def test_repeated_failures_back_off_then_give_up_and_say_so(world):
    make_case(world.root, "USER_00000001", "ePAI")
    world.cfg.models = ("Atlas-Net",)

    def boom(*a):
        raise RuntimeError("worker lost")
    world.rec.run_model_impl = boom
    assert run(world, once=True)["failed"] == 1
    assert run(world, once=True)["failed"] == 0 and len(world.rec.calls) == 1            # still backing off
    world.rec.clock += 3601
    assert run(world, once=True)["failed"] == 1
    world.rec.clock += 6 * 3600 + 1
    assert run(world, once=True)["failed"] == 1 and len(world.rec.calls) == 3
    world.rec.clock += 10 * 24 * 3600
    assert run(world, once=True)["failed"] == 0 and len(world.rec.calls) == 3             # gave up for good
    report = M.status_report(world.root, world.cfg, now=world.rec.clock)
    assert report["given_up"] == ["USER_00000001|Atlas-Net"] and report["models"]["Atlas-Net"]["gave_up"] == 1


def test_a_preempted_task_is_retried_without_penalty(world):
    make_case(world.root, "USER_00000001", "ePAI")
    world.cfg.models = ("Atlas-Net",)
    rec = world.rec
    first = {"done": False}

    def impl(input_path, session_dir, model, sid, on_start):
        if not first["done"]:
            first["done"] = True
            rec.health = {"inference": {"active": 1, "queued": 0, "running": 0}}
            assert rec.cancel_event.wait(5)
            raise RuntimeError("Inference cancelled")
        rec.run_model_impl = None
        return rec.run_model(input_path, session_dir, model, sid, on_start)
    rec.run_model_impl = impl
    assert run(world, once=True, limit=1)["preempted"] == 1
    st = M.load_state(world.root)
    assert st["tasks"]["USER_00000001|Atlas-Net"].get("attempts", 0) == 0 and st["runs"] == []
    rec.health = IDLE
    rec.clock += 61
    assert run(world, once=True)["ok"] == 1


# ------------------------------------------------------------------ the command line
def _script():
    sys.path.insert(0, str(SERVER / "scripts"))
    sys.path.insert(0, str(SERVER))
    return importlib.import_module("user_dataset_second_opinions")


def test_cli_status_lists_what_is_left(world, capsys):
    make_case(world.root, "USER_00000001", "ePAI")
    assert _script().main(["--status", "--root", world.root]) == 0
    out = capsys.readouterr().out
    assert "cases: 1" in out and "Atlas-Net" in out and "pending   1" in out
    assert _script().main(["--status", "--json", "--root", world.root]) == 0
    assert json.loads(capsys.readouterr().out)["models"]["LesionSegmenter"]["pending"] == 1


def test_cli_refuses_to_run_without_gpu_workers_and_forces_the_safe_settings(world, monkeypatch, capsys):
    make_case(world.root, "USER_00000001", "ePAI")
    monkeypatch.setenv("GPU_WORKERS_ENABLED", "false")
    monkeypatch.setenv("GPU_WORKER_LOCAL_FALLBACK", "true")          # even if someone set the unsafe value
    monkeypatch.setenv("GPU_WORKER_PARALLEL", "3")
    assert _script().main(["--once", "--root", world.root]) == 3
    assert "refusing to run" in capsys.readouterr().err
    assert os.environ["GPU_WORKER_LOCAL_FALLBACK"] == "false" and os.environ["GPU_WORKER_PARALLEL"] == "1"
    assert not any("by_model" in p for p in tree(world.root))
    monkeypatch.delenv("USER_DATASET_PATH", raising=False)
    assert _script().main(["--once"]) == 2                                    # no dataset folder: nothing to do


def test_cli_dry_run_reports_the_gate_without_running_anything(world, monkeypatch, capsys):
    make_case(world.root, "USER_00000001", "ePAI")
    monkeypatch.setenv("GPU_WORKERS_ENABLED", "true")
    monkeypatch.setenv("GPU_WORKER_HOSTS", "bdmap2,bdmap3")
    monkeypatch.setattr(M, "default_deps", lambda: world.rec.deps())
    assert _script().main(["--dry-run", "--json", "--root", world.root]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["gate"]["safe_environment"] == "yes" and report["gate"]["website"] == "idle"
    assert report["gate"]["free_workers"] == ["bdmap2"] and world.rec.calls == []


# ------------------------------------------------------------------ drift guards: what the safety rests on
def test_the_safety_relies_on_these_behaviours_of_the_runner_and_the_worker_module():
    seg = (SERVER / "services" / "auto_segmentor.py").read_text(encoding="utf-8")
    gw = (SERVER / "services" / "gpu_workers.py").read_text(encoding="utf-8")
    # the website's own switch that stops a failed worker run from re-running on the web host
    assert 'GPU_WORKER_LOCAL_FALLBACK' in gw and "def local_fallback_allowed" in gw
    assert "GPU worker run failed and local fallback is disabled" in seg
    # the entry points used here
    import inspect
    from services import auto_segmentor, gpu_workers
    sig = inspect.signature(auto_segmentor.run_auto_segmentation).parameters
    assert {"input_path", "session_dir", "model", "session_id", "on_start"} <= set(sig)
    assert callable(auto_segmentor.cancel_session) and callable(auto_segmentor.pop_run_info)
    assert all(callable(getattr(gpu_workers, n)) for n in ("enabled", "hosts", "local_fallback_allowed", "_score_all", "_local_hostname"))
    # a worker run happens only for a session folder under .../tmp/ with an id-shaped name: ours qualifies
    session = "/home/visitor/PanTS-Viewer/tmp/so-USER_00000017-LesionSegmenter-3fa9c2d1"
    assert gpu_workers._is_session_path(session)
    assert M._SAFE_MODEL.match("Atlas-Net") and all(gpu_workers._SESSION_ID.match(f"so-USER_00000017-{m}-3fa9c2d1") for m in M.DEFAULT_MODELS)
    # every model run here must be one the runner knows, and the user dataset must record the same names
    assert all(f"model == '{m}'" in seg for m in M.DEFAULT_MODELS)
