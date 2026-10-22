"""Statistics over the combined case catalog (PanTS + CancerVerse + AbdomenAtlas).

``compute_stats`` takes the catalog frame the library already searches (after the caller has applied the
visitor's filters) and returns one JSON-ready dict for the Statistics page: counts per contrast phase, sex,
age, scanner, year, country, tumor, slice thickness and coverage, each split by dataset, plus how many scans
actually carry that field. The three datasets record very different things (AbdomenAtlas names the scanner on
5% of its scans, PanTS gives a year for 28%), so every block states how many scans it is drawn from and the
page prints that next to the chart; a chart never pretends the missing scans are zero.

Pure pandas, no file, network or request access, and nothing per scan: only counts and summary numbers, so
no patient-level field (id, report, dates) can leave through here.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

import numpy as np
import pandas as pd

SCHEMA = "stats-v1"
DATASETS = ("PanTS", "CancerVerse", "AbdomenAtlas")
PHASE_ORDER = ("Non-contrast", "Arterial", "Venous", "Delayed", "Other")
AGE_BIN_WIDTH = 5
AGE_BIN_TOP = 100                 # the last bin is "100+"
MAX_PLAUSIBLE_AGE = 120
TOP_MANUFACTURERS = 6
TOP_MODELS = 8
MANUFACTURER_LABELS = {"ge medical systems": "GE HealthCare", "toshiba": "Canon (Toshiba)"}
UNKNOWN_TOKENS = frozenset({"", "unknown", "nan", "none", "n/a", "na", "(blank)", "(null)", "<na>"})

# (upper bound inclusive, label): a slice thickness is put in the first bin whose bound it does not exceed.
SLICE_BINS = ((1.0, "≤ 1 mm"), (2.0, "1–2 mm"), (3.0, "2–3 mm"), (5.0, "3–5 mm"), (float("inf"), "> 5 mm"))
# z-extent in cm (slices x slice spacing); lower bound inclusive.
COVERAGE_BINS = ((0, "< 20 cm"), (20, "20–30 cm"), (30, "30–40 cm"), (40, "40–50 cm"),
                 (50, "50–60 cm"), (60, "60–80 cm"), (80, "≥ 80 cm"))

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
_NON_CONTRAST = re.compile(r"non[\s_-]?contrast|plain|unenhanced|native|pre[\s_-]?contrast")


# ---------------------------------------------------------------------------------------------- helpers
def _num(value: Any) -> Optional[float]:
    """A plain float, or None for NaN / inf / non-numbers (JSON has no NaN)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _int(value: Any) -> int:
    return int(value)


def _flags(series: pd.Series, test: Callable[[Any], Any]) -> pd.Series:
    """A real bool Series of ``test`` over ``series``. (``Series.map`` on an empty series gives an object
    column whose sum is '', which is what an empty filter result would have tripped over.)"""
    return pd.Series([bool(test(v)) for v in series], index=series.index, dtype=bool)


def _is_known(value: Any) -> bool:
    if value is None:
        return False
    try:
        if pd.isna(value):
            return False
    except (TypeError, ValueError):
        pass
    return str(value).strip().lower() not in UNKNOWN_TOKENS


def _dataset_series(df: pd.DataFrame) -> pd.Series:
    if "__dataset" in df.columns:
        return df["__dataset"].where(df["__dataset"].isin(DATASETS), "PanTS").astype(str)
    return pd.Series(["PanTS"] * len(df), index=df.index)


def _blank_split() -> Dict[str, int]:
    return {name: 0 for name in DATASETS}


def _split_counts(mask: pd.Series, datasets: pd.Series) -> Dict[str, int]:
    """Scans per dataset where ``mask`` is true."""
    counts = datasets[mask].value_counts()
    return {name: _int(counts.get(name, 0)) for name in DATASETS}


def _rows_from_tally(tally: Dict[str, Dict[str, int]], order: Optional[Sequence[str]] = None,
                     label: Optional[Callable[[str], str]] = None) -> List[Dict[str, Any]]:
    keys = list(order) if order is not None else sorted(tally, key=lambda k: (-sum(tally[k].values()), str(k)))
    rows = []
    for key in keys:
        split = _blank_split()
        split.update(tally.get(key, {}))
        rows.append({"key": key, "label": label(key) if label else key, "count": sum(split.values()), "datasets": split})
    return rows


