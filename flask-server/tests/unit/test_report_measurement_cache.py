"""Synthetic cache tests; no API imports, images, source reports or network."""
from __future__ import annotations

import importlib.util
import os
import sys
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import pytest


SERVER = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "report_measurement_cache_under_test", SERVER / "services/report_measurement_cache.py"
)
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)
ReportMeasurementCache = module.ReportMeasurementCache


def measurements(volume=10):
    return (
        {"synthetic_structure": {
            "volume": volume, "mean_hu": 30.0, "status": "not_assessed",
            "centroid_mm": [1.0, 2.0, 3.0], "dimensions": [2.0, 3.0, 4.0],
            "mask_source": "segmentations/synthetic_structure.nii.gz",
        }},
        {},
        {"spacing": [1.0, 1.0, 1.0], "shape": [4, 5, 6]},
    )


def file_signature(path):
    stat = path.stat()
    return (str(path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def test_same_case_concurrent_requests_compute_once_and_receive_independent_copies():
    cache = ReportMeasurementCache()
    callers = 6
    start = threading.Barrier(callers)
    all_signed = threading.Event()
    entered = threading.Event()
    release = threading.Event()
    lock = threading.Lock()
    signed = 0
    computed = 0

    def signature():
        nonlocal signed
        with lock:
            signed += 1
            if signed >= callers:
                all_signed.set()
        return ("synthetic-input", 1)

    def compute():
        nonlocal computed
        with lock:
            computed += 1
        entered.set()
        assert release.wait(5)
        return measurements()

    def request():
        start.wait(timeout=5)
        return cache.get_or_compute("same-case", signature, compute)

    with ThreadPoolExecutor(max_workers=callers) as pool:
        futures = [pool.submit(request) for _ in range(callers)]
        try:
            assert entered.wait(5)
            assert all_signed.wait(5)
        finally:
            release.set()
        results = [future.result(timeout=5) for future in futures]
    assert computed == 1
    assert len(cache) == 1
    results[0][0]["synthetic_structure"]["centroid_mm"][0] = 999
    assert all(result[0]["synthetic_structure"]["centroid_mm"][0] == 1 for result in results[1:])


def test_different_cases_can_compute_concurrently():
    cache = ReportMeasurementCache()
    both_computing = threading.Barrier(2)

    def request(case_key):
        def compute():
            both_computing.wait(timeout=5)
            return measurements()
        return cache.get_or_compute(case_key, lambda: (case_key, 1), compute)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(request, "case-a")
        second = pool.submit(request, "case-b")
        assert first.result(timeout=5) == second.result(timeout=5)
    assert len(cache) == 2


def test_mtime_changes_invalidate_without_waiting_for_expiry(tmp_path):
    path = tmp_path / "synthetic-input.bin"
    path.write_bytes(b"synthetic")
    cache = ReportMeasurementCache()
    calls = []

    def compute():
        calls.append(True)
        return measurements(len(calls))

    first = cache.get_or_compute("case", lambda: file_signature(path), compute)
    assert cache.get_or_compute("case", lambda: file_signature(path), compute) == first
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    updated = cache.get_or_compute("case", lambda: file_signature(path), compute)
    assert updated[0]["synthetic_structure"]["volume"] == 2
    assert len(calls) == 2


def test_cached_snapshot_is_independent_of_compute_and_returned_objects():
    cache = ReportMeasurementCache()
    original = measurements()
    first = cache.get_or_compute("case", lambda: (1,), lambda: original)
    original[0]["synthetic_structure"]["volume"] = 999
    first[2]["shape"][0] = 999
    second = cache.get_or_compute("case", lambda: (1,), lambda: pytest.fail("cache miss"))
    assert second[0]["synthetic_structure"]["volume"] == 10
    assert second[2]["shape"] == [4, 5, 6]


def test_default_lru_is_bounded_to_eight_and_hits_refresh_recency():
    cache = ReportMeasurementCache()
    calls = []

    def request(case_key):
        def compute():
            calls.append(case_key)
            return measurements()
        return cache.get_or_compute(case_key, lambda: (case_key, 1), compute)

    for case_key in range(8):
        request(case_key)
    request(0)
    request(8)
    assert len(cache) == 8
    request(0)
    assert calls.count(0) == 1
    request(1)
    assert calls.count(1) == 2
    assert len(cache) == 8


def test_default_age_expires_after_120_seconds_without_sliding_on_hits():
    now = [0.0]
    cache = ReportMeasurementCache(clock=lambda: now[0])
    calls = []

    def compute():
        calls.append(True)
        return measurements(len(calls))

    cache.get_or_compute("case", lambda: (1,), compute)
    now[0] = 119.0
    cache.get_or_compute("case", lambda: (1,), compute)
    assert len(calls) == 1
    now[0] = 120.0
    assert len(cache) == 0
    assert cache.get_or_compute("case", lambda: (1,), compute)[0]["synthetic_structure"]["volume"] == 2


def test_failed_computation_is_not_retained_and_can_retry():
    cache = ReportMeasurementCache()

    def fail():
        raise FileNotFoundError("synthetic missing mask")

    with pytest.raises(FileNotFoundError):
        cache.get_or_compute("case", lambda: (1,), fail)
    assert len(cache) == 0
    assert cache.get_or_compute("case", lambda: (1,), measurements) == measurements()


def test_failed_singleflight_releases_waiters_and_allows_a_later_retry(monkeypatch):
    cache = ReportMeasurementCache()
    waiting = threading.Event()
    release = threading.Event()
    wait_count = 0
    compute_count = 0
    lock = threading.Lock()

    class ObservedFuture(Future):
        def result(self, timeout=None):
            nonlocal wait_count
            with lock:
                wait_count += 1
                if wait_count == 2:
                    waiting.set()
            return super().result(timeout)

    monkeypatch.setattr(module, "Future", ObservedFuture)

    def fail():
        nonlocal compute_count
        compute_count += 1
        assert release.wait(5)
        raise ValueError("synthetic compute failure")

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(cache.get_or_compute, "case", lambda: (1,), fail) for _ in range(3)]
        try:
            assert waiting.wait(5)
        finally:
            release.set()
        for future in futures:
            with pytest.raises(ValueError, match="synthetic compute failure"):
                future.result(timeout=5)
    assert compute_count == 1
    assert len(cache) == 0
    assert cache.get_or_compute("case", lambda: (1,), measurements) == measurements()


@pytest.mark.parametrize("missing_signature", [None, ()])
def test_missing_signature_does_not_compute_or_leave_cached_values(missing_signature):
    cache = ReportMeasurementCache()
    cache.get_or_compute("case", lambda: (1,), measurements)
    with pytest.raises(ValueError, match="unavailable"):
        cache.get_or_compute("case", lambda: missing_signature, lambda: pytest.fail("must not compute"))
    assert len(cache) == 0


def test_removed_input_does_not_serve_stale_measurements(tmp_path):
    path = tmp_path / "synthetic-input.bin"
    path.write_bytes(b"synthetic")
    cache = ReportMeasurementCache()
    cache.get_or_compute("case", lambda: file_signature(path), measurements)
    path.unlink()
    with pytest.raises(FileNotFoundError):
        cache.get_or_compute("case", lambda: file_signature(path), measurements)
    assert len(cache) == 0


def test_inputs_changed_during_compute_raise_and_are_not_cached():
    cache = ReportMeasurementCache()
    version = [1]

    def changed_compute():
        version[0] += 1
        return measurements()

    with pytest.raises(ValueError, match="changed during computation"):
        cache.get_or_compute("case", lambda: tuple(version), changed_compute)
    assert len(cache) == 0
    assert cache.get_or_compute("case", lambda: tuple(version), measurements) == measurements()


@pytest.mark.parametrize("invalid", [{"source_report": "not a measurement tuple"}, ({}, {}), ({}, [], {})])
def test_full_reports_and_invalid_result_shapes_are_not_cached(invalid):
    cache = ReportMeasurementCache()
    with pytest.raises(ValueError, match="three report measurement dictionaries"):
        cache.get_or_compute("case", lambda: (1,), lambda: invalid)
    assert len(cache) == 0


def test_oversized_results_are_not_retained_and_can_retry():
    cache = ReportMeasurementCache(max_payload_bytes=512)
    oversized = measurements()
    oversized[0]["synthetic_structure"]["mask_source"] = "x" * 600
    with pytest.raises(ValueError, match="size limit"):
        cache.get_or_compute("case", lambda: (1,), lambda: oversized)
    assert len(cache) == 0
    assert cache.get_or_compute("case", lambda: (1,), measurements) == measurements()
