import json
from unittest.mock import Mock

from services.session_mesh_manifest import cached_manifest


def test_repeat_reopen_uses_identical_manifest_without_reloading_segmentation(tmp_path):
    source = tmp_path / 'combined_labels.nii.gz'
    source.write_bytes(b'synthetic-mask')
    manifest = {'caseId': 'owned', 'organs': [{'id': 1}], 'bounds': [0, 1]}
    build = Mock(return_value=manifest)
    assert cached_manifest('owned', source, build, 'labels1') == manifest
    assert cached_manifest('owned', source, build, 'labels1') == manifest
    build.assert_called_once_with('owned', str(source), route_base='sessions')


def test_source_case_and_label_scheme_changes_invalidate_cache(tmp_path):
    source = tmp_path / 'combined_labels.nii.gz'
    source.write_bytes(b'a')
    build = Mock(side_effect=lambda case, *args, **kwargs: {'caseId': case})
    cached_manifest('one', source, build, 'v1')
    cached_manifest('two', source, build, 'v1')
    cached_manifest('two', source, build, 'v2')
    source.write_bytes(b'changed mask')
    cached_manifest('two', source, build, 'v2')
    assert build.call_count == 4


def test_corrupt_cache_is_replaced_and_write_failure_preserves_result(tmp_path, monkeypatch):
    source = tmp_path / 'combined_labels.nii.gz'
    source.write_bytes(b'a')
    target = tmp_path / 'render_only' / 'session_manifest_cache.json'
    target.parent.mkdir()
    target.write_text('{broken')
    build = Mock(return_value={'caseId': 'one'})
    assert cached_manifest('one', source, build, 'v1') == {'caseId': 'one'}
    assert json.loads(target.read_text())['manifest'] == {'caseId': 'one'}
    monkeypatch.setattr('services.session_mesh_manifest.os.replace', Mock(side_effect=OSError('no cache space')), raising=False)
    assert cached_manifest('two', source, build, 'v1') == {'caseId': 'one'}


def test_changed_source_during_build_is_not_cached(tmp_path):
    source = tmp_path / 'combined_labels.nii.gz'
    source.write_bytes(b'a')
    def build(*args, **kwargs):
        source.write_bytes(b'replaced while reading')
        return {'organs': []}
    assert cached_manifest('one', source, build, 'v1') == {'organs': []}
    assert not (tmp_path / 'render_only' / 'session_manifest_cache.json').exists()


def test_route_checks_session_ownership_before_reading_cached_metadata(tmp_path, monkeypatch):
    import importlib
    from flask import Flask, jsonify
    from api import auth
    routes = importlib.import_module('api.api_blueprint')
    source = tmp_path / 'combined_labels.nii.gz'
    source.write_bytes(b'synthetic-labelmap')
    build = Mock(return_value={'caseId': 'owned', 'organs': []})
    monkeypatch.setattr(routes, 'generate_mesh_manifest', build)
    monkeypatch.setattr(routes, '_session_seg_path', lambda sid: str(source))
    monkeypatch.setattr(routes, '_job_for_current_user', lambda sid: ({}, None))
    monkeypatch.setattr(auth, 'current_user', lambda: {'id': 'owner'})
    app = Flask(__name__)
    app.add_url_rule('/api/sessions/<session_id>/mesh-manifest', view_func=routes.get_session_mesh_manifest)
    client = app.test_client()
    assert client.get('/api/sessions/owned/mesh-manifest').get_json() == {'caseId': 'owned', 'organs': []}
    assert client.get('/api/sessions/owned/mesh-manifest').status_code == 200
    assert build.call_count == 1
    monkeypatch.setattr(routes, '_job_for_current_user', lambda sid: (None, (jsonify(error='forbidden'), 403)))
    assert client.get('/api/sessions/owned/mesh-manifest').status_code == 403
    monkeypatch.setattr(auth, 'current_user', lambda: None)
    assert client.get('/api/sessions/owned/mesh-manifest').status_code == 401
    assert build.call_count == 1
