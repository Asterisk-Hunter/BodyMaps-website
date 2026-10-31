"""PanTS + CancerVerse search as one catalog: defaults, tumor types, exact ids, facets."""
import numpy as np
import pandas as pd
import pytest
from flask import Flask

import api.api_blueprint as api_routes
import api.utils as u
from services import cancerverse_catalog as cv

APP = Flask(__name__)


def pants_frame():
    return pd.DataFrame({
        "PanTS ID": ["PanTS_00000012", "PanTS_00000030", "PanTS_00008854"],
        "tumor?": [1, 1, 0],
        "ct phase": ["Venous", "Arterial", "Non-contrast"],
        "sex": ["M", "M", "F"],
        "age": [60, 50, 70],
        "manufacturer": ["SIEMENS", "Philips", "GE MEDICAL SYSTEMS"],
        "study year": [2020, 2019, 2021],
        "shape": ["(512, 512, 100)"] * 3,
        "spacing": ["(0.8, 0.8, 1.0)"] * 3,
    })


def cv_raw():
    return pd.DataFrame({
        "CancerVerse ID": ["CV_00000012", "CV_00000013", "CV_00000014", "CV_00000015", "CV_00000016"],
        "Patient ID": ["A", "B", "C", "D", "A"],
        "sex": ["F", "M", "F", "M", "F"],
        "age": ["55", "above 89", "61", "", "55"],
        "phase": ["portal_venous", "arterial_late", "non-contrast", "venous", "venous"],
        "exam_date": ["01-02-2021", "03-04-2022", "05-06-2023", "07-08-2024", "02-02-2021"],
        "scanner": ["Siemens", "", "Philips", "", ""],
    })


