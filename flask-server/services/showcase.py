"""Fixed eight-scan PanTS showcase, independent of general search ranking.

Selection is frozen to the original strip's rule: legacy scan-quality ordering,
sex/age diversification in96-row windows inside thumbnail tiers, then known
demographics first among the top8 candidates in each tumor cohort; take4 each,
interleaving tumor/no-tumor. An incomplete catalog exposes NO scans. No filesystem
reads occur here. Replace the cache only when the loaded catalog is replaced.
"""
from collections import Counter
import re
from threading import RLock

import pandas as pd

_QUALITY = (("__thumbnail_quality_rank", True), ("__ct_bytes", False),
            ("__voxel_count", False), ("__spacing_volume", True),
            ("__shape_sum", False), ("__spacing_sum", True), ("__case_sortkey", True))
_UNKNOWN = {"", "-", "--", "—", "n/a", "na", "none", "null", "unknown"}
_lock = RLock()
_catalog = None
_rows = pd.DataFrame()
_ids = frozenset()


def canonical_showcase_id(value):
    """Same PanTS numeric/prefix aliases as get_panTS_id; reject odd/path/user IDs."""
    match = re.fullmatch(r"(?:PanTS_?)?([0-9]{1,8})", str(value), flags=re.IGNORECASE)
    if not match or not 1 <= int(match[1]) <= 9901:
        return None
    return f"PanTS_{int(match[1]):08d}"


def _known(value):
    return pd.notna(value) and str(value).strip().lower() not in _UNKNOWN


def _age(value):
    try:
        return f"{min(max(0, int(float(value))) // 10, 9) * 10:02d}s"
    except (ValueError, TypeError, OverflowError):
        return "UNKNOWN"


def _cohort(frame):
    cols = [(c, a) for c, a in _QUALITY if c in frame]
    ranked = frame.sort_values([c for c, _ in cols], ascending=[a for _, a in cols],
                               kind="mergesort", na_position="last") if cols else frame
    tiers = ranked.groupby("__thumbnail_quality_rank", sort=False, dropna=False) if "__thumbnail_quality_rank" in ranked else [(None, ranked)]
    ordered = []
    for _, tier in tiers:
        for start in range(0, len(tier), 96):
            block = tier.iloc[start:start + 96]
            records = block.to_dict("records")
            sex = [r.get("__sex") if _known(r.get("__sex")) else "UNKNOWN" for r in records]
            age = [_age(r.get("__age")) for r in records]
            sc, ac = Counter(), Counter()
            pending = list(range(len(block)))
            while pending:
                p = min(pending, key=lambda i: (sc[sex[i]] + ac[age[i]], max(sc[sex[i]], ac[age[i]]), i))
                pending.remove(p); ordered.append(block.iloc[[p]])
                sc[sex[p]] += 1; ac[age[p]] += 1
    candidates = pd.concat(ordered).iloc[:8] if ordered else ranked.iloc[:0]
    positions = sorted(range(len(candidates)), key=lambda i: (
        not (_known(candidates.iloc[i].get("__age")) and _known(candidates.iloc[i].get("__sex"))), i))
    return candidates.iloc[positions[:4]]


def select_showcase(frame):
    if frame.empty or not {"__case_str", "__dataset", "__tumor01"} <= set(frame):
        return frame.iloc[:0].copy()
    pants = frame[frame["__dataset"] == "PanTS"].copy()
    pants["__showcase_id"] = pants["__case_str"].map(canonical_showcase_id)
    pants = pants[pants["__showcase_id"].notna()].drop_duplicates("__showcase_id")
    cohorts = [_cohort(pants[pants["__tumor01"] == t]) for t in (1, 0)]
    if any(len(c) != 4 for c in cohorts):
        return frame.iloc[:0].copy()
    return pd.concat([c.iloc[[i]] for i in range(4) for c in cohorts]).drop(columns="__showcase_id")


def refresh_showcase(frame):
    global _catalog, _rows, _ids
    with _lock:
        if frame is _catalog:
            return
        rows = select_showcase(frame)
        ids = frozenset(rows["__case_str"].map(canonical_showcase_id)) if len(rows) == 8 else frozenset()
        _catalog, _rows, _ids = frame, rows, ids


def showcase_case_ids():
    with _lock:
        return _ids


def showcase_rows():
    with _lock:
        return _rows.copy(deep=True)
