"""Authenticated real API + SQLite + NIfTI; no GPU or production paths.

Run in its own pytest process (api_blueprint has import-time filesystem setup).
"""
import copy
import importlib
import io
import os
from pathlib import Path
import uuid
import zipfile
from threading import Event, Thread as RequestThread

import nibabel as nib
import numpy as np
import pandas as pd
import pytest


def sample_catalog(rig, monkeypatch, cases=2):
    """One real tiny original plus missing candidates; no production dataset."""
    api = rig['api']
    api._sample_limiter.reset()
    monkeypatch.setattr(api.Constants, 'SESSIONS_DIR_NAME', str(rig['base'] / 'samples' / uuid.uuid4().hex))
    source = Path(api.Constants.PANTS_PATH) / 'image_only' / 'PanTS_00000031' / 'ct.nii.gz'
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(rig['scan'].read_bytes())
    rows = [{'__case_str': f'PanTS_{i:08d}', '__case_sortkey': i, '__dataset': 'PanTS',
             '__sex': 'F', '__age': 50, 'shape': '(3,4,5)', 'spacing': '(1,1,1)'}
            for i in range(1, cases + 1)]
    monkeypatch.setattr(api._search_tables, 'DF_ALL', pd.DataFrame(rows))
    return source


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("pipeline_routes")
    for key, value in {
        "DATABASE_URL": f"sqlite:///{base / 'test.db'}", "PANTS_PATH": str(base / "data"),
        "PANTS_LOWRES_PATH": str(base / "lowres"), "PERMISSIONS_DIR": str(base / "perm"),
        "BODYMAPS_UPLOAD_CHUNK_DIR": str(base / "chunks"), "MOUNT_GUARD": "0",
    }.items():
        os.environ[key] = value
    import constants
    importlib.reload(constants)
    constants.Constants.SESSIONS_DIR_NAME = str(base / "sessions")
    import models.engine as engine
    importlib.reload(engine)
    from services import auth_store, plan_store, job_store
    for module in (auth_store, plan_store, job_store):
        importlib.reload(module)
    import api.auth as auth
    importlib.reload(auth)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.api_blueprint as api
    api.SESSIONS_DIR = str(base / "sessions")
    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()
    owner = auth_store.create_user("pipeline-owner@example.test", "synthetic-password1")
    other = auth_store.create_user("pipeline-other@example.test", "synthetic-password2")
    plan_store.set_plan(owner["id"], "enterprise")
    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(api.api_blueprint, url_prefix="/api")
    from api.access_policy import install_access_policy
    install_access_policy(app)
    return dict(base=base, app=app, api=api, store=job_store, plans=plan_store,
                owner=owner, owner_token=auth_store.create_session(owner["id"]),
                other=other, other_token=auth_store.create_session(other["id"]))


@pytest.fixture
def rig(env, monkeypatch):
    api = env["api"]
    client = env["app"].test_client()
    client.set_cookie("bm_session", env["owner_token"])
    other = env["app"].test_client()
    other.set_cookie("bm_session", env["other_token"])
    monkeypatch.setattr(api.inference_pipeline, "stage_availability", lambda model: (True, None))
    collected, calls = [], []
    from services import user_dataset
    monkeypatch.setattr(user_dataset, "collect_user_scan_async", lambda **kw: collected.append(kw))
    class InlineThread:
        def __init__(self, target, **kw): self.target = target
        def start(self): self.target()
    monkeypatch.setattr(api.threading, "Thread", InlineThread)
    def dispatch(source, session_dir, model, session_id, on_start):
        calls.append(model)
        if on_start() is False: return None
        output = Path(session_dir) / "output"
        output.mkdir(parents=True, exist_ok=True)
        filename = "reconstructed_ct.nii.gz" if model == "OpenVAE" else "combined_labels.nii.gz"
        data = np.zeros((3, 4, 5), dtype=np.float32) if model == "OpenVAE" else np.ones((3, 4, 5), dtype=np.uint8)
        nib.save(nib.Nifti1Image(data, np.eye(4)), output / filename)
        if model == "ePAI": (output / "output.csv").write_text("raw fixture metrics")
        return str(output)
    monkeypatch.setattr(api, "run_auto_segmentation", dispatch)
    scan = env["base"] / "scan.nii.gz"
    nib.save(nib.Nifti1Image(np.full((3, 4, 5), -100, dtype=np.float32), np.eye(4)), scan)
    def submit(**fields):
        sid = fields.pop("session_id", str(uuid.uuid4()))
        return client.post("/api/run-inference", data={
            "session_id": sid, "model_name": "ePAI", "MAIN_NIFTI": (io.BytesIO(scan.read_bytes()), "scan.nii.gz"), **fields,
        }), sid
    return dict(**env, client=client, other_client=other, submit=submit, calls=calls, collected=collected, scan=scan)


