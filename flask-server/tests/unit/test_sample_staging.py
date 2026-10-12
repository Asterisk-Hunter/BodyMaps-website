from pathlib import Path
import os
import uuid
import threading

import nibabel as nib
import numpy as np
import pytest

from services import sample_staging as staging


@pytest.fixture
def rig(tmp_path):
    dataset = tmp_path / 'dataset'
    dataset.mkdir()
    source = dataset / 'ct.nii.gz'
    nib.save(nib.Nifti1Image(np.zeros((4, 5, 6), dtype=np.int16), np.eye(4)), source)
    store = staging.SampleStager(tmp_path / 'sessions', 'owner')
    return store, source, lambda: iter([('PanTS_00000002', source, dataset)])


def test_original_bytes_preserved_and_replay_does_not_recopy(rig):
    store, source, candidates = rig
    original = source.read_bytes()
    sid = str(uuid.uuid4())
    result = store.prepare(sid, candidates)
    assert result['size'] == len(original)
    assert result['uploaded_filename'] == 'BDMAP_SAMPLE/ct.nii.gz'
    assert result['preview_url'] == f'/api/session-ct/{sid}'
    assert not result['reused']
    assert (store.folder(sid) / staging.TARGET).read_bytes() == original
    assert source.read_bytes() == original
    def never():
        raise AssertionError('Replay must not read the dataset')
    assert store.prepare(sid, never) == {**result, 'reused': True}


@pytest.mark.parametrize('sid', ['../escape', '', '/tmp/absolute', 'x', '00000000/../abc', None])
def test_invalid_session_rejected_before_filesystem_creation(rig, sid):
    store, _, candidates = rig
    with pytest.raises(staging.SampleError) as error:
        store.prepare(sid, candidates)
    assert error.value.status == 400
    assert not store.root.exists()


def test_other_account_cannot_read_replay_or_delete(rig):
    store, source, candidates = rig
    sid = str(uuid.uuid4())
    store.prepare(sid, candidates)
    other = staging.SampleStager(store.root, 'other')
    for operation in (lambda: other.result(sid), lambda: other.prepare(sid, candidates), lambda: other.delete(sid)):
        with pytest.raises(staging.SampleError) as error:
            operation()
        assert error.value.status == 403
    assert (store.folder(sid) / staging.TARGET).read_bytes() == source.read_bytes()


def test_existing_normal_upload_is_never_overwritten(rig):
    store, _, candidates = rig
    sid = str(uuid.uuid4())
    folder = store.folder(sid)
    folder.mkdir(parents=True)
    (folder / '.owner').write_text('owner')
    (folder / 'original.txt').write_text('retain')
    with pytest.raises(staging.SampleError) as error:
        store.prepare(sid, candidates)
    assert error.value.status == 409
    assert (folder / 'original.txt').read_text() == 'retain'


def test_missing_corrupt_and_outside_root_candidates_fall_back(rig, tmp_path):
    store, source, _ = rig
    corrupt = source.parent / 'corrupt.nii.gz'
    corrupt.write_bytes(b'not a nifti')
    outside = tmp_path / 'outside.nii.gz'
    outside.write_bytes(source.read_bytes())
    candidates = lambda: iter([
        ('PanTS_00000001', source.parent / 'missing', source.parent),
        ('PanTS_00000002', corrupt, source.parent),
        ('PanTS_00000003', outside, source.parent),
        ('../../not-a-case', source, source.parent),
        ('PanTS_00000004', source, source.parent),
    ])
    result = store.prepare(str(uuid.uuid4()), candidates)
    assert result['case_id'] == 'PanTS_00000004'
    assert outside.read_bytes() == source.read_bytes()


