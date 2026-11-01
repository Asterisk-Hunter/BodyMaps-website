"""A process-safe lock for a labelmap's check-and-replace transaction."""
import os
import tempfile
import threading
from contextlib import contextmanager

_locks = [threading.Lock() for _ in range(64)]


@contextmanager
def segmentation_save_lock(key):
    # The striped thread lock is bounded; the OS lock also protects multiple
    # Gunicorn workers. Files contain a lock byte, never medical data.
    with _locks[int(key[:8], 16) % len(_locks)]:
        root = os.path.join(tempfile.gettempdir(), "bodymaps-save-locks")
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, key + ".lock"), "a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