def test_complete_owned_pipeline_is_durable_and_metered_once(rig):
    response, sid = rig["submit"](preprocessing="OpenVAE", postprocessing="ShapeKit", lesion_target="pancreatic")
    assert response.status_code == 200, response.json
    assert response.json["pipeline"]["preprocessing"] == "OpenVAE"
    assert rig["calls"] == ["OpenVAE", "ePAI", "ShapeKit"]
    status = rig["client"].get(f"/api/inference-status/{sid}")
    assert status.json["status"] == "completed"
    assert all(stage["status"] == "completed" for stage in status.json["pipeline_stages"])
    assert "ct_path" not in status.json
    job = rig["store"].get_job(sid)
    assert Path(job["ct_path"]).read_bytes() == rig["scan"].read_bytes()
    assert job["reconstruction_path"] != job["ct_path"]
    assert job["pipeline"]["viewer_reference"] == "original"
    assert job["pipeline"]["segmentation_input"] == "reconstruction"
    history = rig["client"].get("/api/me/jobs").json["jobs"]
    saved = next(job for job in history if job["session_id"] == sid)
    assert saved["pipeline"] == status.json["pipeline"]
    assert not {"ct_path", "session_path", "output_mask_dir", "reconstruction_path", "zip_path"}.intersection(saved)
    assert len(rig["collected"]) == 1
    assert rig["collected"][0]["ct_path"] == job["ct_path"]
    assert rig["collected"][0]["output_mask_dir"] == job["output_mask_dir"]
    assert rig["collected"][0]["pipeline"] == job["pipeline"]
    from models.engine import session_scope
    from models.usage_event import UsageEvent
    from sqlalchemy import select
    with session_scope() as session:
        events = session.execute(select(UsageEvent).where(UsageEvent.ref_id == sid)).scalars().all()
        assert len(events) == 1
        assert events[0].finished_at is not None
    archive = rig["client"].get(f"/api/get_result/{sid}")
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.data)) as z:
        assert "combined_labels.nii.gz" in z.namelist()
        assert "pipeline.json" in z.namelist()
        assert "segmentation_original/output.csv" in z.namelist()
        assert "output.csv" not in z.namelist()
    assert rig["client"].get(f"/api/session-ct/{sid}").status_code == 200
    assert rig["client"].get(f"/api/session-reconstruction/{sid}").status_code == 200
    assert rig["client"].get(f"/api/session-segmentation/{sid}").status_code == 200
    prior_calls = list(rig["calls"])
    replay, _ = rig["submit"](session_id=sid, preprocessing="OpenVAE", postprocessing="ShapeKit", lesion_target="pancreatic")
    assert replay.status_code == 200
    assert replay.json["reused"] is True
    assert replay.json["status"] == "completed"
    assert rig["calls"] == prior_calls
    # Rehydrate only from SQL, not the process-local dictionary.
    rig["api"].inference_jobs.pop(sid)
    assert rig["client"].get(f"/api/inference-status/{sid}").json["status"] == "completed"
    for route in ("inference-status", "session-ct", "session-reconstruction", "session-segmentation", "get_result"):
        assert rig["other_client"].get(f"/api/{route}/{sid}").status_code == 403


def test_capabilities_require_signin(rig):
    assert rig["app"].test_client().get("/api/pipeline/options").status_code == 401
    response = rig["client"].get("/api/pipeline/options")
    assert response.status_code == 200
    assert response.json["version"] == 1
    assert "Atlas-Net" in response.json["postprocessing"][0]["supported_models"]


