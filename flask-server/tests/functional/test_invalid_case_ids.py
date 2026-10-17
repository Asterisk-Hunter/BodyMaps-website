"""A malformed PanTS case id is a clean 400, not a 500 (a scanner probing /api/get-main-nifti/abc.nii.gz
used to fill the log with tracebacks).

api.api_blueprint has import-time side effects, so the fixture points every path at a temp dir before the
import. The module is imported once per pytest process: run this file as its own step, as ci.yml does.
"""
import importlib
import os

import pytest

pytest.importorskip("asgiref")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    base = tmp_path_factory.mktemp("bad_ids")
    for var, value in [
        ("DATABASE_URL", f"sqlite:///{base / 'b.db'}"),
        ("PANTS_PATH", str(base / "pants")),
        ("PANTS_LOWRES_PATH", str(base / "lowres")),
        ("PERMISSIONS_DIR", str(base / "perm")),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", str(base / "chunks")),
        ("MOUNT_GUARD", "0"),
    ]:
        os.environ[var] = value
    for var in ("CANCERVERSE_PATH", "ABDOMENATLAS_PATH"):
        os.environ.pop(var, None)
    (base / "pants" / "image_only" / "PanTS_00000007").mkdir(parents=True)
    (base / "pants" / "image_only" / "PanTS_00000007" / "ct.nii.gz").write_bytes(b"ct")
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
    import api.api_blueprint as api_bp
    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()
    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(api_bp.api_blueprint, url_prefix="/api")
    return app.test_client()


BAD = ["abc", "PanTS_abc", "x1", "PanTS_", "-1", "CV_abc", "CV_", "BDMAP_abc", "BDMAP_"]


@pytest.mark.parametrize("bad", BAD)
@pytest.mark.parametrize("method", ["get", "head"])
def test_the_ct_route_answers_400_to_a_malformed_id(client, bad, method):
    resp = getattr(client, method)(f"/api/get-main-nifti/{bad}.nii.gz")
    assert resp.status_code == 400, (bad, resp.status_code)


@pytest.mark.parametrize("bad", BAD)
def test_the_low_res_ct_route_answers_400_too(client, bad):
    assert client.get(f"/api/get-main-nifti/{bad}.nii.gz?res=low").status_code == 400


@pytest.mark.parametrize("bad", BAD)
def test_the_thumbnail_route_answers_400_to_a_malformed_id(client, bad):
    assert client.get(f"/api/get_image_preview/{bad}").status_code == 400


def test_real_ids_behave_as_before(client):
    assert client.get("/api/get-main-nifti/7.nii.gz").status_code == 200          # exists
    assert client.get("/api/get-main-nifti/PanTS_00000007.nii.gz").status_code == 200
    assert client.get("/api/get-main-nifti/8.nii.gz").status_code == 404           # a number nobody has
    assert client.get("/api/get_image_preview/8").status_code == 404
    assert client.get("/api/get-main-nifti/CV_00000001.nii.gz").status_code == 404     # the other datasets keep their answers
    assert client.get("/api/get-main-nifti/BDMAP_00000001.nii.gz").status_code == 404


def test_a_missing_thumbnail_does_not_reveal_a_server_path(client):
    body = client.get("/api/get_image_preview/8").get_json()
    assert body == {"error": "File not found"}
    assert "/" not in str(body) and "\\" not in str(body)
