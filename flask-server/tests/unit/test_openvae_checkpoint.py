"""Pinned weight download, corruption handling, and atomic no-clobber publish."""

import hashlib
import importlib.util
import io
from pathlib import Path
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import Request

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "fetch_openvae_checkpoint.py"
spec = importlib.util.spec_from_file_location("fetch_openvae_checkpoint", SCRIPT)
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


@pytest.fixture
def download(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    payload = b"a small, verified OpenVAE checkpoint fixture"
    monkeypatch.setattr(checkpoint, "EXPECTED_SIZE", len(payload))
    monkeypatch.setattr(checkpoint, "EXPECTED_SHA256", hashlib.sha256(payload).hexdigest())
    monkeypatch.setattr(checkpoint, "CHUNK_BYTES", 7)
    opener = Mock(side_effect=lambda *args, **kwargs: io.BytesIO(payload))
    monkeypatch.setattr(checkpoint, "_open_download", opener)
    return payload, opener


def test_pinned_official_artifact():
    assert checkpoint.REPOSITORY == "SMILE-project/OpenVAE"
    assert checkpoint.REVISION == "d0cb74be63bcc4d59ea56e01dacbbdff0ec11e6d"
    assert checkpoint.CHECKPOINT_FILE == "OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt"
    assert checkpoint.EXPECTED_SIZE == 83_831_747
    assert checkpoint.EXPECTED_SHA256 == "4d93e824397797fc6458ace25c9a08cad8ab3ca53e2a890ba357c3e62632adcb"


def test_streams_verified_file_then_publishes_atomically(tmp_path, download, monkeypatch):
    payload, opener = download
    destination = tmp_path / "weights" / "autoencoder_best.pt"
    real_link = checkpoint.os.link

    def publish(source, target):
        assert Path(source).parent == destination.parent
        assert Path(source).read_bytes() == payload
        assert not destination.exists()
        real_link(source, target)

    monkeypatch.setattr(checkpoint.os, "link", publish)
    assert checkpoint.fetch_checkpoint(destination) == destination
    assert destination.read_bytes() == payload
    assert list(destination.parent.iterdir()) == [destination]
    request = opener.call_args.args[0]
    assert request.full_url == checkpoint.DOWNLOAD_URL
    assert checkpoint.REVISION in request.full_url
    assert opener.call_args.kwargs["timeout"] == 60


def test_existing_verified_checkpoint_needs_no_network(tmp_path, download):
    payload, opener = download
    destination = tmp_path / "autoencoder_best.pt"
    destination.write_bytes(payload)
    assert checkpoint.fetch_checkpoint(destination) == destination
    opener.assert_not_called()
    assert destination.read_bytes() == payload


@pytest.mark.parametrize("same_size", [False, True])
def test_existing_mismatched_file_is_not_replaced(tmp_path, download, same_size):
    payload, opener = download
    destination = tmp_path / "autoencoder_best.pt"
    original = b"x" * len(payload) if same_size else b"existing checkpoint"
    destination.write_bytes(original)
    with pytest.raises(checkpoint.CheckpointError, match="nothing was replaced"):
        checkpoint.fetch_checkpoint(destination)
    assert destination.read_bytes() == original
    opener.assert_not_called()


@pytest.mark.parametrize("bad_data", ["truncated", "oversized", "same_size_corrupt"])
def test_bad_download_never_publishes_and_removes_only_own_temp(tmp_path, download, bad_data):
    payload, opener = download
    data = payload[:-1] if bad_data == "truncated" else payload + b"x" if bad_data == "oversized" else b"x" * len(payload)
    opener.side_effect = lambda *args, **kwargs: io.BytesIO(data)
    destination = tmp_path / "autoencoder_best.pt"
    unrelated = tmp_path / ".openvae-unrelated.part"
    unrelated.write_bytes(b"another invocation")
    with pytest.raises(checkpoint.CheckpointError):
        checkpoint.fetch_checkpoint(destination)
    assert not destination.exists()
    assert list(tmp_path.iterdir()) == [unrelated]
    assert unrelated.read_bytes() == b"another invocation"


@pytest.mark.parametrize("failure", [OSError("connection interrupted"), KeyboardInterrupt()])
def test_interrupted_stream_cleans_up(tmp_path, download, failure):
    payload, opener = download

    class InterruptedStream(io.BytesIO):
        def read(self, size):
            if self.tell():
                raise failure
            return super().read(size)

    opener.side_effect = lambda *args, **kwargs: InterruptedStream(payload)
    with pytest.raises(type(failure)):
        checkpoint.fetch_checkpoint(tmp_path / "autoencoder_best.pt")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("same_checkpoint", [False, True])
def test_competing_publication_never_overwrites_destination(tmp_path, download, monkeypatch, same_checkpoint):
    payload, _ = download
    destination = tmp_path / "autoencoder_best.pt"
    competing_data = payload if same_checkpoint else b"a different writer's file"
    real_link = checkpoint.os.link

    def publish_with_race(source, target):
        destination.write_bytes(competing_data)
        real_link(source, target)

    monkeypatch.setattr(checkpoint.os, "link", publish_with_race)
    if same_checkpoint:
        assert checkpoint.fetch_checkpoint(destination) == destination
    else:
        with pytest.raises(checkpoint.CheckpointError):
            checkpoint.fetch_checkpoint(destination)
    assert destination.read_bytes() == competing_data
    assert list(tmp_path.iterdir()) == [destination]


def test_filesystem_without_atomic_link_fails_without_partial_destination(tmp_path, download, monkeypatch):
    monkeypatch.setattr(checkpoint.os, "link", Mock(side_effect=OSError("hard links unavailable")))
    with pytest.raises(OSError, match="hard links unavailable"):
        checkpoint.fetch_checkpoint(tmp_path / "autoencoder_best.pt")
    assert list(tmp_path.iterdir()) == []


def test_non_file_destination_is_preserved(tmp_path, download):
    _, opener = download
    destination = tmp_path / "model-directory"
    destination.mkdir()
    with pytest.raises(checkpoint.CheckpointError, match="not a regular file"):
        checkpoint.fetch_checkpoint(destination)
    assert destination.is_dir()
    opener.assert_not_called()


def test_cli_requires_explicit_destination(download):
    _, opener = download
    with pytest.raises(SystemExit) as error:
        checkpoint.main([])
    assert error.value.code == 2
    opener.assert_not_called()


def test_optional_token_only_added_as_unredirected_header(tmp_path, download, monkeypatch, capsys):
    _, opener = download
    monkeypatch.setenv("HF_TOKEN", "hf_test_read_token")
    assert checkpoint.main(["--destination", str(tmp_path / "autoencoder_best.pt")]) == 0
    request = opener.call_args.args[0]
    assert request.get_header("Authorization") == "Bearer hf_test_read_token"
    assert "Authorization" not in request.headers
    assert "hf_test_read_token" not in repr(capsys.readouterr())


def test_no_token_sends_no_authorization(tmp_path, download):
    _, opener = download
    checkpoint.fetch_checkpoint(tmp_path / "autoencoder_best.pt")
    assert opener.call_args.args[0].get_header("Authorization") is None


@pytest.mark.parametrize("url,retained", [
    ("https://huggingface.co/api/resolve-cache/models/checkpoint", True),
    ("https://huggingface.co:443/another-location", True),
    ("https://cdn-lfs.huggingface.co/weights?signed=value", False),
    ("https://cas-bridge.xethub.hf.co/weights?signed=value", False),
    ("https://huggingface.co.evil.example/weights", False),
    ("https://huggingface.co:444/weights", False),
    ("https://user@huggingface.co/weights", False),
])
@pytest.mark.parametrize("unredirected", [False, True])
def test_redirect_auth_stays_on_exact_trusted_origin(url, retained, unredirected):
    request = Request(checkpoint.DOWNLOAD_URL)
    add_header = request.add_unredirected_header if unredirected else request.add_header
    add_header("Authorization", "Bearer hf_test_read_token")
    redirected = checkpoint._CheckpointRedirectHandler().redirect_request(request, None, 302, "Found", {}, url)
    assert redirected.get_header("Authorization") == ("Bearer hf_test_read_token" if retained else None)


def test_redirect_does_not_restore_token_after_leaving_trusted_origin():
    request = Request("https://cdn.example/weights")
    request.add_header("Authorization", "Bearer unexpected-token")
    redirected = checkpoint._CheckpointRedirectHandler().redirect_request(
        request, None, 302, "Found", {}, "https://huggingface.co/weights")
    assert redirected.get_header("Authorization") is None


def test_insecure_redirect_is_refused():
    with pytest.raises(checkpoint.CheckpointError, match="insecure"):
        checkpoint._CheckpointRedirectHandler().redirect_request(
            Request(checkpoint.DOWNLOAD_URL), None, 302, "Found", {}, "http://cdn.example/weights")


@pytest.mark.parametrize("status", [401, 403])
def test_gated_error_explains_access_without_response_or_token(tmp_path, download, monkeypatch, capsys, status):
    _, opener = download
    monkeypatch.setenv("HF_TOKEN", "hf_test_read_token")
    opener.side_effect = HTTPError(checkpoint.DOWNLOAD_URL, status, "hf_test_read_token private response", {}, None)
    assert checkpoint.main(["--destination", str(tmp_path / "autoencoder_best.pt")]) == 1
    message = capsys.readouterr().err
    assert "gated" in message and "approved access" in message and "HF_TOKEN" in message
    assert "hf_test_read_token" not in message and "private response" not in message
    assert list(tmp_path.iterdir()) == []


def test_invalid_token_is_rejected_without_leaking_it(tmp_path, download, monkeypatch, capsys):
    _, opener = download
    monkeypatch.setenv("HF_TOKEN", "hf_secret\r\ninjected")
    assert checkpoint.main(["--destination", str(tmp_path / "autoencoder_best.pt")]) == 1
    assert "hf_secret" not in capsys.readouterr().err
    opener.assert_not_called()
    assert list(tmp_path.iterdir()) == []


def test_download_uses_explicit_redirect_handler(monkeypatch):
    opener = Mock()
    build = Mock(return_value=opener)
    monkeypatch.setattr(checkpoint, "build_opener", build)
    request = Request(checkpoint.DOWNLOAD_URL)
    checkpoint._open_download(request, timeout=60)
    assert isinstance(build.call_args.args[0], checkpoint._CheckpointRedirectHandler)
    opener.open.assert_called_once_with(request, timeout=60)
