"""Dataset-mount gate on the real routes.

When the network mount behind the datasets hangs, routes that read it must answer 503 at once
(instead of parking a gunicorn thread forever) while everything that does not need it keeps
working: /api/ping, /api/health, search, the low-res viewer and pre-baked meshes served from
local disk.

api.api_blueprint has import-time side effects (it creates directories from env-configured
paths), so the fixture points every path at a temp dir before the import. The module is imported
once per pytest process: run this file as its own step, as ci.yml does.
"""
import importlib
import inspect
import os
import time

import pytest

pytest.importorskip("asgiref")      # two of the gated routes are `async def`

# Routes that read the dataset mount unconditionally -> decorated with @requires_dataset_mount.
# (method, URL) is any request that reaches the route; the gate answers before the view runs.
GATED = {
    "get_image_preview": ("GET", "/api/get_image_preview/1"),
    "get_label_colormap": ("GET", "/api/get-label-colormap/1"),
    "get_report_data": ("GET", "/api/get-report-data/1"),
    "report_html": ("GET", "/api/report/1"),
    "generate_report_pdf": ("GET", "/api/generate-report-pdf/1"),
    "download_segmentation_zip": ("GET", "/api/download/1"),
    "get_specific_segmentations": ("POST", "/api/get-specific-segmentations/1"),
    "save_edited_mask": ("POST", "/api/save-edited-mask/1"),
    "list_edited_masks": ("GET", "/api/list-edited-masks/1"),
    "interactive_segment": ("POST", "/api/interactive-segment/1"),
    "vessel_cpr": ("POST", "/api/vessel-cpr/1"),
    "get_shared_case": ("GET", "/api/share/sometoken"),
}
# Routes with a local-disk fast path: they check the mount just before their first mount read.
INLINE = {
    "get_main_nifti": "get-main-nifti",
    "get_segmentations": "get-segmentations",
    "get_mask_data": "mask-data",
    "get_mesh_manifest": "mesh-manifest",
    "get_mesh_file": "render_only",
}
# Deliberately NOT gated: the AI assistant (chat that only sometimes touches a case) and the
# in-memory/database routes. Listed so a new gated or ungated dataset route has to be a decision.
KNOWN_UNGATED_DATASET_READERS = {"ai_command", "ai_command_stream", "upload"}


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("mount_gate")
    for var, sub in [
        ("DATABASE_URL", None),
        ("PANTS_PATH", "data"),
        ("PANTS_LOWRES_PATH", "lowres"),
        ("PERMISSIONS_DIR", "perm"),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", "chunks"),
        ("MOUNT_GUARD", None),
    ]:
        if var == "MOUNT_GUARD":
            os.environ[var] = "0"       # no background thread in tests; each test sets the verdict itself
            continue
        os.environ[var] = f"sqlite:///{base / 'mg.db'}" if sub is None else str(base / sub)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.api_blueprint as api_bp           # heavy; imported once

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()
    user = auth_store.create_user("mount-check@example.test", "test-password1")
    token = auth_store.create_session(user["id"])

    from flask import Flask
    flask_app = Flask(__name__)
    flask_app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    flask_app.register_blueprint(api_bp.api_blueprint, url_prefix="/api")
    from api.access_policy import install_access_policy
    install_access_policy(flask_app)
    return {"app": flask_app, "api": api_bp, "base": base, "token": token}


def _client(env):
    client = env["app"].test_client()
    client.set_cookie("bm_session", env["token"])
    return client


@pytest.fixture()
def monitor(env):
    """A monitor whose verdict the test controls (no probing, no threads)."""
    from services import mount_health as mh
    mon = mh.MountMonitor(["/does/not/matter"], probe=lambda p: True)
    mh.reset_for_tests(mon)
    yield mon
    mh.reset_for_tests(None)


def _call(client, method, url):
    return client.open(url, method=method)