def _tally_lists(lists: Iterable[Iterable[str]], datasets: Iterable[str]) -> Dict[str, Dict[str, int]]:
    """{item: {dataset: scans}}; a scan counts once per distinct item it carries."""
    tally: Dict[str, Dict[str, int]] = {}
    for items, dataset in zip(lists, datasets):
        for item in set(items):
            slot = tally.setdefault(item, {})
            slot[dataset] = slot.get(dataset, 0) + 1
    return tally


def _coverage(known: int, total: int) -> Dict[str, Any]:
    return {"recorded": known, "total": total, "not_reported": total - known,
            "share": round(known / total, 4) if total else None}


def _summary(values: pd.Series) -> Dict[str, Optional[float]]:
    clean = values.dropna().astype(float)
    if clean.empty:
        return {"median": None, "q1": None, "q3": None, "mean": None, "min": None, "max": None}
    q1, med, q3 = np.percentile(clean, [25, 50, 75])
    return {"median": _num(med), "q1": _num(q1), "q3": _num(q3), "mean": _num(clean.mean()),
            "min": _num(clean.min()), "max": _num(clean.max())}


def phase_tokens(value: Any) -> List[str]:
    """The contrast phases a raw phase string names, in the site's four-phase vocabulary; ``Other`` for a
    value that names none of them; empty for blank / unknown."""
    if not _is_known(value):
        return []
    text = str(value).strip().lower()
    found = []
    if _NON_CONTRAST.search(text):
        found.append("Non-contrast")
    if "arter" in text:
        found.append("Arterial")
    if "venous" in text or "portal" in text:
        found.append("Venous")
    if re.search(r"delay|excret|equilib", text):
        found.append("Delayed")
    return found or ["Other"]


def _floats(value: Any) -> List[float]:
    return [float(x) for x in _NUMBER.findall(str(value))] if _is_known(value) else []


def _triplet(value: Any) -> Optional[List[float]]:
    numbers = _floats(value)
    return numbers[:3] if len(numbers) >= 3 else None


# ---------------------------------------------------------------------------------------------- blocks
def _datasets_block(datasets: pd.Series) -> List[Dict[str, Any]]:
    counts = datasets.value_counts()
    return [{"key": name, "count": _int(counts.get(name, 0))} for name in DATASETS]


def _tumor_block(df: pd.DataFrame, datasets: pd.Series, type_label: Callable[[str], str]) -> Dict[str, Any]:
    flag = pd.to_numeric(df["__tumor01"], errors="coerce") if "__tumor01" in df.columns else pd.Series(np.nan, index=df.index)
    types = df["__tumor_types"] if "__tumor_types" in df.columns else pd.Series([()] * len(df), index=df.index)
    lists = [list(t) if isinstance(t, (tuple, list, set)) else [] for t in types]
    tally = _tally_lists(lists, datasets)
    return {
        "with_tumor": _split_counts(flag == 1, datasets),
        "without_tumor": _split_counts(flag == 0, datasets),
        "unknown": _split_counts(flag.isna(), datasets),
        "types": _rows_from_tally(tally, label=type_label),
        **_coverage(_int(flag.notna().sum()), len(df)),
    }


def _phase_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    raw = df["__ct"] if "__ct" in df.columns else pd.Series([""] * len(df), index=df.index)
    lists = [phase_tokens(v) for v in raw]
    tally = _tally_lists(lists, datasets)
    order = [p for p in PHASE_ORDER if p in tally or p != "Other"]
    known = sum(1 for items in lists if items)
    return {"rows": _rows_from_tally(tally, order=order), **_coverage(known, len(df))}


def _sex_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    sex = df["__sex"].fillna("").astype(str).str.strip().str.upper() if "__sex" in df.columns else pd.Series([""] * len(df), index=df.index)
    tally = {key: _split_counts(sex == key, datasets) for key in ("M", "F")}
    male, female = sum(tally["M"].values()), sum(tally["F"].values())
    rows = _rows_from_tally(tally, order=("M", "F"), label=lambda k: {"M": "Male", "F": "Female"}[k])
    ratio = None
    if male + female:
        ratio = {"male_percent": round(100 * male / (male + female), 1), "female_percent": round(100 * female / (male + female), 1)}
    return {"rows": rows, "ratio": ratio, **_coverage(male + female, len(df))}


