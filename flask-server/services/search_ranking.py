"""Deterministic quality ranking and demographic diversification for case search."""

from __future__ import annotations

from collections import Counter
from random import Random, SystemRandom

import pandas as pd


QUALITY_COLUMNS = (
    ("__thumbnail_quality_rank", True),
    # PanTS before CancerVerse inside a thumbnail tier: PanTS cases have full organ masks,
    # and CancerVerse scans are bigger on average, so without this they would fill the
    # first pages of Browse-all and Shuffle on size alone.
    ("__dataset_rank", True),
    ("__ct_bytes", False),
    ("__voxel_count", False),
    ("__spacing_volume", True),
    ("__shape_sum", False),
    ("__spacing_sum", True),
    ("__case_sortkey", True),
)


def _bucket(value: object, unknown: str) -> object:
    if value is None or pd.isna(value) or str(value).strip() == "":
        return unknown
    return value


def _age_bucket(value: object) -> object:
    if value is None or pd.isna(value):
        return "UNKNOWN"
    try:
        age = max(0, int(float(value)))
    except (TypeError, ValueError):
        return "UNKNOWN"
    return f"{min(age // 10, 9) * 10:02d}s"


def _diversify_block(
    block: pd.DataFrame,
    *,
    balance_sex: bool,
    balance_age: bool,
) -> pd.DataFrame:
    """Greedily alternate demographics while retaining quality as the tie-breaker."""
    if len(block) < 2 or not (balance_sex or balance_age):
        return block

    remaining = list(range(len(block)))
    selected: list[int] = []
    sex_counts: Counter[object] = Counter()
    age_counts: Counter[object] = Counter()

    sex_values = [
        _bucket(value, "UNKNOWN")
        for value in block.get("__sex", pd.Series(index=block.index, dtype=object))
    ]
    age_values = [
        _age_bucket(value)
        for value in block.get("__age", pd.Series(index=block.index, dtype=object))
    ]

    while remaining:
        def diversity_score(position: int) -> tuple[int, int, int]:
            penalties = []
            if balance_sex:
                penalties.append(sex_counts[sex_values[position]])
            if balance_age:
                penalties.append(age_counts[age_values[position]])
            return (sum(penalties), max(penalties, default=0), position)

        position = min(remaining, key=diversity_score)
        remaining.remove(position)
        selected.append(position)
        if balance_sex:
            sex_counts[sex_values[position]] += 1
        if balance_age:
            age_counts[age_values[position]] += 1

    return block.iloc[selected]


def rank_quality_results(
    df: pd.DataFrame,
    *,
    balance_sex: bool = True,
    balance_age: bool = True,
    diversity_window: int = 96,
) -> pd.DataFrame:
    """Rank thumbnail usability and scan detail, then diversify nearby results.

    Diversification stays inside thumbnail-quality tiers, so an unknown or distorted
    thumbnail cannot move ahead of a vision-verified undistorted thumbnail.
    """
    if df.empty:
        return df

    if "__dataset" in df.columns and "__dataset_rank" not in df.columns:
        df = df.assign(__dataset_rank=(df["__dataset"] != "PanTS").astype(int))

    available = [
        (column, ascending)
        for column, ascending in QUALITY_COLUMNS
        if column in df.columns
    ]
    if not available:
        return df
    columns = [column for column, _ in available]
    ascending = [direction for _, direction in available]
    ranked = df.sort_values(
        by=columns,
        ascending=ascending,
        na_position="last",
        kind="mergesort",
    )

    if not (balance_sex or balance_age):
        return ranked

    window = max(1, int(diversity_window))
    tiers = (
        ranked.groupby("__thumbnail_quality_rank", sort=False, dropna=False)
        if "__thumbnail_quality_rank" in ranked.columns
        else [(None, ranked)]
    )
    blocks: list[pd.DataFrame] = []
    for _, tier in tiers:
        for start in range(0, len(tier), window):
            blocks.append(
                _diversify_block(
                    tier.iloc[start : start + window],
                    balance_sex=balance_sex,
                    balance_age=balance_age,
                )
            )

    return pd.concat(blocks) if blocks else ranked



