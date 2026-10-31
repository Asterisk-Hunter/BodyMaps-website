"""Dataset-neutral ranking, cohort exhaustion and catalog-sized CPU budget."""
import math
import time
import pandas as pd
from services.search_ranking import rank_quality_results, rank_legacy_quality_results


def fixture(n=180):
    return pd.DataFrame([dict(id=i,__case_str=f'case{i:05d}',__case_sortkey=i,
        __dataset=('PanTS','AbdomenAtlas','CancerVerse')[(i//30)%3],
        __tumor01=(i//15)%2,__thumbnail_quality_rank=0,
        __ct_bytes=100000-i,__voxel_count=100000-i,__spacing_volume=.5+i/1e6,
        __shape_sum=1000-i/1000,__sex='F' if i%2 else 'M',__age=20+i%70)
        for i in range(n)])


def test_old_screenshot_failure_and_new_first_page():
    df=fixture()
    df['__sex']='F';df['__age']=50  # single-filter screenshot: no demographic escape hatch
    old=rank_legacy_quality_results(df).iloc[:12]
    assert len(set(old.__dataset))==1
    assert len(set(old.__tumor01))==1
    ranked=rank_quality_results(df)
    assert len(set(ranked.iloc[:12].__dataset))==3
    # Every full12-row window has both statuses when neither cohort is exhausted.
    for start in range(len(ranked)-11):
        assert set(ranked.iloc[start:start+12].__tumor01)=={0,1}


def test_tiers_are_never_inverted_to_fill_diversity():
    df=fixture();df.loc[10:,'__thumbnail_quality_rank']=2
    ranked=rank_quality_results(df)
    assert ranked.__thumbnail_quality_rank.tolist()==sorted(df.__thumbnail_quality_rank)
    assert set(ranked.iloc[:10].__dataset)=={'PanTS'}


def test_each_balancing_switch_is_respected():
    df=fixture()
    plain=rank_quality_results(df,balance_tumor=False,balance_dataset=False,balance_sex=False,balance_age=False)
    assert plain.id.tolist()==list(range(len(df)))
    by_status=rank_quality_results(df,balance_dataset=False,balance_sex=False,balance_age=False)
    assert len(set(by_status.iloc[:12].__dataset))==1
    assert set(by_status.iloc[:12].__tumor01)=={0,1}
    by_dataset=rank_quality_results(df,balance_tumor=False,balance_sex=False,balance_age=False)
    assert len(set(by_dataset.iloc[:12].__dataset))==3


def test_deterministic_pagination_exhaustion_unknown_and_no_mutation():
    df=fixture();df.loc[0,'__tumor01']=math.nan
    before=df.copy(deep=True)
    a=rank_quality_results(df);b=rank_quality_results(df)
    assert a.id.tolist()==b.id.tolist()
    assert pd.concat([a.iloc[i:i+12] for i in range(0,len(a),12)]).id.tolist()==a.id.tolist()
    assert len(a)==len(df) and a.id.is_unique
    pd.testing.assert_frame_equal(df,before)
    tiny=df.iloc[:2];assert len(rank_quality_results(tiny))==2
    pd.testing.assert_frame_equal(rank_quality_results(df.iloc[:0]),df.iloc[:0])


def test_single_cohort_and_bad_measurements_remain_usable():
    df=fixture(10);df['__ct_bytes']=math.inf;df['__spacing_volume']=-1
    ranked=rank_quality_results(df)
    assert set(ranked.id)==set(df.id)
    assert not set(ranked.columns)-set(df.columns)


def test_catalog_sized_ranking_budget():
    df=fixture(43600)
    start=time.perf_counter();ranked=rank_quality_results(df);seconds=time.perf_counter()-start
    assert len(ranked)==43600 and ranked.id.is_unique
    # Broad CI regression ceiling, not a promise about production request latency.
    assert seconds<8.0,f'43600-row ranking took {seconds:.3f}s'