def _age_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    age = pd.to_numeric(df["__age"], errors="coerce") if "__age" in df.columns else pd.Series(np.nan, index=df.index)
    plausible = age.where((age >= 0) & (age <= MAX_PLAUSIBLE_AGE))
    implausible = _int(age.notna().sum() - plausible.notna().sum())
    edges = list(range(0, AGE_BIN_TOP, AGE_BIN_WIDTH))
    bins = []
    for lo in edges:
        hi = lo + AGE_BIN_WIDTH - 1
        last = lo == edges[-1]
        mask = plausible >= lo if last else plausible.between(lo, lo + AGE_BIN_WIDTH - 1e-9, inclusive="left")
        bins.append({"lo": lo, "hi": None if last else hi, "label": f"{lo}+" if last else f"{lo}–{hi}",
                     "count": _int(mask.sum()), "datasets": _split_counts(mask.fillna(False), datasets)})
    return {"bins": bins, "bin_width": AGE_BIN_WIDTH, **_summary(plausible), "under_15": _int((plausible < 15).sum()),
            "implausible": implausible, **_coverage(_int(plausible.notna().sum()), len(df))}


def _top_rows(values: pd.Series, datasets: pd.Series, limit: int, label: Callable[[str], str]) -> List[Dict[str, Any]]:
    known = _flags(values, _is_known)
    names = values[known].astype(str).str.strip()
    tally: Dict[str, Dict[str, int]] = {}
    for name, dataset in zip(names, datasets[known]):
        slot = tally.setdefault(name, {})
        slot[dataset] = slot.get(dataset, 0) + 1
    ranked = sorted(tally, key=lambda k: (-sum(tally[k].values()), k))
    rows = _rows_from_tally(tally, order=ranked[:limit], label=label)
    rest = ranked[limit:]
    if rest:
        other = _blank_split()
        for key in rest:
            for dataset, count in tally[key].items():
                other[dataset] += count
        rows.append({"key": "__other__", "label": "Other", "count": sum(other.values()), "datasets": other})
    return rows


def _manufacturer_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    values = df["__mfr"] if "__mfr" in df.columns else pd.Series([""] * len(df), index=df.index)
    rows = _top_rows(values, datasets, TOP_MANUFACTURERS, lambda k: MANUFACTURER_LABELS.get(k.lower(), k))
    return {"rows": rows, **_coverage(_int(_flags(values, _is_known).sum()), len(df))}


def _model_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    values = df["model"] if "model" in df.columns else pd.Series([""] * len(df), index=df.index)
    return {"rows": _top_rows(values, datasets, TOP_MODELS, lambda k: k),
            **_coverage(_int(_flags(values, _is_known).sum()), len(df))}


def _year_block(df: pd.DataFrame, datasets: pd.Series) -> Dict[str, Any]:
    year = pd.to_numeric(df["__year_int"], errors="coerce") if "__year_int" in df.columns else pd.Series(np.nan, index=df.index)
    year = year.where((year >= 1980) & (year <= 2100))
    # PanTS writes a release range ("2012; 2016; 2020") into the year field of some sites; those do not
    # parse to a number and are left out of the chart, but the page says how many there are.
    raw = df["study year"] if "study year" in df.columns else pd.Series([""] * len(df), index=df.index)
    range_only = _int(_flags(raw, lambda v: _is_known(v) and len(re.findall(r"(?:19|20)\d\d", str(v))) > 1).sum())
    counts = year.dropna().astype(int).value_counts()
    rows = []
    if len(counts):
        for y in range(int(counts.index.min()), int(counts.index.max()) + 1):
            mask = year == y
            rows.append({"year": y, "count": _int(counts.get(y, 0)), "datasets": _split_counts(mask, datasets)})
    return {"rows": rows, "range_only": range_only, **_coverage(_int(year.notna().sum()), len(df))}


def _country_block(df: pd.DataFrame, datasets: pd.Series, country_label: Callable[[str], str]) -> Dict[str, Any]:
    tokens = df["__sn_tokens"] if "__sn_tokens" in df.columns else pd.Series([()] * len(df), index=df.index)
    lists = [list(t) if isinstance(t, (tuple, list, set)) else [] for t in tokens]
    tally = _tally_lists(lists, datasets)
    return {"rows": _rows_from_tally(tally, label=country_label), **_coverage(sum(1 for items in lists if items), len(df))}