@pytest.mark.parametrize("fields,code", [({"preprocessing": "MAISI"}, 400), ({"postprocessing": "ShapeKit", "model_name": "MedIA Vertebrae"}, 400)])
def test_invalid_pipeline_never_runs_or_charges(rig, fields, code):
    response, sid = rig["submit"](**fields)
    assert response.status_code == code
    assert not rig["calls"]
    assert rig["store"].get_job(sid) is None


@pytest.mark.parametrize("selection", [{"preprocessing": "OpenVAE"}, {"model_name": "OpenVAE"}])
def test_missing_stage_weights_fail_before_upload_or_charge(rig, monkeypatch, selection):
    monkeypatch.setattr(rig["api"].inference_pipeline, "stage_availability", lambda model: (False, "Actual weights missing"))
    response, sid = rig["submit"](**selection)
    assert response.status_code == 503
    assert response.json["code"] == "pipeline_unavailable"
    assert not rig["calls"]
    assert rig["store"].get_job(sid) is None
    assert not (Path(rig["api"].SESSIONS_DIR) / sid).exists()


def test_stage_plan_gate_stays_server_side(rig):
    rig["plans"].set_plan(rig["owner"]["id"], "free")
    try:
        response, sid = rig["submit"](model_name="LesionSegmenter", postprocessing="ShapeKit")
        assert response.status_code == 402
        assert response.json["reason"] == "postprocessing"
        assert not rig["calls"]
    finally:
        rig["plans"].set_plan(rig["owner"]["id"], "enterprise")


def test_no_silent_stage_skip_for_wrong_json_types(rig):
    response = rig["client"].post("/api/run-inference", json={
        "session_id": str(uuid.uuid4()), "preprocessing": True,
    })
    # No valid input means the route can reject the upload before stage validation.
    assert response.status_code == 400
    assert not rig["calls"]


def test_failed_model_never_publishes_partial_outputs(rig, monkeypatch):
    real = rig["api"].run_auto_segmentation
    def fail(source, **kw):
        if kw["model"] == "ePAI": raise RuntimeError("Synthetic model failure")
        return real(source, **kw)
    monkeypatch.setattr(rig["api"], "run_auto_segmentation", fail)
    response, sid = rig["submit"](preprocessing="OpenVAE", postprocessing="ShapeKit")
    assert response.status_code == 200
    status = rig["client"].get(f"/api/inference-status/{sid}").json
    assert status["status"] == "failed"
    assert [s["status"] for s in status["pipeline_stages"]] == ["completed", "failed", "queued", "queued"]
    assert not rig["collected"]
    assert rig["client"].get(f"/api/get_result/{sid}").status_code == 202
    assert rig["client"].get(f"/api/session-segmentation/{sid}").status_code == 404


def test_duplicate_session_is_rejected_until_cancelled_worker_exits(rig, monkeypatch):
    targets = []
    class DeferredThread:
        def __init__(self, target, **kw): targets.append(target)
        def start(self): pass
    monkeypatch.setattr(rig["api"].threading, "Thread", DeferredThread)
    response, sid = rig["submit"](preprocessing="OpenVAE")
    assert response.status_code == 200
    replay = rig["submit"](session_id=sid, preprocessing="OpenVAE")[0]
    assert replay.status_code == 200
    assert replay.json["reused"] is True
    assert len(targets) == 1
    assert rig["submit"](session_id=sid)[0].status_code == 409
    assert rig["client"].post(f"/api/cancel-inference/{sid}").status_code == 200
    assert rig["submit"](session_id=sid)[0].status_code == 409
    targets[0]()
    assert not rig["calls"]
    assert rig["client"].get(f"/api/inference-status/{sid}").json["status"] == "cancelled"
    assert sid not in rig["api"]._dispatching_sessions


def test_reconstruction_source_must_be_completed_openvae(rig):
    response, sid = rig["submit"]()
    result = rig["client"].post("/api/run-inference", json={
        "session_id": str(uuid.uuid4()), "source_reconstruction_session_id": sid,
    })
    assert result.status_code == 409