def test_actual_file_size_limit_ignores_stale_index(rig, monkeypatch):
    store, source, _ = rig
    large = source.parent / 'large.nii.gz'
    nib.save(nib.Nifti1Image(np.arange(10**3, dtype=np.int16).reshape(10, 10, 10), np.eye(4)), large)
    monkeypatch.setattr(staging, 'SAMPLE_MAX_CT_BYTES', source.stat().st_size)
    result = store.prepare(str(uuid.uuid4()), lambda: iter([
        ('PanTS_00000001', large, source.parent), ('PanTS_00000002', source, source.parent),
    ]))
    assert result['case_id'] == 'PanTS_00000002'


def test_unavailable_sample_cleans_partial_copy_and_reservation(rig):
    store, _, _ = rig
    sid = str(uuid.uuid4())
    with pytest.raises(staging.SampleError) as error:
        store.prepare(sid, lambda: iter([]))
    assert error.value.code == 'sample_unavailable'
    assert not store.folder(sid).exists()
    assert store._slots() == []


def test_pending_limit_survives_new_service_instance_and_delete_releases_slot(rig):
    store, _, candidates = rig
    ids = [str(uuid.uuid4()) for _ in range(4)]
    for sid in ids[:3]:
        store.prepare(sid, candidates)
    other_process = staging.SampleStager(store.root, store.user)
    with pytest.raises(staging.SampleError) as error:
        other_process.prepare(ids[3], candidates)
    assert error.value.code == 'sample_staging_limit'
    other_process.delete(ids[0])
    assert not store.folder(ids[0]).exists()
    assert other_process.prepare(ids[3], candidates)['session_id'] == ids[3]


def test_expiry_removes_unclaimed_copies_but_not_active_admission(rig):
    store, source, candidates = rig
    sid = str(uuid.uuid4())
    store.prepare(sid, candidates)
    for slot, _, _ in store._slots():
        os.utime(slot, (0, 0))
    store.busy = lambda value: value == sid
    store.expire()
    assert store.folder(sid).exists()
    store.busy = lambda value: False
    store.expire()
    assert not store.folder(sid).exists()
    assert source.exists()


def test_consumed_copy_releases_slot_without_waiting_an_hour(rig):
    store, source, candidates = rig
    sid = str(uuid.uuid4())
    store.prepare(sid, candidates)
    store.consumed = lambda value: value == sid
    store.expire()
    assert not store.folder(sid).exists()
    assert not store._slots()
    assert source.exists()


def test_expiry_holds_admission_lock_through_check_and_removal(rig, monkeypatch):
    store, source, candidates = rig
    sid = str(uuid.uuid4())
    store.prepare(sid, candidates)
    for slot, _, _ in store._slots():
        os.utime(slot, (0, 0))
    admission_lock = threading.Lock()
    store.cleanup_guard = lambda: admission_lock
    observed = []
    def busy(value):
        assert admission_lock.locked()
        observed.append('checked')
        return False
    store.busy = busy
    real_remove = staging.shutil.rmtree
    def remove(path):
        assert admission_lock.locked()
        observed.append('removed')
        real_remove(path)
    monkeypatch.setattr(staging.shutil, 'rmtree', remove)
    store.expire()
    assert observed == ['checked', 'removed']
    assert not admission_lock.locked()
    assert source.exists()


def test_cancellation_during_copy_publication_cannot_publish_result(rig, monkeypatch):
    store, source, candidates = rig
    sid = str(uuid.uuid4())
    original = source.read_bytes()
    real_replace = staging.os.replace
    def cancel_after_copy(src, dst):
        real_replace(src, dst)
        if Path(dst).name == 'ct.nii.gz':
            store.delete(sid)
    monkeypatch.setattr(staging.os, 'replace', cancel_after_copy)
    with pytest.raises(staging.SampleError) as error:
        store.prepare(sid, candidates)
    assert error.value.code == 'sample_cancelled'
    assert not store.folder(sid).exists()
    assert store._slots() == []
    assert source.read_bytes() == original


