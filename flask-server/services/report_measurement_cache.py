"""Bounded, process-local cache for report measurements, never report prose.

The caller supplies identities for every measurement input (normally path, device,
inode, size, mtime_ns and ctime_ns), and computes only the existing three-dictionary
``(organ_volumes, lesions, imaging)`` result. Source reports, patient metadata and
assembled report payloads must remain outside this cache.
"""
from __future__ import annotations

import copy
import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Callable, Hashable


Measurements = tuple[dict[str, Any], dict[str, Any], dict[str, Any]]
SignatureFunction = Callable[[], Hashable]
ComputeFunction = Callable[[], Measurements]


@dataclass(frozen=True)
class _Entry:
    signature: Hashable
    measurements: Measurements
    created_at: float


@dataclass(frozen=True)
class _Flight:
    signature: Hashable
    future: Future[Measurements]


class ReportMeasurementCache:
    """LRU cache with a fixed age limit and one in-flight computation per case.

    Successful values are deep-copied into and out of the cache. Failed or missing
    inputs are not retained. A case's signature function is also checked after
    computation (and after joining a concurrent request); changed inputs raise
    ``ValueError`` so callers can report measurements as unavailable or retry.
    """

    def __init__(
        self,
        max_cases: int = 8,
        max_age_seconds: float = 120.0,
        max_payload_bytes: int = 2 * 1024 * 1024,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_cases < 1 or max_age_seconds <= 0 or max_payload_bytes < 1:
            raise ValueError("Report measurement cache limits must be positive")
        self._max_cases = max_cases
        self._max_age_seconds = max_age_seconds
        self._max_payload_bytes = max_payload_bytes
        self._clock = clock
        self._entries: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._in_flight: dict[Hashable, _Flight] = {}
        self._lock = threading.Lock()

    def _purge_expired(self, now: float) -> None:
        for key, entry in list(self._entries.items()):
            if now - entry.created_at >= self._max_age_seconds:
                del self._entries[key]

    def __len__(self) -> int:
        with self._lock:
            self._purge_expired(self._clock())
            return len(self._entries)

    @staticmethod
    def _signature(signature_func: SignatureFunction) -> Hashable:
        signature = signature_func()
        if signature is None or signature == ():
            raise ValueError("Report measurement inputs are unavailable")
        # File identities must be immutable/hashable snapshots, not mutable lists.
        hash(signature)
        return signature

    def _snapshot(self, measurements: Measurements) -> Measurements:
        if not isinstance(measurements, tuple) or len(measurements) != 3 or not all(
            isinstance(part, dict) for part in measurements
        ):
            raise ValueError("Expected only the three report measurement dictionaries")
        snapshot = copy.deepcopy(measurements)
        encoded = json.dumps(snapshot, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > self._max_payload_bytes:
            raise ValueError("Report measurement result exceeds the cache size limit")
        return snapshot

    def _invalidate(self, case_key: Hashable, signature: Hashable | None = None) -> None:
        with self._lock:
            entry = self._entries.get(case_key)
            if entry is not None and (signature is None or entry.signature == signature):
                del self._entries[case_key]

    def get_or_compute(
        self,
        case_key: Hashable,
        signature_func: SignatureFunction,
        compute_func: ComputeFunction,
    ) -> Measurements:
        """Read unchanged measurements or compute them once for concurrent callers.

        Missing inputs must cause ``signature_func`` or ``compute_func`` to raise.
        Returning ``None`` or an empty identity tuple is also treated as missing.
        Neither callbacks nor copying results run while the shared lock is held.
        """
        try:
            signature = self._signature(signature_func)
        except BaseException:
            self._invalidate(case_key)
            raise

        with self._lock:
            self._purge_expired(self._clock())
            entry = self._entries.get(case_key)
            if entry is not None and entry.signature == signature:
                self._entries.move_to_end(case_key)
                cached = entry.measurements
            else:
                cached = None
                self._entries.pop(case_key, None)
            if cached is None:
                flight = self._in_flight.get(case_key)
                leader = flight is None
                if leader:
                    flight = _Flight(signature, Future())
                    self._in_flight[case_key] = flight

        if cached is not None:
            return copy.deepcopy(cached)

        assert flight is not None
        if not leader:
            measurements = flight.future.result()
            try:
                if self._signature(signature_func) != flight.signature:
                    raise ValueError("Report measurement inputs changed during computation")
            except BaseException:
                self._invalidate(case_key, flight.signature)
                raise
            return copy.deepcopy(measurements)

        try:
            measurements = self._snapshot(compute_func())
            if self._signature(signature_func) != signature:
                raise ValueError("Report measurement inputs changed during computation")
            with self._lock:
                now = self._clock()
                self._purge_expired(now)
                self._entries[case_key] = _Entry(signature, measurements, now)
                self._entries.move_to_end(case_key)
                while len(self._entries) > self._max_cases:
                    self._entries.popitem(last=False)
                del self._in_flight[case_key]
        except BaseException as exc:
            with self._lock:
                self._in_flight.pop(case_key, None)
            flight.future.set_exception(exc)
            raise

        # Resolving a Future can execute callbacks; never do it under our lock.
        flight.future.set_result(measurements)
        return copy.deepcopy(measurements)


_cache = ReportMeasurementCache()


def get_or_compute(
    case_key: Hashable,
    signature_func: SignatureFunction,
    compute_func: ComputeFunction,
) -> Measurements:
    """Use the default eight-case, 120-second measurement cache."""
    return _cache.get_or_compute(case_key, signature_func, compute_func)
