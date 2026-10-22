"""The statistics behind the Statistics page: counts per dataset, coverage, filters, privacy, edge cases."""
import json

import numpy as np
import pandas as pd
import pytest
from flask import Flask, make_response

import api.api_blueprint as api_routes
import api.utils as u
from services import abdomenatlas_catalog as at
from services import cancerverse_catalog as cv
from services import stats
from services.site_normalization import site_country_label

APP = Flask(__name__)


def pants_frame():
    return pd.DataFrame({
        "PanTS ID": [f"PanTS_{i:08d}" for i in (1, 2, 3, 4)],
        "tumor?": [1, 0, 0, 0],
        "ct phase": ["Venous", "Arterial", "Non-contrast", "Delay"],
        "sex": ["M", "F", "F", ""],
        "age": [60, 41, 72, np.nan],
        "manufacturer": ["SIEMENS", "Philips", "GE MEDICAL SYSTEMS", ""],
        "manufacturer model": ["Sensation 64", "Brilliance 40", "LightSpeed 16", ""],
        "study year": [2000, 2003, "2012; 2016; 2020", np.nan],
        "site nationality": ["US", "DE", "CH; DE", ""],
        "shape": ["(512, 512, 100)", "(512, 512, 400)", "(512, 512, 200)", "(512, 512, 0)"],
        "spacing": ["(0.8, 0.8, 1.0)", "(0.7, 0.7, 0.8)", "(0.7, 0.7, 2.5)", "(0.7, 0.7, 2.5)"],
    })


def cv_raw():
    return pd.DataFrame({
        "CancerVerse ID": ["CV_00000001", "CV_00000002", "CV_00000003"],
        "Patient ID": ["PATIENT-A", "PATIENT-B", "PATIENT-C"],
        "Encrypted Accession Number": ["ACC1", "ACC2", "ACC3"],
        "sex": ["M", "F", ""],
        "age": ["85", "above 89", ""],
        "phase": ["portal_venous", "arterial_late", ""],
        "exam_date": ["07-30-2022", "03-04-2020", ""],
        "scanner": ["Siemens", "", ""],
        "report": ["private findings"] * 3,
    })