def test_cancellation_wins_atomic_final_publication(rig, monkeypatch):
    real = rig["api"]._set_inference_job
    def racing(session_id, **fields):
        if fields.get("status") == "completed":
            real(session_id, status="cancelled", cancel_requested=True, error="Cancelled by user")
        return real(session_id, **fields)
    monkeypatch.setattr(rig["api"], "_set_inference_job", racing)
    response, sid = rig["submit"](postprocessing="ShapeKit")
    assert response.status_code == 200
    status = rig["client"].get(f"/api/inference-status/{sid}").json
    assert status["status"] == "cancelled"
    assert status["pipeline_stages"][-1]["status"] == "cancelled"
    assert not rig["collected"]
    job = rig["store"].get_job(sid)
    assert not job["output_mask_dir"]
    assert not Path(job["zip_path"]).exists()


def test_database_failure_never_publishes_memory_success(rig, monkeypatch):
    response, sid = rig["submit"]()
    before = copy.deepcopy(rig["api"].inference_jobs[sid])
    def fail(*a, **kw): raise RuntimeError("Synthetic database write failure")
    monkeypatch.setattr(rig["store"], "update_job", fail)
    with pytest.raises(RuntimeError):
        rig["api"]._set_inference_job(sid, status="running", error="should not publish")
    assert rig["api"].inference_jobs[sid] == before


def test_active_history_cannot_be_deleted_and_resurrected(rig, monkeypatch):
    targets = []
    class DeferredThread:
        def __init__(self, target, **kw): targets.append(target)
        def start(self): pass
    monkeypatch.setattr(rig["api"].threading, "Thread", DeferredThread)
    response, sid = rig["submit"]()
    assert response.status_code == 200
    assert rig["client"].delete("/api/me/jobs").status_code == 409
    rig["client"].post(f"/api/cancel-inference/{sid}")
    assert rig["client"].delete("/api/me/jobs").status_code == 409
    targets[0]()
    assert rig["client"].delete("/api/me/jobs").status_code == 200
    assert rig["store"].get_job(sid) is None
    assert sid not in rig["api"].inference_jobs


def test_restart_reaper_frees_concurrency_and_preserves_finished_stages(rig):
    from models.engine import session_scope
    from models.usage_event import UsageEvent
    from sqlalchemy import select
    sid = str(uuid.uuid4())
    store = rig["store"]
    store.create_job(sid, "ePAI", None, None, None, rig["owner"]["id"])
    manifest = rig["api"].inference_pipeline.selection("ePAI", "OpenVAE")
    stages = rig["api"].inference_pipeline.initial_stages(manifest)
    stages[0]["status"] = "completed"
    stages[1]["status"] = "running"
    store.update_job(sid, status="running", pipeline=manifest, pipeline_stages=stages)
    rig["api"]._persist_inference_job(sid, dict(store.get_job(sid)))
    rig["plans"].record_inference(rig["owner"]["id"], sid, "ePAI")
    assert store.reap_orphaned_jobs() >= 1
    job = store.get_job(sid)
    assert job["status"] == "failed"
    assert [s["status"] for s in job["pipeline_stages"]] == ["completed", "failed", "queued"]
    # A stale running job.json must not overwrite the SQL restart verdict.
    rig["api"].inference_jobs.pop(sid, None)
    assert rig["client"].get(f"/api/inference-status/{sid}").json["status"] == "failed"
    with session_scope() as session:
        event = session.execute(select(UsageEvent).where(UsageEvent.ref_id == sid)).scalar_one()
        assert event.finished_at is not None


def test_replay_during_input_admission_is_retryable_not_forbidden(rig):
    sid = str(uuid.uuid4())
    api = rig["api"]
    api._dispatching_sessions.add(sid)
    api._dispatching_owners[sid] = rig["owner"]["id"]
    api._admitting_sessions.add(sid)
    try:
        response, _ = rig["submit"](session_id=sid)
        assert response.status_code == 409
        assert response.json["code"] == "inference_admitting"
        assert response.headers["Retry-After"] == "1"
        denied = rig["other_client"].post("/api/run-inference", json={"session_id": sid})
        assert denied.status_code == 403
        assert rig["client"].delete("/api/me/jobs").status_code == 409
    finally:
        api._dispatching_sessions.discard(sid)
        api._dispatching_owners.pop(sid)
        api._admitting_sessions.discard(sid)