# ------------------------------------------------------------------ the gate itself
@pytest.mark.parametrize("endpoint", sorted(GATED))
def test_gated_route_answers_503_fast_while_the_mount_is_down(env, monitor, endpoint):
    monitor._down = True
    method, url = GATED[endpoint]
    t0 = time.time()
    resp = _call(_client(env), method, url)
    assert resp.status_code == 503, (endpoint, resp.status_code, resp.get_data(as_text=True)[:200])
    assert time.time() - t0 < 1.0
    assert resp.get_json()["error"] == "dataset_storage_unavailable"
    assert resp.headers["Retry-After"]


@pytest.mark.parametrize("endpoint", sorted(GATED))
def test_gated_route_runs_normally_while_the_mount_is_up(env, monitor, endpoint):
    """Up means 'not 503 from the gate': the real view runs (and may 4xx on a bare fixture)."""
    method, url = GATED[endpoint]
    resp = _call(_client(env), method, url)
    body = resp.get_json(silent=True) or {}
    assert body.get("error") != "dataset_storage_unavailable"


def test_every_gated_route_carries_the_marker_and_nothing_else_does(env):
    api = env["api"]
    marked = {
        name for name, fn in vars(api).items()
        if inspect.isfunction(fn) and getattr(fn, "requires_dataset_mount", False)
    }
    assert marked == set(GATED), (
        "the set of @requires_dataset_mount routes changed: update GATED here on purpose "
        f"(only in code: {sorted(marked - set(GATED))}, only in test: {sorted(set(GATED) - marked)})"
    )


def test_inline_gate_routes_check_the_mount(env):
    api = env["api"]
    for name in INLINE:
        assert "mount_down_response()" in inspect.getsource(getattr(api, name)), (
            f"{name} must call mount_down_response() before its first read of the dataset mount"
        )


def test_known_ungated_dataset_readers_still_exist(env):
    """If one of these is renamed or removed, revisit the list instead of letting it rot."""
    for name in KNOWN_UNGATED_DATASET_READERS:
        assert hasattr(env["api"], name), name


# ------------------------------------------------------- what must keep working in an outage
def test_ping_search_and_health_work_while_the_mount_is_down(env, monitor):
    monitor._down = True
    client = _client(env)
    assert client.get("/api/ping").status_code == 200
    assert client.get("/api/search?limit=1").status_code == 200       # in-memory catalog
    resp = client.get("/api/health")
    assert resp.status_code == 503
    body = resp.get_json()
    assert body["status"] == "degraded" and body["mount"]["ok"] is False
    assert set(body["inference"]) == {"running", "queued", "active"}
    assert "mount" not in repr(body["mount"].get("path", ""))          # no filesystem paths published


def test_health_is_200_and_reports_inference_while_the_mount_is_up(env, monitor):
    api = env["api"]
    with api._inference_jobs_lock:
        api.inference_jobs["t-run"] = {"status": "running"}
        api.inference_jobs["t-q1"] = {"status": "queued"}
        api.inference_jobs["t-done"] = {"status": "completed"}
    try:
        resp = _client(env).get("/api/health")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "ok"
        assert body["inference"] == {"running": 1, "queued": 1, "active": 2}
        assert resp.headers["Cache-Control"] == "private, no-store, max-age=0"
    finally:
        with api._inference_jobs_lock:
            for k in ("t-run", "t-q1", "t-done"):
                api.inference_jobs.pop(k, None)


def test_health_does_not_touch_the_filesystem(env, monitor, monkeypatch):
    """The point of /health is to answer when the disk and mount hang: it must read cached state only."""
    def boom(*a, **k):
        raise AssertionError("health must not touch the filesystem")
    monkeypatch.setattr(os, "stat", boom, raising=True)
    monkeypatch.setattr(os.path, "exists", boom, raising=True)
    monkeypatch.setattr(os.path, "isdir", boom, raising=True)
    resp = _client(env).get("/api/health")
    assert resp.status_code == 200