def test_concurrent_replay_is_retriable_and_does_not_delete_active_copy(rig):
    store, _, candidates = rig
    sid = str(uuid.uuid4())
    def concurrent():
        with pytest.raises(staging.SampleError) as error:
            store.prepare(sid, candidates)
        assert error.value.code == 'sample_preparing'
        assert store.folder(sid).exists()
        yield from candidates()
    assert store.prepare(sid, concurrent)['session_id'] == sid


def test_preparation_lock_setup_failure_releases_claim_and_reservation(rig, monkeypatch):
    store, _, candidates = rig
    sid = str(uuid.uuid4())
    real_touch = Path.touch
    def fail_lock(path, *args, **kwargs):
        if path.name == '.sample-preparing':
            raise OSError('Injected setup failure')
        return real_touch(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'touch', fail_lock)
    with pytest.raises(OSError, match='Injected setup failure'):
        store.prepare(sid, candidates)
    assert not store.folder(sid).exists()
    assert store._slots() == []


def test_delete_during_initial_claim_cancels_without_leaking_reservation(rig, monkeypatch):
    store, _, candidates = rig
    sid = str(uuid.uuid4())
    claim_started, allow_claim, delete_started, delete_done = (threading.Event() for _ in range(4))
    errors = []
    real_touch = Path.touch
    def pause_marker(path, *args, **kwargs):
        result = real_touch(path, *args, **kwargs)
        if path.name == staging.MARKER:
            claim_started.set()
            assert allow_claim.wait(5)
        return result
    monkeypatch.setattr(Path, 'touch', pause_marker)
    def after_delete():
        assert delete_done.wait(5)
        yield from candidates()
    def prepare():
        try:
            store.prepare(sid, after_delete)
        except BaseException as error:
            errors.append(error)
    def delete():
        delete_started.set()
        try:
            staging.SampleStager(store.root, store.user).delete(sid)
        except BaseException as error:
            errors.append(error)
        finally:
            delete_done.set()
    producer = threading.Thread(target=prepare)
    remover = threading.Thread(target=delete)
    producer.start()
    assert claim_started.wait(5)
    remover.start()
    assert delete_started.wait(5)
    assert not delete_done.wait(0.05), 'DELETE must wait until the preparation claim is complete'
    allow_claim.set()
    producer.join(10)
    remover.join(10)
    assert not producer.is_alive() and not remover.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], staging.SampleError)
    assert errors[0].code == 'sample_cancelled'
    assert not store.folder(sid).exists() and store._slots() == []


def test_expiry_cannot_unlink_a_concurrently_reused_reservation(rig, monkeypatch):
    store, _, candidates = rig
    old, new = str(uuid.uuid4()), str(uuid.uuid4())
    store.prepare(old, candidates)
    for slot, _, _ in store._slots():
        os.utime(slot, (0, 0))
    deleting, resume, reserving, done = (threading.Event() for _ in range(4))
    errors = []
    real_remove = staging.shutil.rmtree
    def pause_remove(path):
        real_remove(path)
        if Path(path).name == old:
            deleting.set()
            assert resume.wait(5)
    monkeypatch.setattr(staging.shutil, 'rmtree', pause_remove)
    def expire():
        try:
            store.expire()
        except BaseException as error:
            errors.append(error)
    def reserve():
        reserving.set()
        try:
            staging.SampleStager(store.root, store.user).prepare(new, candidates)
        except BaseException as error:
            errors.append(error)
        finally:
            done.set()
    cleaner, producer = threading.Thread(target=expire), threading.Thread(target=reserve)
    cleaner.start()
    assert deleting.wait(5)
    producer.start()
    assert reserving.wait(5)
    assert not done.wait(0.05), 'Reservation reuse must wait for old-slot cleanup'
    resume.set()
    cleaner.join(10)
    producer.join(10)
    assert not cleaner.is_alive() and not producer.is_alive()
    assert errors == []
    assert [record['session_id'] for _, record, _ in store._slots()] == [new]
    assert store.result(new)['session_id'] == new