SAMPLE_MAX_CT_BYTES = 16 * 1024 * 1024


def rank_sample_results(df: pd.DataFrame) -> pd.DataFrame:
    """Prefer compact original scans for Sample without changing gallery ranking.

    This uses the already loaded compressed CT byte counts, not per-request disk
    probes or downsampling. Known sizes within the transfer budget come first;
    unknown sizes are a fallback, followed by known oversized originals. Inside
    each size tier, prefer usable thumbnails and known demographics, then PanTS
    (which has full organ masks) and smaller files. The client still checks the
    actual response size because offline metadata can be stale.
    """
    if df.empty:
        return df

    def column(name, default):
        return df[name] if name in df.columns else pd.Series(default, index=df.index)

    sizes = pd.to_numeric(column('__ct_bytes', float('nan')), errors='coerce')
    sizes = sizes.where((sizes > 0) & (sizes < float('inf')))
    size_tier = pd.Series(1, index=df.index)  # unknown: no transfer-size claim
    size_tier.loc[sizes.notna()] = 2
    size_tier.loc[sizes <= SAMPLE_MAX_CT_BYTES] = 0
    thumbnails = pd.to_numeric(column('__thumbnail_quality_rank', 1), errors='coerce')
    thumbnails = thumbnails.where(thumbnails.isin([0, 1, 2]), 1)
    ages = pd.to_numeric(column('__age', float('nan')), errors='coerce')
    known_age = (ages >= 0) & (ages < float('inf'))
    known_sex = column('__sex', '').astype(str).str.strip().str.upper().isin(['F', 'M'])
    helpers = {
        '__sample_size_tier': size_tier,
        '__sample_thumbnail': thumbnails,
        '__sample_missing_demographics': ~(known_age & known_sex),
        '__sample_dataset': (column('__dataset', 'PanTS') != 'PanTS').astype(int),
        '__sample_bytes': sizes,
    }
    ranked = df.assign(**helpers)
    by = list(helpers)
    if '__case_sortkey' in df.columns:
        by.append('__case_sortkey')
    return ranked.sort_values(by=by, ascending=True, na_position='last', kind='mergesort').drop(columns=list(helpers))

def select_balanced_tumor_results(
    ranked: pd.DataFrame,
    *,
    count: int,
    pool_size: int,
    offset: int = 0,
    rng: Random | None = None,
) -> pd.DataFrame:
    """Select equal tumor cohorts, then randomize their display arrangement.

    Returns an empty frame when the requested balance cannot be satisfied so the
    caller can deliberately choose its fallback behavior.
    """
    if ranked.empty or count < 1 or "__tumor01" not in ranked.columns:
        return ranked.iloc[0:0]

    tumor_values = pd.to_numeric(ranked["__tumor01"], errors="coerce")
    tumor_positions = [
        position for position, value in enumerate(tumor_values) if value == 1
    ]
    non_tumor_positions = [
        position for position, value in enumerate(tumor_values) if value == 0
    ]
    tumor_target = count // 2
    non_tumor_target = count - tumor_target
    if (
        len(tumor_positions) < tumor_target
        or len(non_tumor_positions) < non_tumor_target
    ):
        return ranked.iloc[0:0]

    per_cohort_pool = max(tumor_target, non_tumor_target, (pool_size + 1) // 2)

    def rotate_take(positions: list[int], amount: int) -> list[int]:
        pool = positions[:per_cohort_pool]
        start = offset % len(pool)
        return [pool[(start + index) % len(pool)] for index in range(amount)]

    selected = rotate_take(tumor_positions, tumor_target)
    selected.extend(rotate_take(non_tumor_positions, non_tumor_target))
    (rng or SystemRandom()).shuffle(selected)
    return ranked.iloc[selected]
