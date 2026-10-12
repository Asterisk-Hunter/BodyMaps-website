#!/usr/bin/env python3
"""Fetch the pinned OpenVAE checkpoint without replacing an existing file.

Run explicitly with --destination. This helper does not change application
configuration, load a PyTorch checkpoint, start inference, or restart services.
"""

import argparse
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPOSITORY = "SMILE-project/OpenVAE"
REVISION = "d0cb74be63bcc4d59ea56e01dacbbdff0ec11e6d"
CHECKPOINT_FILE = "OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt"
EXPECTED_SIZE = 83_831_747
EXPECTED_SHA256 = "4d93e824397797fc6458ace25c9a08cad8ab3ca53e2a890ba357c3e62632adcb"
DOWNLOAD_URL = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{CHECKPOINT_FILE}"
CHUNK_BYTES = 1024 * 1024


class CheckpointError(RuntimeError):
    """The destination or downloaded bytes do not match the pinned checkpoint."""


def _huggingface_origin(url: str) -> bool:
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname == "huggingface.co"
            and parsed.port in (None, 443) and parsed.username is None and parsed.password is None)


class _CheckpointRedirectHandler(HTTPRedirectHandler):
    """Never forward Hugging Face credentials to redirected CDN hosts."""

    def redirect_request(self, request, response, code, message, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise CheckpointError("Refusing an insecure checkpoint download redirect.")
        redirected = super().redirect_request(request, response, code, message, headers, newurl)
        if redirected is not None:
            # Strip either regular or unredirected credentials first. Reattach
            # only for a redirect within the same trusted Hugging Face origin.
            redirected.remove_header("Authorization")
            authorization = request.get_header("Authorization")
            if authorization and _huggingface_origin(request.full_url) and _huggingface_origin(newurl):
                redirected.add_unredirected_header("Authorization", authorization)
        return redirected


def _open_download(request, timeout):
    return build_opener(_CheckpointRedirectHandler()).open(request, timeout=timeout)


def _existing_checkpoint(destination: Path) -> bool:
    """Return False if absent; accept only an existing matching regular file."""
    try:
        metadata = destination.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(metadata.st_mode):
        raise CheckpointError("Destination exists and is not a regular file; nothing was replaced.")
    if metadata.st_size != EXPECTED_SIZE:
        raise CheckpointError("Existing destination has a different size; nothing was replaced.")

    digest = hashlib.sha256()
    size = 0
    with destination.open("rb") as checkpoint:
        while chunk := checkpoint.read(CHUNK_BYTES):
            size += len(chunk)
            digest.update(chunk)
    if size != EXPECTED_SIZE or digest.hexdigest() != EXPECTED_SHA256:
        raise CheckpointError("Existing destination has a different SHA-256; nothing was replaced.")
    return True


def fetch_checkpoint(destination: Path) -> Path:
    """Stream, verify, and atomically publish the checkpoint without clobbering.

    A same-directory hard link publishes a complete verified file atomically
    and fails if another process creates the destination first. Unlike replace
    or POSIX rename, it cannot overwrite that process's file. Filesystems that
    do not support hard links fail safely; there is no overwrite fallback.
    """
    destination = Path(destination).expanduser().absolute()
    if _existing_checkpoint(destination):
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".openvae-", suffix=".part",
            dir=destination.parent, delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            digest = hashlib.sha256()
            size = 0
            request = Request(DOWNLOAD_URL, headers={"User-Agent": "BodyMaps-OpenVAE-checkpoint/1"})
            token = os.getenv("HF_TOKEN", "").strip()
            if token:
                if any(character.isspace() or ord(character) < 32 or ord(character) > 126 for character in token):
                    raise CheckpointError("HF_TOKEN must be a valid token without whitespace or control characters.")
                if not _huggingface_origin(request.full_url):
                    raise CheckpointError("Refusing to send HF_TOKEN outside the trusted Hugging Face origin.")
                request.add_unredirected_header("Authorization", f"Bearer {token}")
            with _open_download(request, timeout=60) as response:
                while chunk := response.read(CHUNK_BYTES):
                    size += len(chunk)
                    if size > EXPECTED_SIZE:
                        raise CheckpointError("Download exceeds the pinned checkpoint size.")
                    digest.update(chunk)
                    temporary.write(chunk)
            if size != EXPECTED_SIZE:
                raise CheckpointError(f"Download size mismatch: expected {EXPECTED_SIZE} bytes, received {size}.")
            if digest.hexdigest() != EXPECTED_SHA256:
                raise CheckpointError("Download SHA-256 mismatch; no checkpoint was published.")
            temporary.flush()
            os.fsync(temporary.fileno())

        try:
            os.link(temporary_path, destination)
        except FileExistsError:
            # A concurrent fetch of the same pinned bytes is harmless. A
            # different file must be retained and reported, never replaced.
            if not _existing_checkpoint(destination):
                raise CheckpointError("Destination changed during publication; retry the command.")
        return destination
    except HTTPError as error:
        if error.code in (401, 403):
            raise CheckpointError(
                f"Access denied (HTTP {error.code}). The OpenVAE repository is gated. "
                "Sign in at https://huggingface.co/SMILE-project/OpenVAE and obtain approved access, "
                "then provide that account's read token through HF_TOKEN and retry. "
                "This helper does not accept repository terms or request access for you."
            ) from None
        raise CheckpointError(f"Checkpoint download failed (HTTP {error.code}); no checkpoint was published.") from None
    finally:
        # Only this invocation's uniquely created temporary file is removed.
        # Keep a preexisting destination or unrelated partial downloads intact.
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path,
                        help="Explicit checkpoint file path; mismatching files are never overwritten.")
    args = parser.parse_args(argv)
    try:
        destination = fetch_checkpoint(args.destination)
    except (CheckpointError, OSError) as error:
        print(f"OpenVAE checkpoint unavailable: {error}", file=sys.stderr)
        return 1
    print(f"Verified OpenVAE checkpoint: {destination}")
    print(f"SHA-256: {EXPECTED_SHA256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
