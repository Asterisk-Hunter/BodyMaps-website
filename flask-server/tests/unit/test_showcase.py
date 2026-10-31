"""Fixed catalog selection and production admission boundary; synthetic metadata only."""
import pandas as pd
import pytest
from flask import Flask, jsonify

from api import auth
from api.access_policy import SHOWCASE_READ_ENDPOINTS, install_access_policy
from services import showcase as s


def catalog():
    rows = []
    for i in range(1, 25):
        rows.append({"__case_str": f"PanTS_{i:08d}", "__case_sortkey": i,
                     "__dataset": "PanTS", "__tumor01": i % 2, "__sex": "F" if i % 3 else "M",
                     "__age": 40 + i, "__thumbnail_quality_rank": 0,
                     "__ct_bytes": 1000 - i, "__voxel_count": 1000 - i})
    return pd.DataFrame(rows)


@pytest.fixture(autouse=True)
def reset_cache():
    old = s._catalog, s._rows, s._ids
    yield
    s._catalog, s._rows, s._ids = old


def test_fixed_eight_match_original_strip_and_do_not_depend_on_search(monkeypatch):
    from services.search_ranking import rank_quality_results
    df = catalog()
    expected = []
    cohorts = []
    for tumor in (1, 0):
        ranked = rank_quality_results(df[df.__tumor01 == tumor]).iloc[:8]
        cohorts.append(ranked.iloc[:4])  # this fixture's demographics are all known
    for i in range(4):
        expected.extend(c.iloc[i]["__case_str"] for c in cohorts)
    actual = s.select_showcase(df)
    assert actual.__case_str.tolist() == expected
    assert actual.__tumor01.tolist() == [1, 0] * 4
    assert set(actual.__dataset) == {"PanTS"}
    import services.search_ranking as ranking
    monkeypatch.setattr(ranking, "rank_quality_results", lambda *_a, **_k: pytest.fail("mutable search rule called"))
    assert s.select_showcase(df).__case_str.tolist() == expected


def test_unknown_demographics_preference_is_within_top_eight():
    df = catalog(); df.loc[:1, "__age"] = None
    out = s.select_showcase(df)
    assert not set(df.iloc[:2].__case_str) & set(out.__case_str)


def test_cache_changes_only_on_catalog_reload():
    df = catalog();s.refresh_showcase(df);before = s.showcase_case_ids()
    df["__tumor01"] = 0;s.refresh_showcase(df)
    assert s.showcase_case_ids() == before
    s.refresh_showcase(df.copy())
    assert s.showcase_case_ids() == frozenset()


def test_incomplete_duplicate_and_nonpants_catalog_fail_closed():
    df = catalog()
    assert s.select_showcase(df.iloc[:7]).empty
    bad = df.copy();bad["__dataset"] = "CancerVerse"
    assert s.select_showcase(bad).empty
    bad = df.copy();bad["__case_str"] = "USER_12345678"
    assert s.select_showcase(bad).empty
    bad = pd.concat([df.iloc[:4]] * 4)
    assert s.select_showcase(bad).empty


@pytest.mark.parametrize("value", ["../1", "1/../../x", "USER_1", "CV_00000001", "BDMAP_00000001", "1,x", "1.nii.gz", "١", " 1", "0", "100000000", None])
def test_odd_ids_rejected(value):
    assert s.canonical_showcase_id(value) is None


def test_normal_aliases_match_resolver():
    for value in ("1", "00000001", "PanTS_00000001", "pants1"):
        assert s.canonical_showcase_id(value) == "PanTS_00000001"