@pytest.mark.parametrize("retry_failed_job", [False, True])
def test_cancel_during_admission_prevents_queue_and_charge(rig, monkeypatch, retry_failed_job):
    """Pause at real NIfTI validation and cancel through the real owner route.

    Covers both an entirely new session and a retry whose old failed Job exists:
    the latter must cancel the new claim, not return 'old job already finished'.
    """
    from models.engine import session_scope
    from models.usage_event import UsageEvent
    from sqlalchemy import select
    api, store = rig["api"], rig["store"]
    sid = str(uuid.uuid4())
    if retry_failed_job:
        store.create_job(sid, "ePAI", None, None, None, rig["owner"]["id"])
        store.update_job(sid, status="failed", error="Previous failure",
                         pipeline=api.inference_pipeline.selection("ePAI"))
    real_load = api.nib.load
    cancelled = []

    def cancel_while_validating(path, *args, **kwargs):
        if Path(path).parent.name == sid and not cancelled:
            assert sid in api._admitting_sessions
            # Presenting somebody else's session ID must not stop their upload.
            # Separate app contexts model concurrent requests; nested clients
            # otherwise share Flask.g's cached current user with the outer POST.
            with rig["app"].app_context():
                denied = rig["other_client"].post(f"/api/cancel-inference/{sid}")
            assert denied.status_code == 403
            assert sid not in api._cancelled_admissions
            with rig["app"].app_context():
                response = rig["client"].post(f"/api/cancel-inference/{sid}")
            assert response.status_code == 200
            assert response.json["status"] == "cancelled"
            cancelled.append(True)
            with rig["app"].app_context():
                replay, _ = rig["submit"](session_id=sid)
            assert replay.status_code == 409
            assert replay.json["code"] == "inference_cancelled"
        return real_load(path, *args, **kwargs)

    monkeypatch.setattr(api.nib, "load", cancel_while_validating)
    response, _ = rig["submit"](session_id=sid)
    assert cancelled == [True]
    assert response.status_code == 409, response.json
    assert response.json["code"] == "inference_cancelled"
    assert not rig["calls"]
    assert not rig["collected"]
    old = store.get_job(sid)
    assert (old and old["status"] == "failed") if retry_failed_job else old is None
    with session_scope() as session:
        assert session.execute(select(UsageEvent).where(UsageEvent.ref_id == sid)).scalars().all() == []
    assert sid not in api._dispatching_sessions
    assert sid not in api._dispatching_owners
    assert sid not in api._admitting_sessions
    assert sid not in api._cancelled_admissions
    if not retry_failed_job:
        assert not (Path(api.SESSIONS_DIR) / sid / "scan.nii.gz").exists()
    # Claim/queue capacity cleanup permits a deliberate later retry.
    retry, _ = rig["submit"](session_id=sid)
    assert retry.status_code == 200, retry.json
    assert rig["calls"] == ["ePAI"]


def test_stage_sample_requires_auth_and_account_binding(rig, monkeypatch):
    sample_catalog(rig, monkeypatch)
    sid = str(uuid.uuid4())
    assert rig['app'].test_client().post('/api/stage-sample', json={'session_id': sid}).status_code == 401
    wrong = rig['client'].post('/api/stage-sample', json={'session_id': sid}, headers={'X-Upload-Owner': rig['other']['id']})
    assert wrong.status_code == 409
    assert not (Path(rig['api'].Constants.SESSIONS_DIR_NAME) / 'inference' / sid).exists()