def _geometry(df: pd.DataFrame) -> pd.DataFrame:
    """Per-scan slice spacing (mm) and z-extent (cm) from the catalog's spacing / shape strings."""
    spacing = df["spacing"].map(_triplet) if "spacing" in df.columns else pd.Series([None] * len(df), index=df.index)
    shape = df["shape"].map(_triplet) if "shape" in df.columns else pd.Series([None] * len(df), index=df.index)
    z_space = spacing.map(lambda t: t[2] if t and t[2] > 0 else np.nan)
    depth = shape.map(lambda t: t[2] if t and t[2] > 0 else np.nan)
    return pd.DataFrame({"slice_mm": z_space.astype(float), "coverage_cm": (z_space * depth / 10.0).astype(float)}, index=df.index)


def _slice_block(geom: pd.DataFrame, datasets: pd.Series, total: int) -> Dict[str, Any]:
    values = geom["slice_mm"]
    rows, previous = [], 0.0
    for upper, label in SLICE_BINS:
        mask = (values > previous) & (values <= upper)
        rows.append({"key": label, "label": label, "count": _int(mask.sum()), "datasets": _split_counts(mask.fillna(False), datasets)})
        previous = upper
    return {"rows": rows, **_summary(values), **_coverage(_int(values.notna().sum()), total)}


def _coverage_block(geom: pd.DataFrame, datasets: pd.Series, total: int) -> Dict[str, Any]:
    values = geom["coverage_cm"]
    rows = []
    for i, (lower, label) in enumerate(COVERAGE_BINS):
        upper = COVERAGE_BINS[i + 1][0] if i + 1 < len(COVERAGE_BINS) else float("inf")
        mask = (values >= lower) & (values < upper)
        rows.append({"key": label, "label": label, "count": _int(mask.sum()), "datasets": _split_counts(mask.fillna(False), datasets)})
    return {"rows": rows, **_summary(values), **_coverage(_int(values.notna().sum()), total)}


def _completeness(df: pd.DataFrame, datasets: pd.Series) -> List[Dict[str, Any]]:
    """Share of each dataset's scans that record each field: what the whole page rests on."""
    def column(name: str, test: Callable[[Any], Any]) -> Optional[pd.Series]:
        return _flags(df[name], test) if name in df.columns else None

    def numeric_between(name: str, low: float, high: float) -> Optional[pd.Series]:
        if name not in df.columns:
            return None
        return pd.to_numeric(df[name], errors="coerce").between(low, high).astype(bool)

    fields = [
        ("sex", column("__sex", lambda v: str(v).strip().upper() in ("M", "F"))),
        ("age", numeric_between("__age", 0, MAX_PLAUSIBLE_AGE)),
        ("phase", column("__ct", phase_tokens)),
        ("manufacturer", column("__mfr", _is_known)),
        ("model", column("model", _is_known)),
        ("year", numeric_between("__year_int", 1980, 2100)),
        ("country", column("__sn_tokens", lambda t: isinstance(t, (tuple, list, set)) and bool(t))),
        ("tumor", None if "__tumor01" not in df.columns else pd.to_numeric(df["__tumor01"], errors="coerce").notna()),
    ]
    out = []
    for name, flags in fields:
        row = {"field": name, "datasets": {}}
        for dataset in DATASETS:
            members = datasets == dataset
            size = _int(members.sum())
            known = _int(flags[members].sum()) if flags is not None and size else 0
            row["datasets"][dataset] = {"recorded": known, "total": size, "share": round(known / size, 4) if size else None}
        out.append(row)
    return out


# ---------------------------------------------------------------------------------------------- entry
def compute_stats(df: pd.DataFrame,
                  country_label: Optional[Callable[[str], str]] = None,
                  tumor_type_label: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    """Everything the Statistics page draws, for the scans in ``df`` (the filtered catalog)."""
    country_label = country_label or (lambda code: code)
    tumor_type_label = tumor_type_label or (lambda key: str(key).replace("_", " ").title())
    df = df.reset_index(drop=True)
    datasets = _dataset_series(df)
    geom = _geometry(df)
    total = len(df)
    return {
        "schema": SCHEMA,
        "total": total,
        "datasets": _datasets_block(datasets),
        "tumor": _tumor_block(df, datasets, tumor_type_label),
        "phase": _phase_block(df, datasets),
        "sex": _sex_block(df, datasets),
        "age": _age_block(df, datasets),
        "manufacturer": _manufacturer_block(df, datasets),
        "model": _model_block(df, datasets),
        "year": _year_block(df, datasets),
        "country": _country_block(df, datasets, country_label),
        "slice_thickness": _slice_block(geom, datasets, total),
        "coverage": _coverage_block(geom, datasets, total),
        "completeness": _completeness(df, datasets),
    }