RULES = {
    "api.get_main_nifti": "/get-main-nifti/<clabel_id>.nii.gz",
    "api.get_segmentations": "/get-segmentations/<combined_labels_id>.nii.gz",
    "api.get_mesh_manifest": "/cases/<case_id>/mesh-manifest",
    "api.get_mesh_file": "/cases/<display_id>/render_only/liver.glb",
    "api.get_report_data": "/get-report-data/<id>",
    "api.get_case_organ_stats": "/cases/<case_id>/organ-stats",
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(auth, "current_user", lambda: None)
    s.refresh_showcase(catalog())
    app = Flask(__name__);app.config['TESTING'] = True
    def handler(**kwargs):return jsonify(ok=True)
    for endpoint, rule in RULES.items():
        app.add_url_rule('/api' + rule, endpoint=endpoint, view_func=handler, methods=['GET'])
    app.add_url_rule('/api/run-inference',endpoint='api.run_inference',view_func=handler,methods=['POST'])
    app.add_url_rule('/api/new-read/<id>',endpoint='api.future',view_func=handler,methods=['GET'])
    install_access_policy(app)
    return app.test_client()


def url(endpoint,case_id):
    return '/api' + RULES[endpoint].replace('<'+SHOWCASE_READ_ENDPOINTS[endpoint]+'>',case_id)


@pytest.mark.parametrize('endpoint',RULES)
@pytest.mark.parametrize('method',['GET','HEAD'])
def test_each_of_eight_can_open_every_viewer_read(client,endpoint,method):
    for case_id in s.showcase_case_ids():
        response=client.open(url(endpoint,case_id),method=method)
        assert response.status_code==200
        assert 'no-store' in response.headers['Cache-Control']


@pytest.mark.parametrize('endpoint',RULES)
@pytest.mark.parametrize('case_id',['24','CV_00000001','BDMAP_00000001','USER_12345678','1,2'])
def test_no_other_case_can_open(client,endpoint,case_id):
    assert client.get(url(endpoint,case_id)).status_code==401


@pytest.mark.parametrize('endpoint',RULES)
@pytest.mark.parametrize('method',['POST','PUT','PATCH','DELETE'])
def test_writes_stay_blocked(client,endpoint,method):
    assert client.open(url(endpoint,next(iter(s.showcase_case_ids()))),method=method).status_code==401


def test_signed_in_reads_and_private_routes_unchanged(client,monkeypatch):
    assert client.post('/api/run-inference').status_code==401
    assert client.get('/api/new-read/1').status_code==401
    monkeypatch.setattr(auth,'current_user',lambda:{'id':123})
    for endpoint in RULES:
        assert client.get(url(endpoint,'24')).status_code==200
    assert client.post('/api/run-inference').status_code==200


def test_production_showcase_endpoint_matches_server_cache(monkeypatch):
    import api.api_blueprint as routes
    from api.utils import row_to_item
    df=catalog();s.refresh_showcase(df)
    app=Flask(__name__)
    with app.test_request_context('/api/showcase'):
        items=routes.api_showcase().get_json()['items']
    assert [i['case_id'] for i in items]==s.showcase_rows().__case_str.tolist()
    assert set(i['case_id'] for i in items)==s.showcase_case_ids()
    assert len(items)==8


def test_readonly_organ_stats_uses_only_catalog_lookup(monkeypatch):
    import api.api_blueprint as routes
    seen=[]
    monkeypatch.setattr(routes,'mount_down_response',lambda:None)
    monkeypatch.setattr(routes,'_mask_data_for_case',lambda case_id:seen.append(case_id) or {'liver':{'mean_hu':50}})
    app=Flask(__name__)
    with app.test_request_context('/api/cases/1/organ-stats'):
        assert routes.get_case_organ_stats('PanTS_00000001').get_json()=={'liver':{'mean_hu':50}}
        assert routes.get_case_organ_stats('USER_1')[1]==400
    assert seen==['1']


@pytest.mark.parametrize('raises', [False, True])
def test_readonly_organ_stats_does_not_expose_internal_errors(monkeypatch, raises):
    import api.api_blueprint as routes
    secret = '/private/dataset/scan.nii.gz: INTERNAL_TRACE_MARKER'
    def unavailable(case_id):
        if raises:
            raise RuntimeError(secret)
        return {'error': secret, 'traceback': secret}
    monkeypatch.setattr(routes, 'mount_down_response', lambda: None)
    monkeypatch.setattr(routes, '_mask_data_for_case', unavailable)
    app = Flask(__name__)
    with app.test_request_context('/api/cases/1/organ-stats'):
        response = app.make_response(routes.get_case_organ_stats('1'))
        assert response.status_code == 503
        assert response.get_json() == {'error': 'Organ statistics are temporarily unavailable.'}
        assert secret not in response.get_data(as_text=True)


def test_mask_computation_returns_generic_error_not_exception(monkeypatch):
    import api.utils as utils
    secret = '/private/dataset/scan.nii.gz: INTERNAL_TRACE_MARKER'
    def broken_processor(*args):
        raise RuntimeError(secret)
    monkeypatch.setattr(utils, 'viewer_labelmap_path', lambda path: path)
    monkeypatch.setattr(utils, 'NiftiProcessor', broken_processor)
    result = utils.get_mask_data_internal('1')
    assert result == {'error': 'Organ statistics are temporarily unavailable.'}
    assert secret not in str(result)