def test_stage_sample_original_preview_replay_cleanup_without_job_or_charge(rig, monkeypatch):
    source = sample_catalog(rig, monkeypatch)
    original = source.read_bytes()
    sid = str(uuid.uuid4())
    rig['plans'].set_plan(rig['owner']['id'], 'free')
    try:
        response = rig['client'].post('/api/stage-sample', json={'session_id': sid})
        assert response.status_code == 200, response.json
        assert response.json['case_id'] == 'PanTS_00000031'
        assert response.json['uploaded_filename'] == 'BDMAP_SAMPLE/ct.nii.gz'
        assert response.json['size'] == len(original)
        assert not {'path', 'ct_path', 'user_id'}.intersection(response.json)
        assert rig['store'].get_job(sid) is None
        assert not rig['calls']
        assert 'no-store' in response.headers['Cache-Control']
        preview = rig['client'].get(response.json['preview_url'])
        assert preview.status_code == 200 and preview.data == original
        assert 'no-store' in preview.headers['Cache-Control']
        preview.close()  # Simulate completion of the streamed HTTP response on Windows.
        replay = rig['client'].post('/api/stage-sample', json={'session_id': sid})
        assert replay.status_code == 200 and replay.json['reused']
        assert rig['other_client'].post('/api/stage-sample', json={'session_id': sid}).status_code == 403
        assert rig['other_client'].get(response.json['preview_url']).status_code == 403
        assert rig['other_client'].delete(f'/api/stage-sample/{sid}').status_code == 403
        assert rig['client'].delete(f'/api/stage-sample/{sid}').status_code == 204
        assert rig['client'].delete(f'/api/stage-sample/{sid}').status_code == 204
        assert rig['client'].get(response.json['preview_url']).status_code == 404
        assert source.read_bytes() == original
        from models.engine import session_scope
        from models.usage_event import UsageEvent
        from sqlalchemy import select
        with session_scope() as session:
            assert session.execute(select(UsageEvent).where(UsageEvent.ref_id == sid)).scalars().all() == []
    finally:
        rig['plans'].set_plan(rig['owner']['id'], 'enterprise')


@pytest.mark.parametrize('payload', [
    {'session_id': '../escape'}, {'session_id': 'not-a-uuid'},
    {'session_id': str(uuid.uuid4()), 'path': '/etc/passwd'},
    {'session_id': str(uuid.uuid4()), 'case_id': 'PanTS_00000035'}, [], None,
])
def test_sample_refuses_untrusted_paths_or_overrides(rig, monkeypatch, payload):
    sample_catalog(rig, monkeypatch)
    assert rig['client'].post('/api/stage-sample', json=payload).status_code == 400
    assert not rig['calls']


def test_sample_refuses_form_submission_and_new_request_rate_limit(rig, monkeypatch):
    sample_catalog(rig, monkeypatch)
    assert rig['client'].post('/api/stage-sample', data={'session_id': str(uuid.uuid4())}).status_code == 400
    monkeypatch.setattr(rig['api']._sample_limiter, 'over', lambda *args: True)
    response = rig['client'].post('/api/stage-sample', json={'session_id': str(uuid.uuid4())})
    assert response.status_code == 429 and response.json['code'] == 'sample_rate_limit'


@pytest.mark.parametrize('code', ['sample_unavailable', 'internal/path/should-not-escape'])
def test_sample_errors_never_expose_exception_details(rig, monkeypatch, code):
    sample_catalog(rig, monkeypatch)
    api = rig['api']
    def fail(*args, **kwargs):
        raise api.SampleError('Private storage /internal/account/credentials failed', code, 500)
    monkeypatch.setattr(api.SampleStager, 'prepare', fail)
    response = rig['client'].post('/api/stage-sample', json={'session_id': str(uuid.uuid4())})
    assert response.status_code == 503
    assert response.json == {
        'error': 'A sample is temporarily unavailable. Please try again later.',
        'code': 'sample_unavailable',
    }
    assert b'internal' not in response.data and b'credentials' not in response.data


