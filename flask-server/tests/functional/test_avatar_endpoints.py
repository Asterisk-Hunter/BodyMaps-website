"""Real decoding, authenticated ownership, persistence and account lifecycle."""

import base64
from datetime import timedelta
from io import BytesIO
import importlib

from PIL import Image, PngImagePlugin
import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'avatar.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as bp
    importlib.reload(bp)
    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()
    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(bp.auth_blueprint, url_prefix="/api")
    yield app.test_client()
    engine.reset_engine_for_tests()


def register(client, email="avatar@example.test"):
    response = client.post("/api/auth/register", json={"email": email, "password": "password1", "name": "Original"})
    assert response.status_code == 201
    return response.get_json()["user"]


def image_bytes(color="red", fmt="PNG", size=(640, 320)):
    output = BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Comment", "Private metadata must be stripped")
    Image.new("RGB", size, color).save(output, format=fmt, pnginfo=metadata)
    return output.getvalue()


def upload(client, content=None, **extra):
    return client.put("/api/auth/avatar", data={
        "avatar": (BytesIO(content if content is not None else image_bytes()), "untrusted-name.svg", "application/octet-stream"),
        **extra,
    })


def test_avatar_requires_auth_for_all_actions(client):
    assert upload(client).status_code == 401
    assert client.delete("/api/auth/avatar").status_code == 401
    assert client.get("/api/auth/avatar/someone/" + "a" * 64).status_code == 401


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_upload_is_normalized_and_available_in_a_second_session(client, fmt):
    user = register(client)
    assert user["avatar_url"] is None
    response = upload(client, image_bytes(fmt=fmt), name="New Name")
    assert response.status_code == 200
    account = response.get_json()["user"]
    assert account["name"] == "New Name"
    url = account["avatar_url"]
    assert url.startswith(f"/api/auth/avatar/{user['id']}/")
    assert client.get("/api/auth/me").get_json()["user"]["avatar_url"] == url
    with client.application.test_client() as second_device:
        assert second_device.get(url).status_code == 401
        second_device.post("/api/auth/login", json={"email": user["email"], "password": "password1"})
        picture = second_device.get(url)
        assert picture.status_code == 200
        assert picture.content_type == "image/png"
        assert picture.headers["X-Content-Type-Options"] == "nosniff"
        assert picture.headers["Cache-Control"] == "private, no-store"
        decoded = Image.open(BytesIO(picture.data))
        assert decoded.size == (256, 128)
        assert not decoded.info


def test_replacement_removal_and_export(client):
    register(client)
    original_url = upload(client).get_json()["user"]["avatar_url"]
    new_url = upload(client, image_bytes("blue")).get_json()["user"]["avatar_url"]
    assert new_url != original_url
    assert client.get(original_url).status_code == 404
    export = client.get("/api/me/export").get_json()["account"]["profile_picture"]
    assert export["media_type"] == "image/png"
    assert base64.b64decode(export["base64"]) == client.get(new_url).data
    removed = client.delete("/api/auth/avatar", json={"name": "Changed on removal"})
    assert removed.status_code == 200
    assert removed.get_json()["user"]["avatar_url"] is None
    assert removed.get_json()["user"]["name"] == "Changed on removal"
    assert client.get(new_url).status_code == 404
    assert "profile_picture" not in client.get("/api/me/export").get_json()["account"]
    assert client.delete("/api/auth/avatar").status_code == 200


def test_other_account_cannot_read_or_remove_a_picture(client):
    owner = register(client)
    url = upload(client).get_json()["user"]["avatar_url"]
    with client.application.test_client() as stranger:
        register(stranger, "other@example.test")
        assert stranger.get(url).status_code == 404
        assert stranger.delete("/api/auth/avatar", json={"user_id": owner["id"]}).status_code == 200
    assert client.get(url).status_code == 200


