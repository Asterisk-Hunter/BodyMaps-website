import sys
import threading

import numpy as np

import api.api_blueprint as routes


class FakeImage:
    def __init__(self, value):
        self.value = value

    def get_fdata(self, dtype):
        return np.full((2, 2, 2), self.value, dtype=dtype)


def test_interleaved_cache_misses_never_return_another_case_image(monkeypatch):
    image_a = FakeImage(1)
    image_b = FakeImage(2)
    monkeypatch.setattr(routes.nib, "load", lambda path: {"a": image_a, "b": image_b}[path])
    monkeypatch.setattr(routes, "_ct_cache", None, raising=False)
    monkeypatch.setattr(routes, "_ct_cache_key", None, raising=False)
    monkeypatch.setattr(routes, "_ct_cache_obj", None, raising=False)
    monkeypatch.setattr(routes, "_ct_cache_array", None, raising=False)

    paused_between_cache_fields = threading.Event()
    resume_a = threading.Event()
    a_finished = threading.Event()
    result_a = []

    def trace_a(frame, event, _arg):
        if (event == "line" and frame.f_code.co_name == "_load_ct_cached"
                and frame.f_globals.get("_ct_cache_key") == "case-a"
                and frame.f_globals.get("_ct_cache_obj") is not image_a):
            paused_between_cache_fields.set()
            assert resume_a.wait(3), "test did not release the paused cache writer"
        return trace_a

    def load_a():
        sys.settrace(trace_a)
        try:
            result_a.append(routes._load_ct_cached("a", "case-a"))
        finally:
            sys.settrace(None)
            a_finished.set()

    thread_a = threading.Thread(target=load_a)
    thread_a.start()
    # On the broken three-field cache, this fires after key=A but before object=A.
    # On an atomic tuple cache it does not fire; A simply finishes before B runs.
    interleaved = paused_between_cache_fields.wait(0.5)
    if not interleaved:
        assert a_finished.wait(3), "case A cache load did not finish"

    routes._load_ct_cached("b", "case-b")
    if interleaved:
        resume_a.set()
    thread_a.join(3)
    assert not thread_a.is_alive(), "case A cache load did not finish"

    cached_obj, cached_array = routes._load_ct_cached("b", "case-b")
    assert cached_obj is image_b
    np.testing.assert_array_equal(cached_array, np.full((2, 2, 2), 2, dtype=np.float32))