def test_delete_during_sample_claim_initialization_waits_then_cancels(rig, monkeypatch):
    source = sample_catalog(rig, monkeypatch)
    original = source.read_bytes()
    sid = str(uuid.uuid4())
    claim_started, allow_claim, delete_started, delete_done = (Event() for _ in range(4))
    responses, errors = {}, []
    real_touch = Path.touch
    real_candidates = rig['api']._sample_candidates
    def pause_initialization(path, *args, **kwargs):
        if path.name == '.sample-staging':
            claim_started.set()
            assert allow_claim.wait(5)
        return real_touch(path, *args, **kwargs)
    def after_delete():
        assert delete_done.wait(5)
        yield from real_candidates()
    monkeypatch.setattr(Path, 'touch', pause_initialization)
    monkeypatch.setattr(rig['api'], '_sample_candidates', after_delete)
    def request(method):
        client = rig['app'].test_client()
        client.set_cookie('bm_session', rig['owner_token'])
        try:
            if method == 'DELETE':
                delete_started.set()
                responses[method] = client.delete(f'/api/stage-sample/{sid}')
            else:
                responses[method] = client.post('/api/stage-sample', json={'session_id': sid})
        except BaseException as error:
            errors.append(error)
        finally:
            if method == 'DELETE':
                delete_done.set()
    preparing = RequestThread(target=request, args=('POST',))
    deleting = RequestThread(target=request, args=('DELETE',))
    preparing.start()
    assert claim_started.wait(5)
    deleting.start()
    assert delete_started.wait(5)
    assert not delete_done.wait(0.05), 'DELETE must not inspect an incomplete ownership claim'
    allow_claim.set()
    preparing.join(10)
    deleting.join(10)
    assert not preparing.is_alive() and not deleting.is_alive()
    assert errors == []
    assert responses['DELETE'].status_code == 204
    assert responses['POST'].status_code == 409
    assert responses['POST'].json['code'] == 'sample_cancelled'
    assert not (Path(rig['api'].Constants.SESSIONS_DIR_NAME) / 'inference' / sid).exists()
    assert source.read_bytes() == original
    assert rig['store'].get_job(sid) is None and not rig['calls']


def test_sample_uses_only_case_31_without_substituting_other_catalog_cases(rig, monkeypatch):
    sample_catalog(rig, monkeypatch, cases=6)
    lookups = []
    api = rig['api']
    def missing(case):
        lookups.append(case)
        return {'dataset': 'PanTS', 'image': str(Path(api.Constants.PANTS_PATH) / 'missing' / case)}
    monkeypatch.setattr(api, 'get_case_nifti_paths', missing)
    response = rig['client'].post('/api/stage-sample', json={'session_id': str(uuid.uuid4())})
    assert response.status_code == 503 and response.json['code'] == 'sample_unavailable'
    assert lookups == ['PanTS_00000031']


def test_staged_sample_runs_via_existing_admission_and_preserves_source(rig, monkeypatch):
    source = sample_catalog(rig, monkeypatch)
    original = source.read_bytes()
    sid = str(uuid.uuid4())
    staged = rig['client'].post('/api/stage-sample', json={'session_id': sid}).json
    response = rig['client'].post('/api/run-inference', json={
        'session_id': sid, 'uploaded_filename': staged['uploaded_filename'], 'model_name': 'ePAI',
    })
    assert response.status_code == 200, response.json
    assert rig['calls'] == ['ePAI']
    job = rig['store'].get_job(sid)
    assert job['status'] == 'completed'
    assert Path(job['ct_path']).read_bytes() == original
    assert source.read_bytes() == original
    assert rig['client'].delete(f'/api/stage-sample/{sid}').status_code == 409
    assert rig['client'].get(f'/api/session-ct/{sid}').data == original
    # A later sample reclaims the consumed staging copy, never the Job's CT.
    again = rig['client'].post('/api/stage-sample', json={'session_id': str(uuid.uuid4())})
    assert again.status_code == 200
    assert not (Path(rig['api'].Constants.SESSIONS_DIR_NAME) / 'inference' / sid).exists()
    assert Path(job['ct_path']).read_bytes() == original


def test_sample_delete_cannot_race_inference_admission(rig, monkeypatch):
    source = sample_catalog(rig, monkeypatch)
    sid = str(uuid.uuid4())
    assert rig['client'].post('/api/stage-sample', json={'session_id': sid}).status_code == 200
    api = rig['api']
    with api._dispatching_sessions_lock:
        api._dispatching_sessions.add(sid)
    try:
        response = rig['client'].delete(f'/api/stage-sample/{sid}')
        assert response.status_code == 409 and response.json['code'] == 'sample_in_use'
        assert rig['client'].get(f'/api/session-ct/{sid}').data == source.read_bytes()
    finally:
        with api._dispatching_sessions_lock:
            api._dispatching_sessions.discard(sid)