CV_INDEX = {
    "CV_00000012": {"tumors": {"liver": 9.0, "kidney": 1.0}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000013": {"tumors": {"pancreas": 4.0}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000014": {"tumors": {}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000015": {"tumors": {}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000016": {"tumors": {}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},   # A's other scan
}


@pytest.fixture(autouse=True)
def catalog(monkeypatch):
    pants = u._norm_cols(pants_frame())
    cvdf = u._norm_cols(cv.normalize_metadata(cv_raw(), CV_INDEX))
    monkeypatch.setattr(u, "DF", pants)
    monkeypatch.setattr(u, "DF_CV", cvdf)
    monkeypatch.setattr(u, "DF_ALL", pd.concat([pants, cvdf], ignore_index=True))


def ids(query=""):
    with APP.test_request_context("/api/search?" + query):
        df = u.apply_filters(u.select_dataset_df())
    return sorted(df["__case_str"])


ALL = ["CV_00000012", "CV_00000013", "CV_00000014", "CV_00000015", "CV_00000016",
       "PanTS_00000012", "PanTS_00000030", "PanTS_00008854"]


def test_default_search_covers_both_datasets():
    assert ids() == ALL
    assert ids("dataset=all") == ALL


def test_dataset_param_still_narrows_for_api_clients():
    assert ids("dataset=pants") == ["PanTS_00000012", "PanTS_00000030", "PanTS_00008854"]
    assert ids("dataset=cancerverse") == [i for i in ALL if i.startswith("CV_")]


def test_pants_tumors_are_pancreatic():
    assert (u.DF["__tumor_types"][u.DF["__tumor01"] == 1].map(lambda t: t == ("pancreas",))).all()
    assert (u.DF["__tumor_types"][u.DF["__tumor01"] == 0].map(len) == 0).all()


def test_tumor_type_filter_spans_datasets():
    assert ids("tumor_type[]=pancreas") == ["CV_00000013", "PanTS_00000012", "PanTS_00000030"]
    assert ids("tumor_type[]=liver") == ["CV_00000012"]
    assert ids("tumor_type[]=kidney&tumor_type[]=pancreas") == ["CV_00000012", "CV_00000013", "PanTS_00000012", "PanTS_00000030"]
    assert ids("tumor_type=Liver") == ["CV_00000012"]                 # case-insensitive, comma form
    assert ids("tumor_type[]=spleen") == []


def test_tumor_type_accepts_every_separator():
    for query in ("tumor_type=liver;kidney", "tumor_type=liver|kidney", "tumor_type=liver,kidney",
                  "tumor_type[]=liver&tumor_type[]=kidney"):
        assert ids(query) == ["CV_00000012"], query


@pytest.mark.parametrize("query", ["caseid=%C2%B2", "q=%C2%B2", "caseid=%D9%A3", "q=%D9%A3"])
def test_non_ascii_digits_are_text_not_numbers(query):
    """str.isdigit() accepts '²' and Arabic digits; int() then raised and the request returned a 500."""
    assert ids(query) == []


def test_tumor_flag_works_across_datasets_and_unknown_is_not_no_tumor():
    assert ids("tumor=1") == ["CV_00000012", "CV_00000013", "PanTS_00000012", "PanTS_00000030"]
    # CV_14 / CV_15 are healthy patients; CV_16 is a scan of a patient with tumor scans: unknown
    assert ids("tumor=0") == ["CV_00000014", "CV_00000015", "PanTS_00008854"]
    assert ids("tumor_is_null=1") == ["CV_00000016"]


def test_ct_phase_filter_uses_one_vocabulary():
    assert ids("ct_phase[]=venous") == ["CV_00000012", "CV_00000015", "CV_00000016", "PanTS_00000012"]
    assert ids("ct_phase[]=arterial") == ["CV_00000013", "PanTS_00000030"]
    assert ids("ct_phase[]=non-contrast") == ["CV_00000014", "PanTS_00008854"]


def test_caseid_is_an_exact_lookup_and_a_bare_number_means_pants():
    assert ids("caseid=12") == ["PanTS_00000012"]                    # not CV_00000012
    assert ids("caseid=00000012") == ["PanTS_00000012"]
    assert ids("caseid=CV_00000012") == ["CV_00000012"]
    assert ids("caseid=cv_12") == ["CV_00000012"]
    assert ids("caseid=PanTS_00008854") == ["PanTS_00008854"]
    assert ids("caseid=99999") == []


def test_keyword_search_finds_the_number_in_both_datasets():
    assert ids("q=12") == ["CV_00000012", "PanTS_00000012"]


def test_sort_by_id_keeps_pants_before_cancerverse():
    with APP.test_request_context("/api/search?sort_by=id"):
        df = u.ensure_sort_cols(u.apply_filters(u.select_dataset_df()).copy())
        df = df.sort_values("__case_sortkey", kind="mergesort")
    order = list(df["__case_str"])
    assert order[:3] == ["PanTS_00000012", "PanTS_00000030", "PanTS_00008854"]
    assert order[3] == "CV_00000012"


def item(case_id):
    df = u.DF_ALL
    return u.row_to_item(df[df["__case_str"] == case_id].iloc[0])


def test_items_say_which_dataset_and_which_tumor():
    p = item("PanTS_00000012")
    assert (p["dataset"], p["tumor"], p["tumor types"], p["tumor label"]) == ("PanTS", 1, ["pancreas"], "Pancreas")
    c = item("CV_00000012")
    assert (c["dataset"], c["tumor"], c["tumor types"]) == ("CancerVerse", 1, ["liver", "kidney"])
    assert c["tumor label"] == "Liver, Kidney"
    assert c["ct phase"] == "Venous" and c["age"] == 55.0 and c["study year"] == 2021
    healthy = item("CV_00000014")
    assert (healthy["tumor"], healthy["tumor types"], healthy["tumor label"]) == (0, [], None)
    unknown = item("CV_00000016")
    assert unknown["tumor"] is None and unknown["tumor label"] is None
    assert item("PanTS_00008854")["tumor"] == 0


def test_items_never_carry_private_cancerverse_fields():
    keys = set(item("CV_00000012"))
    assert not {"Patient ID", "report", "Encrypted Accession Number"} & keys


def facets(query):
    with APP.test_request_context("/api/facets?" + query):
        response = api_routes.api_facets()
    return response.get_json()


def test_tumor_type_facet_counts_every_organ_and_marks_unknown():
    body = facets("fields=tumor_type")
    rows = {r["value"]: (r["label"], r["count"]) for r in body["facets"]["tumor_type"]}
    assert rows == {"pancreas": ("Pancreas", 3), "liver": ("Liver", 1), "kidney": ("Kidney", 1)}
    assert body["unknown_counts"]["tumor_type"] == 1                  # CV_00000016
    assert body["total"] == 8


def test_facet_counts_follow_the_active_filters_like_every_other_facet():
    body = facets("fields=tumor_type&ct_phase[]=venous")
    assert {r["value"]: r["count"] for r in body["facets"]["tumor_type"]} == {"pancreas": 1, "liver": 1, "kidney": 1}
    narrowed = facets("fields=tumor_type&tumor_type[]=liver")
    assert {r["value"]: r["count"] for r in narrowed["facets"]["tumor_type"]} == {"liver": 1, "kidney": 1}


def test_facets_respect_the_dataset_param_and_report_dataset_sizes():
    body = facets("fields=ct_phase&dataset=cancerverse")
    assert body["total"] == 5
    assert body["dataset_counts"] == {"PanTS": 3, "CancerVerse": 5, "AbdomenAtlas": 0}


def test_tumor_column_is_the_flag_even_when_a_tumor_type_column_comes_first():
    raw = pd.DataFrame({"PanTS ID": ["PanTS_00000001", "PanTS_00000002"],
                        "tumor type": ["liver", ""], "tumor?": [1, 0]})
    out = u._norm_cols(raw)
    assert list(out["__tumor01"]) == [1, 0]
    assert out["__tumor_types"].iloc[0] == ("liver",)


def test_sort_columns_match_the_original_row_by_row_helpers():
    """ensure_sort_cols parses each row once; the numbers must equal the per-helper results."""
    frame = pd.DataFrame({
        "__case_str": ["PanTS_00000005", "CV_00000007", "PanTS_00000009"],
        "shape": ["(512, 512, 100)", "(256, 256, 0)", ""],
        "spacing": ["(0.8, 0.8, 1.0)", "(0.5, 0.5, 2.5)", "(1, 1)"],
    })
    got = u.ensure_sort_cols(frame.copy())
    for i, row in frame.iterrows():
        assert got["__shape_sum"].iloc[i] == pytest.approx(u._shape_sum(row), nan_ok=True) or (
            pd.isna(got["__shape_sum"].iloc[i]) and u._shape_sum(row) is None)
        for col, fn in (("__spacing_sum", u._spacing_sum), ("__voxel_count", u._voxel_count),
                        ("__spacing_volume", u._spacing_volume)):
            want = fn(row)
            assert (pd.isna(got[col].iloc[i]) if want is None else got[col].iloc[i] == pytest.approx(want))
    assert list(got["__case_sortkey"]) == [5, 100_000_007, 9]
    assert got["__voxel_count"].iloc[1] != got["__voxel_count"].iloc[1]    # zero depth -> unknown, as before
    again = u.ensure_sort_cols(got.copy())                                  # idempotent
    assert list(again["__shape_sum"].fillna(-1)) == list(got["__shape_sum"].fillna(-1))


def test_sort_columns_tolerate_an_empty_catalog():
    empty = u.ensure_sort_cols(pd.DataFrame({"__case_str": [], "shape": [], "spacing": []}))
    assert len(empty) == 0 and {"__shape_sum", "__spacing_volume", "__complete"} <= set(empty.columns)


def test_sample_sort_uses_loaded_sizes_and_keeps_filtering_pagination_and_default(monkeypatch):
    data = u.DF_ALL.copy()
    data['__ct_bytes'] = data['__case_str'].map({
        'PanTS_00000012': 248_000_000,
        'PanTS_00000030': 15_000_000,
        'PanTS_00008854': 11_000_000,
    })
    data['__thumbnail_quality_rank'] = 0
    monkeypatch.setattr(u, 'DF_ALL', data)
    with APP.test_request_context('/api/search?sort_by=sample&per_page=1'):
        body = api_routes.api_search().get_json()
    assert body['items'][0]['case_id'] == 'PanTS_00008854'
    assert body['total'] == 8 and body['page'] == 1 and body['per_page'] == 1
    with APP.test_request_context('/api/search?sort_by=sample&sex=M&per_page=1'):
        filtered = api_routes.api_search().get_json()
    assert filtered['items'][0]['case_id'] == 'PanTS_00000030'
    with APP.test_request_context('/api/search?per_page=1'):
        default = api_routes.api_search().get_json()
    assert default['items'][0]['case_id'] == 'PanTS_00000012'


# ------------------------------------------------------------------------ the third dataset
def atlas_raw():
    return pd.DataFrame({
        "BDMAP ID": ["BDMAP_00000012", "BDMAP_00000013"],
        "sex": ["F", "M"],
        "age": ["60", "70"],
        "contrast": ["Venous", "Plain"],
        "number of liver lesion instances": [3.0, 0.0],
        "number of pancreatic lesion instances": [0.0, 0.0],
        "number of kidney lesion instances": [0.0, 0.0],
        "number of colon lesion instances": [0.0, 0.0],
    })


@pytest.fixture()
def with_atlas(monkeypatch):
    from services import abdomenatlas_catalog as at
    atlas = u._norm_cols(at.normalize_metadata(atlas_raw()))
    monkeypatch.setattr(u, "DF_AT", atlas)
    monkeypatch.setattr(u, "DF_ALL", pd.concat([u.DF, u.DF_CV, atlas], ignore_index=True))
    return atlas


def test_the_third_dataset_joins_the_default_search_and_the_param_narrows_to_it(with_atlas):
    assert ids() == sorted(ALL + ["BDMAP_00000012", "BDMAP_00000013"])
    assert ids("dataset=abdomenatlas") == ["BDMAP_00000012", "BDMAP_00000013"]
    assert ids("dataset=atlas") == ["BDMAP_00000012", "BDMAP_00000013"]
    assert ids("dataset=pants") == ["PanTS_00000012", "PanTS_00000030", "PanTS_00008854"]
    assert ids("dataset=cancerverse") == [i for i in ALL if i.startswith("CV_")]


def test_ids_stay_exact_across_three_datasets(with_atlas):
    assert ids("caseid=12") == ["PanTS_00000012"]                      # a bare number is still PanTS
    assert ids("caseid=BDMAP_00000012") == ["BDMAP_00000012"]
    assert ids("caseid=bdmap_12") == ["BDMAP_00000012"]
    assert ids("q=12") == ["BDMAP_00000012", "CV_00000012", "PanTS_00000012"]


def test_sort_by_id_puts_pants_then_cancerverse_then_abdomenatlas(with_atlas):
    with APP.test_request_context("/api/search?sort_by=id"):
        df = u.ensure_sort_cols(u.apply_filters(u.select_dataset_df()).copy())
        order = list(df.sort_values("__case_sortkey", kind="mergesort")["__case_str"])
    assert order[:3] == ["PanTS_00000012", "PanTS_00000030", "PanTS_00008854"]
    assert order[3:8] == ["CV_00000012", "CV_00000013", "CV_00000014", "CV_00000015", "CV_00000016"]
    assert order[8:] == ["BDMAP_00000012", "BDMAP_00000013"]


def test_items_and_tumor_types_of_the_third_dataset(with_atlas):
    row = u.DF_ALL[u.DF_ALL["__case_str"] == "BDMAP_00000012"].iloc[0]
    got = u.row_to_item(row)
    assert (got["dataset"], got["tumor"], got["tumor types"], got["tumor label"]) == ("AbdomenAtlas", 1, ["liver"], "Liver")
    assert got["ct phase"] == "Venous" and got["sex"] == "F" and got["age"] == 60
    assert ids("tumor_type[]=liver") == ["BDMAP_00000012", "CV_00000012"]
    assert ids("ct_phase[]=Non-contrast") == ["BDMAP_00000013", "CV_00000014", "PanTS_00008854"]


def test_quality_search_interleaves_the_three_datasets(with_atlas):
    from services import search_ranking as sr
    ranked = sr.rank_quality_results(u.DF_ALL.copy(), balance_sex=False, balance_age=False)
    datasets = list(ranked["__dataset"])
    # Do not move a worse thumbnail tier forward just to complete a quota.
    assert len(set(datasets[:6])) >= 2
    assert set(datasets) == {'PanTS','CancerVerse','AbdomenAtlas'}
    assert len(ranked) == len(u.DF_ALL)


@pytest.mark.parametrize('query,expected', [
    ('dataset=all',(True,True,True,True)),
    ('dataset=pants',(False,True,True,True)),
    ('tumor=1',(True,False,True,True)),
    ('tumor_is_null=1',(True,False,True,True)),
    ('tumor_type[]=liver',(True,False,True,True)),
    ('sex[]=M&age_from=40',(True,True,False,False)),
])
def test_search_disables_only_filtered_balancing_dimensions(monkeypatch,query,expected):
    seen=[]
    def rank(df,**kwargs):
        seen.append(tuple(kwargs[k] for k in ('balance_dataset','balance_tumor','balance_sex','balance_age')))
        return df
    monkeypatch.setattr(api_routes,'rank_quality_results',rank)
    with APP.test_request_context('/api/search?sort_by=quality&'+query):
        assert api_routes.api_search().status_code==200
    assert seen==[expected]


@pytest.mark.parametrize('sort_by',['id','id_desc','age_asc','age_desc','shape','spacing','sample'])
def test_explicit_sorts_never_use_diverse_quality_ranking(monkeypatch,sort_by):
    monkeypatch.setattr(api_routes,'rank_quality_results',lambda *_a,**_k: pytest.fail('explicit sort changed'))
    with APP.test_request_context('/api/search?sort_by='+sort_by):
        body=api_routes.api_search().get_json()
    assert len(body['items'])==len(u.DF_ALL)


def test_filtered_search_pagination_has_no_duplicates_or_gaps():
    def page(n,per):
        with APP.test_request_context(f'/api/search?sort_by=quality&page={n}&per_page={per}'):
            return [i['case_id'] for i in api_routes.api_search().get_json()['items']]
    assert page(1,3)+page(2,3)+page(3,3)==page(1,100)