@pytest.mark.parametrize("content", [b"", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"not an image", image_bytes(fmt="GIF"), image_bytes()[:40]], ids=["empty", "svg", "garbage", "gif", "truncated"])
def test_invalid_image_does_not_change_existing_picture_or_name(client, content):
    register(client)
    url = upload(client).get_json()["user"]["avatar_url"]
    assert upload(client, content, name="Must not save").status_code == 400
    user = client.get("/api/auth/me").get_json()["user"]
    assert user["name"] == "Original"
    assert user["avatar_url"] == url
    assert client.get(url).status_code == 200


def test_oversized_body_and_file_are_rejected_before_decode(client, monkeypatch):
    register(client)
    from services import avatar_store
    monkeypatch.setattr(avatar_store, "normalize_image", lambda _: pytest.fail("must reject before decoding"))
    assert upload(client, b"x" * (avatar_store.MAX_FILE_BYTES + 1)).status_code == 413
    assert upload(client, b"x" * (avatar_store.MAX_REQUEST_BYTES + 1)).status_code == 413


def test_pixel_limit_and_animation_are_rejected(client):
    register(client)
    assert upload(client, image_bytes(size=(4001, 4000))).status_code == 400
    frames = [Image.new("RGB", (10, 10), color) for color in ("red", "blue")]
    buffer = BytesIO()
    frames[0].save(buffer, format="PNG", save_all=True, append_images=frames[1:], duration=10)
    assert upload(client, buffer.getvalue()).status_code == 400


def test_exif_rotation_is_applied_without_preserving_metadata(client):
    register(client)
    buffer = BytesIO()
    exif = Image.Exif()
    exif[274] = 6  # Camera orientation: rotate 90 degrees clockwise.
    exif[270] = "Private photo description"
    Image.new("RGB", (640, 320), "green").save(buffer, format="JPEG", exif=exif)
    url = upload(client, buffer.getvalue()).get_json()["user"]["avatar_url"]
    normalized = Image.open(BytesIO(client.get(url).data))
    assert normalized.size == (128, 256)
    assert not normalized.getexif()
    assert not normalized.info


def test_streaming_body_without_content_length_still_has_a_size_limit(client, monkeypatch):
    from werkzeug.test import EnvironBuilder
    from services import avatar_store
    register(client)
    monkeypatch.setattr(avatar_store, "normalize_image", lambda _: pytest.fail("must reject before decoding"))
    builder = EnvironBuilder(path="/api/auth/avatar", method="PUT", data={
        "avatar": (BytesIO(b"x" * (avatar_store.MAX_REQUEST_BYTES + 1)), "huge.png"),
    })
    environ = builder.get_environ()
    environ.pop("CONTENT_LENGTH", None)
    environ["wsgi.input_terminated"] = True
    try:
        assert client.open(environ).status_code == 413
    finally:
        builder.close()


def test_malformed_multipart_and_invalid_delete_name_leave_image_unchanged(client):
    register(client)
    url = upload(client).get_json()["user"]["avatar_url"]
    assert client.put("/api/auth/avatar", json={"avatar": "oops"}).status_code == 400
    assert client.put("/api/auth/avatar", data=b"broken", content_type="multipart/form-data; boundary=x").status_code == 400
    assert client.delete("/api/auth/avatar", json={"name": ["invalid"]}).status_code == 400
    assert client.get(url).status_code == 200


def test_picture_follows_account_restoration_and_final_purge(client):
    account = register(client)
    url = upload(client).get_json()["user"]["avatar_url"]
    client.delete("/api/me")
    assert client.get(url).status_code == 401
    login = client.post("/api/auth/login", json={"email": account["email"], "password": "password1"})
    assert login.get_json()["user"]["avatar_url"] == url
    assert client.get(url).status_code == 200
    client.delete("/api/me")
    from models.engine import session_scope
    from models.user import User
    from models.user_avatar import UserAvatar
    from models.job import utcnow
    from services import auth_store
    with session_scope() as session:
        session.get(User, account["id"]).deletion_requested_at = utcnow() - timedelta(days=31)
    assert auth_store.purge_expired_deletions() == 1
    with session_scope() as session:
        assert session.get(UserAvatar, account["id"]) is None