def test_lowres_ct_is_served_from_local_disk_during_an_outage(env, monitor):
    """PanTS low-res copies live on local disk: the viewer keeps working through a mount outage."""
    api = env["api"]
    low = os.path.join(api.LOWRES_ROOT, "image_only", "PanTS_00000001")
    os.makedirs(low, exist_ok=True)
    with open(os.path.join(low, "ct_lowres.nii.gz"), "wb") as f:
        f.write(b"\x1f\x8b" + b"lowres-bytes")
    monitor._down = True
    client = _client(env)
    ok = client.get("/api/get-main-nifti/1.nii.gz?res=low")
    assert ok.status_code == 200, ok.get_data(as_text=True)[:200]
    # the full-resolution file is on the mount: refused fast
    full = client.get("/api/get-main-nifti/1.nii.gz")
    assert full.status_code == 503 and full.get_json()["error"] == "dataset_storage_unavailable"
    # a case with no local low-res copy falls through to the mount: refused fast too
    assert client.get("/api/get-main-nifti/2.nii.gz?res=low").status_code == 503


def test_lowres_mask_is_served_from_local_disk_during_an_outage(env, monitor):
    api = env["api"]
    low = os.path.join(api.LOWRES_ROOT, "mask_only", "PanTS_00000001")
    os.makedirs(low, exist_ok=True)
    with open(os.path.join(low, "combined_labels_lowres.nii.gz"), "wb") as f:
        f.write(b"\x1f\x8b" + b"lowres-mask")
    monitor._down = True
    client = _client(env)
    assert client.get("/api/get-segmentations/1.nii.gz?res=low").status_code == 200
    assert client.get("/api/get-segmentations/1.nii.gz").status_code == 503


def test_prebaked_meshes_are_served_during_an_outage_but_baking_is_refused(env, monitor):
    from constants import Constants
    case = "PanTS_00000001"
    mesh_dir = os.path.join(Constants.MESH_PATH, case)
    os.makedirs(mesh_dir, exist_ok=True)
    with open(os.path.join(mesh_dir, "liver.glb"), "wb") as f:
        f.write(b"glTF-bytes")
    monitor._down = True
    client = _client(env)
    assert client.get(f"/api/cases/{case}/render_only/liver.glb").status_code == 200
    assert client.get(f"/api/cases/{case}/render_only/spleen.glb").status_code == 503   # would need the mask
    assert client.get("/api/cases/2/mesh-manifest").status_code == 503                  # would bake from the mask


def test_mask_data_for_catalog_cases_is_refused_but_uploaded_sessions_are_not(env, monitor):
    monitor._down = True
    client = _client(env)
    resp = client.post("/api/mask-data", data={"sessionKey": "12"})
    assert resp.status_code == 503
    resp = client.post("/api/mask-data", data={"sessionKey": "3f0c1d4e-1111-4222-8333-444455556666"})
    assert resp.status_code != 503          # a user's own upload is on local disk


def test_cancerverse_ct_is_refused_during_an_outage(env, monitor):
    """Finding a CancerVerse scan looks on the mount and its overlay, with no local low-res shortcut
    for an unknown case, so it must be refused up front rather than hang."""
    monitor._down = True
    client = _client(env)
    for url in ("/api/get-main-nifti/CV_00000001.nii.gz", "/api/get-main-nifti/CV_00000001.nii.gz?res=low"):
        resp = client.get(url)
        assert resp.status_code == 503, url
        assert resp.get_json()["error"] == "dataset_storage_unavailable"


@pytest.mark.parametrize("down", [False, True])
def test_health_stays_public_without_account_or_filesystem_reads(env, monitor, monkeypatch, down):
    from api import auth
    monitor._down = down
    def forbidden():
        raise AssertionError("public health must not resolve an account session")
    monkeypatch.setattr(auth, "current_user", forbidden)
    client = env["app"].test_client()
    for method in ("GET", "HEAD"):
        response = client.open("/api/health", method=method)
        assert response.status_code == (503 if down else 200)
        assert response.headers["Cache-Control"] == "private, no-store, max-age=0"


def test_session_guard_precedes_mount_gate_and_local_disk_paths(env, monitor):
    monitor._down = True
    client = env["app"].test_client()
    for path in ("/api/search", "/api/get-main-nifti/1.nii.gz?res=low", "/api/get-segmentations/1.nii.gz"):
        response = client.get(path)
        assert response.status_code == 401
        assert response.get_json()["code"] == "authentication_required"
    assert _client(env).get("/api/search").status_code == 200
    assert _client(env).get("/api/get-segmentations/1.nii.gz").status_code == 503