CV_INDEX = {
    "CV_00000001": {"tumors": {"liver": 9.0, "kidney": 1.0}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000002": {"tumors": {}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
    "CV_00000003": {"tumors": {}, "shape": [512, 512, 90], "spacing": [0.7, 0.7, 1.5]},
}


def atlas_raw():
    return pd.DataFrame({
        "BDMAP ID": ["BDMAP_00000001", "BDMAP_00000002"],
        "spacing": ["[0.82 0.82 2.5]", "[0.7 0.7 5.0]"],
        "shape": ["(512, 512, 339)", "(512, 512, 100)"],
        "sex": ["F", ""],
        "age": ["51", ""],
        "contrast": ["Arterial", "Plain"],
        "number of liver lesion instances": [25.0, 0.0],
        "number of pancreatic lesion instances": [0.0, 0.0],
        "number of kidney lesion instances": [0.0, 0.0],
        "number of colon lesion instances": [0.0, 0.0],
    })


@pytest.fixture(autouse=True)
def catalog(monkeypatch):
    pants = u.ensure_sort_cols(u._norm_cols(pants_frame()))
    cvdf = u.ensure_sort_cols(u._norm_cols(cv.normalize_metadata(cv_raw(), CV_INDEX)))
    atdf = u.ensure_sort_cols(u._norm_cols(at.normalize_metadata(atlas_raw())))
    monkeypatch.setattr(u, "DF", pants)
    monkeypatch.setattr(u, "DF_CV", cvdf)
    monkeypatch.setattr(u, "DF_AT", atdf)
    monkeypatch.setattr(u, "DF_ALL", pd.concat([pants, cvdf, atdf], ignore_index=True))
    api_routes._STATS_CACHE.clear()


def compute(query=""):
    with APP.test_request_context("/api/stats?" + query):
        df = u.apply_filters(u.select_dataset_df())
    return stats.compute_stats(df, country_label=site_country_label, tumor_type_label=cv.tumor_type_label)


def rows(block, key="rows"):
    return {r["key"]: r for r in block[key]}


# ---------------------------------------------------------------------------------------------- totals
def test_the_total_and_each_dataset_count_follow_the_catalog():
    out = compute()
    assert out["schema"] == "stats-v1" and out["total"] == 9
    assert {d["key"]: d["count"] for d in out["datasets"]} == {"PanTS": 4, "CancerVerse": 3, "AbdomenAtlas": 2}


def test_phase_uses_one_vocabulary_and_says_how_many_scans_record_it():
    phase = compute()["phase"]
    by = rows(phase)
    assert by["Venous"]["datasets"] == {"PanTS": 1, "CancerVerse": 1, "AbdomenAtlas": 0}
    assert by["Arterial"]["datasets"] == {"PanTS": 1, "CancerVerse": 1, "AbdomenAtlas": 1}
    assert by["Non-contrast"]["datasets"] == {"PanTS": 1, "CancerVerse": 0, "AbdomenAtlas": 1}
    assert by["Delayed"]["count"] == 1 and "Other" not in by
    assert (phase["recorded"], phase["total"], phase["not_reported"]) == (8, 9, 1)


def test_sex_counts_the_ratio_and_the_scans_that_do_not_say():
    sex = compute()["sex"]
    assert {k: r["count"] for k, r in rows(sex).items()} == {"M": 2, "F": 4}
    assert rows(sex)["F"]["datasets"] == {"PanTS": 2, "CancerVerse": 1, "AbdomenAtlas": 1}
    assert sex["ratio"] == {"male_percent": 33.3, "female_percent": 66.7}
    assert (sex["recorded"], sex["not_reported"]) == (6, 3)


def test_age_bins_are_five_years_and_the_summary_ignores_unreported_ages():
    age = compute()["age"]
    by = {b["label"]: b["count"] for b in age["bins"]}
    assert by["40–44"] == 1 and by["60–64"] == 1 and by["70–74"] == 1 and by["50–54"] == 1
    assert by["85–89"] == 1
    assert age["recorded"] == 6 and age["under_15"] == 0 and age["implausible"] == 0
    assert age["min"] == 41.0 and age["max"] >= 85.0
    assert sum(b["count"] for b in age["bins"]) == 6
    assert 41.0 < age["median"] < 90.0


def test_manufacturers_are_named_the_way_the_vendors_are_and_unknowns_are_not_a_vendor():
    out = compute()["manufacturer"]
    labels = {r["label"] for r in out["rows"]}
    assert {"Siemens", "Philips", "GE HealthCare"} <= labels
    assert out["recorded"] == 4 and out["not_reported"] == 5
    assert all(r["key"] != "" for r in out["rows"])


def test_year_counts_single_years_and_reports_release_range_strings_instead_of_inventing_a_year():
    year = compute()["year"]
    by = {r["year"]: r["count"] for r in year["rows"]}
    assert by[2000] == 1 and by[2003] == 1 and by[2022] == 1 and by[2020] == 1
    assert year["range_only"] == 1
    assert year["recorded"] == 4


def test_countries_count_each_site_country_once_per_scan():
    country = compute()["country"]
    by = {r["key"]: r["count"] for r in country["rows"]}
    assert by == {"US": 1, "DE": 2, "CH": 1}
    assert country["recorded"] == 3


def test_tumor_split_and_types_across_datasets():
    tumor = compute()["tumor"]
    assert tumor["with_tumor"] == {"PanTS": 1, "CancerVerse": 1, "AbdomenAtlas": 1}
    assert tumor["without_tumor"]["PanTS"] == 3
    types = {r["key"]: r["count"] for r in tumor["types"]}
    assert types["liver"] == 2 and types["kidney"] == 1
    assert {r["key"]: r["label"] for r in tumor["types"]}["liver"] == "Liver"
    assert sum(tumor["with_tumor"].values()) + sum(tumor["without_tumor"].values()) + sum(tumor["unknown"].values()) == 9


def test_slice_thickness_and_coverage_use_the_catalog_shape_and_spacing():
    out = compute()
    thickness = rows(out["slice_thickness"])
    assert thickness["≤ 1 mm"]["count"] == 2 and thickness["1–2 mm"]["count"] == 3
    # 5.0 mm is the top of "3–5 mm": the bounds are inclusive above
    assert thickness["2–3 mm"]["count"] == 3 and thickness["3–5 mm"]["count"] == 1 and thickness["> 5 mm"]["count"] == 0
    cover = rows(out["coverage"])
    assert cover["< 20 cm"]["count"] >= 1 and cover["≥ 80 cm"]["datasets"]["AbdomenAtlas"] == 1
    assert out["slice_thickness"]["recorded"] == 9
    assert out["coverage"]["recorded"] == 8       # the PanTS_00000004 shape has zero slices


def test_completeness_matrix_gives_a_share_per_dataset_and_field():
    matrix = {row["field"]: row["datasets"] for row in compute()["completeness"]}
    assert matrix["sex"]["PanTS"] == {"recorded": 3, "total": 4, "share": 0.75}
    assert matrix["sex"]["AbdomenAtlas"]["share"] == 0.5
    assert matrix["manufacturer"]["CancerVerse"]["recorded"] == 1
    assert set(matrix) == {"sex", "age", "phase", "manufacturer", "model", "year", "country", "tumor"}


# ---------------------------------------------------------------------------------------------- queries
def test_the_statistics_follow_the_same_filters_as_the_library():
    assert compute("dataset=pants")["total"] == 4
    assert compute("dataset=abdomenatlas")["total"] == 2
    male = compute("sex[]=M")
    assert male["total"] == 2 and male["sex"]["recorded"] == 2
    venous = compute("ct_phase[]=venous")
    assert venous["total"] == 2 and rows(venous["phase"])["Venous"]["count"] == 2
    tumor = compute("tumor=1")
    assert tumor["total"] == 3 and sum(tumor["tumor"]["with_tumor"].values()) == 3
    narrowed = compute("tumor_type[]=liver&sex[]=F")
    assert narrowed["total"] == 1                      # only the Atlas liver case is female
    assert compute("sex[]=F")["total"] == 4


def test_an_empty_result_is_all_zeros_not_an_error():
    out = compute("sex[]=M&ct_phase[]=venous&year[]=1999")
    assert out["total"] == 0
    assert out["phase"]["share"] is None and out["age"]["median"] is None and out["sex"]["ratio"] is None
    assert [b["count"] for b in out["age"]["bins"]] == [0] * len(out["age"]["bins"])
    json.dumps(out, allow_nan=False)


def test_a_frame_without_the_optional_columns_still_works():
    bare = pd.DataFrame({"__case_str": ["PanTS_00000001", "CV_00000001"], "__dataset": ["PanTS", "CancerVerse"]})
    out = stats.compute_stats(bare)
    assert out["total"] == 2 and out["phase"]["recorded"] == 0 and out["year"]["rows"] == []
    json.dumps(out, allow_nan=False)


def test_the_output_is_strict_json_and_carries_no_patient_level_field():
    out = compute()
    text = json.dumps(out, allow_nan=False)
    for secret in ("PATIENT-A", "ACC1", "private findings", "CV_00000001", "PanTS_00000001", "BDMAP_00000001", "07-30-2022"):
        assert secret not in text


def test_implausible_ages_are_counted_apart_instead_of_distorting_the_histogram():
    frame = pd.DataFrame({"__dataset": ["PanTS"] * 3, "__age": [40.0, 150.0, -3.0]})
    age = stats.compute_stats(frame)["age"]
    assert age["recorded"] == 1 and age["implausible"] == 2 and age["max"] == 40.0


def test_phase_tokens_map_every_raw_spelling_into_the_four_phases():
    t = stats.phase_tokens
    assert t("Non-contrast") == ["Non-contrast"] and t("plain scan") == ["Non-contrast"]
    assert t("late arterial") == ["Arterial"] and t("portal venous") == ["Venous"]
    assert t("Delayed") == ["Delayed"] and t("excretory") == ["Delayed"]
    assert t("arterial; venous") == ["Arterial", "Venous"]
    assert t("mystery") == ["Other"] and t("") == [] and t(None) == [] and t("Unknown") == [] and t(float("nan")) == []


def test_top_rows_fold_the_tail_into_other_without_losing_scans():
    frame = pd.DataFrame({"__dataset": ["PanTS"] * 12, "__mfr": [f"V{i}" for i in range(8)] + ["V0", "V0", "", None]})
    out = stats.compute_stats(frame)["manufacturer"]
    assert out["rows"][0]["label"] == "V0" and out["rows"][0]["count"] == 3
    assert out["rows"][-1]["key"] == "__other__"
    assert sum(r["count"] for r in out["rows"]) == out["recorded"] == 10


# ---------------------------------------------------------------------------------------------- the route
def call(query=""):
    with APP.test_request_context("/api/stats?" + query):
        return make_response(api_routes.api_stats())     # the error path returns (response, status)


def test_the_route_answers_the_same_numbers_and_echoes_the_query():
    response = call("sex[]=F&dataset=all")
    assert response.status_code == 200
    body = response.get_json()
    assert body["total"] == 4 and body["query"] == "sex[]=F&dataset=all"


def test_the_route_caches_per_filter_set_and_ignores_paging_and_sorting_params():
    api_routes._STATS_CACHE.clear()
    call("sex[]=F")
    call("sex[]=F&page=3&per_page=50&sort_by=id")
    assert len(api_routes._STATS_CACHE) == 1
    call("sex[]=M")
    assert len(api_routes._STATS_CACHE) == 2


def test_the_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(api_routes, "_STATS_CACHE_MAX", 3)
    for year in range(2000, 2008):
        call(f"year[]={year}")
    assert len(api_routes._STATS_CACHE) == 3


def test_a_bad_filter_value_is_a_400_not_a_crash(monkeypatch):
    def boom(*_a, **_k):
        raise ValueError("bad filter")
    monkeypatch.setattr(api_routes, "apply_filters", boom)
    response = call("year_from=abc")
    assert response.status_code == 400 and response.get_json() == {"error": "Invalid filter"}
