"""Bounded, owner-bound copies of original catalog scans for the Sample action."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
import uuid
from contextlib import contextmanager, nullcontext

try:
    import fcntl
except ModuleNotFoundError:
    fcntl = None
    import msvcrt

import nibabel as nib
import numpy as np

from services.search_ranking import SAMPLE_MAX_CT_BYTES


MAX_PENDING = 3
TTL_SECONDS = 3600
TARGET = "BDMAP_SAMPLE/ct.nii.gz"
MARKER = ".sample-staging"
MANIFEST = ".sample.json"


class SampleError(Exception):
    def __init__(self, message, code, status):
        super().__init__(message)
        self.code, self.status = code, status


def validate_session_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise SampleError("Invalid sample session ID.", "invalid_session", 400)
    return value


class SampleStager:
    def __init__(self, root, user_id, *, busy=lambda sid: False, consumed=lambda sid: False,
                 cleanup_guard=nullcontext):
        self.root = Path(root).resolve()
        self.user = str(user_id)
        self.bucket = self.root / ".sample-reservations" / hashlib.sha256(self.user.encode()).hexdigest()
        self.busy = busy
        self.consumed = consumed
        self.cleanup_guard = cleanup_guard

    def folder(self, session_id):
        validate_session_id(session_id)
        folder = self.root / session_id
        if folder.is_symlink() or (folder.exists() and folder.resolve().parent != self.root):
            raise SampleError("You do not have access to this sample.", "sample_forbidden", 403)
        return folder

    def owned(self, folder):
        if not folder.exists():
            return False
        owner = folder / ".owner"
        if owner.is_symlink():
            raise SampleError("You do not have access to this sample.", "sample_forbidden", 403)
        try:
            value = owner.read_text(encoding="utf-8").strip()
        except OSError:
            raise SampleError("This session is already in use.", "sample_conflict", 409)
        if value != self.user:
            raise SampleError("You do not have access to this sample.", "sample_forbidden", 403)
        if not (folder / MARKER).is_file():
            raise SampleError("This session is already in use.", "sample_conflict", 409)
        return True

    def result(self, session_id):
        folder = self.folder(session_id)
        if not self.owned(folder):
            return None
        if (folder / ".cancelled").exists():
            raise SampleError("Sample preparation was cancelled.", "sample_cancelled", 409)
        try:
            record = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            raise SampleError("The staged sample is unavailable. Please choose Sample again.", "sample_unavailable", 503)
        path = folder / TARGET
        if path.is_symlink() or path.parent.is_symlink() or not path.is_file() or path.stat().st_size != record.get("size"):
            raise SampleError("The staged sample is unavailable. Please choose Sample again.", "sample_unavailable", 503)
        # Only these public fields leave the service; never publish local paths or owners.
        return {"status": "combined", "session_id": session_id, "uploaded_filename": TARGET,
                "file_name": record["file_name"], "size": record["size"], "case_id": record["case_id"],
                "bdmap_id": "BDMAP_SAMPLE", "preview_url": f"/api/session-ct/{session_id}"}

    def _slots(self):
        if not self.bucket.exists():
            return []
        slots = []
        for number in range(MAX_PENDING):
            path = self.bucket / str(number)
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                slots.append((path, record, path.stat().st_mtime))
            except FileNotFoundError:
                pass
            except (OSError, ValueError):
                # An in-progress reservation must still consume a slot.
                slots.append((path, {}, time.time()))
        return slots

    @contextmanager
    def _bookkeeping(self):
        """Serialize this account's reservation and claim mutations across workers.

        Never acquire the admission lock while holding this file lock. Copies run
        outside it; only the three reservation slots and local claim files use it.
        """
        self.bucket.mkdir(parents=True, exist_ok=True)
        with (self.bucket / ".lock").open("a+b") as lock:
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            else:
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                else:
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)

    def _release_unlocked(self, session_id):
        for path, record, _ in self._slots():
            if record.get("session_id") == session_id:
                path.unlink(missing_ok=True)

    def expire(self):
        # Lock order is always admission -> reservation. Read slot identities
        # under both locks so cleanup cannot remove a newly reused slot.
        with self.cleanup_guard(), self._bookkeeping():
            for slot, record, modified in self._slots():
                sid = record.get("session_id")
                if not sid:
                    continue
                if self.busy(sid) or (time.time() - modified < TTL_SECONDS and not self.consumed(sid)):
                    continue
                folder = self.folder(sid)
                if self.owned(folder):
                    shutil.rmtree(folder)
                slot.unlink(missing_ok=True)

    def _reserve_unlocked(self, session_id):
        if any(record.get("session_id") == session_id for _, record, _ in self._slots()):
            return
        for number in range(MAX_PENDING):
            try:
                with (self.bucket / str(number)).open("x", encoding="utf-8") as handle:
                    json.dump({"session_id": session_id}, handle)
                return
            except FileExistsError:
                continue
        raise SampleError("Remove an unused sample before choosing another.", "sample_staging_limit", 429)

    def prepare(self, session_id, candidates):
        folder = self.folder(session_id)
        existing = self.result(session_id)
        if existing:
            return {**existing, "reused": True}
        self.expire()
        lock = folder / ".sample-preparing"
        with self._bookkeeping():
            existing = self.result(session_id)
            if existing:
                return {**existing, "reused": True}
            self._reserve_unlocked(session_id)
            created = False
            try:
                try:
                    folder.mkdir(parents=True, exist_ok=False)
                    created = True
                    with (folder / ".owner").open("x", encoding="utf-8") as handle:
                        handle.write(self.user)
                    (folder / MARKER).touch(exist_ok=False)
                except FileExistsError:
                    self.owned(folder)
                # DELETE cannot see an incomplete claim: owner, marker and
                # preparation lock are established in the same critical section.
                if lock.exists():
                    raise SampleError("Sample preparation is already in progress.", "sample_preparing", 409)
                lock.touch(exist_ok=False)
            except Exception:
                if created:
                    shutil.rmtree(folder)
                if created or not lock.exists():
                    self._release_unlocked(session_id)
                raise
        successful = False
        try:
            # A concurrent request can have completed before this lock was obtained.
            existing = self.result(session_id)
            if existing:
                successful = True
                return {**existing, "reused": True}
            destination = folder / TARGET
            destination.parent.mkdir(exist_ok=True)
            for case_id, source, allowed_root in candidates():
                if not re.fullmatch(r"(?:PanTS|CV)_[0-9]{8}", case_id):
                    continue
                partial = destination.parent / f"partial-{uuid.uuid4().hex}.nii.gz"
                try:
                    original = Path(source).resolve(strict=True)
                    if not original.is_relative_to(Path(allowed_root).resolve()):
                        continue
                    candidate = original.stat()
                    if not stat.S_ISREG(candidate.st_mode) or not 0 < candidate.st_size <= SAMPLE_MAX_CT_BYTES:
                        continue
                    with original.open("rb") as incoming:
                        before = os.fstat(incoming.fileno())
                        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= SAMPLE_MAX_CT_BYTES:
                            continue
                        copied = 0
                        with partial.open("xb") as outgoing:
                            while block := incoming.read(1024 * 1024):
                                if (folder / ".cancelled").exists():
                                    raise SampleError("Sample preparation was cancelled.", "sample_cancelled", 409)
                                copied += len(block)
                                if copied > SAMPLE_MAX_CT_BYTES:
                                    raise ValueError("Original scan grew beyond the sample limit")
                                outgoing.write(block)
                            outgoing.flush()
                            os.fsync(outgoing.fileno())
                        after = os.fstat(incoming.fileno())
                        if copied != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                            raise ValueError("Original scan changed during copy")
                    image = nib.load(str(partial))
                    if len(image.shape) < 3 or any(v <= 1 for v in image.shape[:3]) or any(v > 1 for v in image.shape[3:]) or not np.isfinite(image.affine).all():
                        raise ValueError("Sample is not a usable 3D CT")
                    if (folder / ".cancelled").exists():
                        raise SampleError("Sample preparation was cancelled.", "sample_cancelled", 409)
                    os.replace(partial, destination)
                    record = {"case_id": case_id, "file_name": f"{case_id}.nii.gz", "size": copied}
                    pending = folder / (MANIFEST + ".partial")
                    pending.write_text(json.dumps(record), encoding="utf-8")
                    os.replace(pending, folder / MANIFEST)
                    result = self.result(session_id)  # Recheck cancellation after publication.
                    successful = True
                    return {**result, "reused": False}
                except (OSError, ValueError, nib.filebasedimages.ImageFileError):
                    continue
                finally:
                    partial.unlink(missing_ok=True)
            raise SampleError("No compact sample is currently available. Please try again later.", "sample_unavailable", 503)
        finally:
            with self._bookkeeping():
                lock.unlink(missing_ok=True)
                if not successful:
                    if folder.exists() and self.owned(folder):
                        shutil.rmtree(folder)
                    self._release_unlocked(session_id)

    def delete(self, session_id):
        folder = self.folder(session_id)
        with self._bookkeeping():
            if not self.owned(folder):
                self._release_unlocked(session_id)
                return
            if self.busy(session_id):
                raise SampleError("This sample is already attached to inference.", "sample_in_use", 409)
            if (folder / ".sample-preparing").exists():
                (folder / ".cancelled").touch(exist_ok=True)
                return
            shutil.rmtree(folder)
            self._release_unlocked(session_id)
