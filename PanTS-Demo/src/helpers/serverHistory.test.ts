import { beforeEach, expect, it, vi } from 'vitest';
import { mergeServerHistory } from './serverHistory';
import { addRecentUpload, loadRecentUploads, removeRecentUpload, setRecentUploadsAccount, updateRecentUploadStatus, RECENT_UPLOADS_MIGRATED } from './recentUploads';

const job = { session_id: 'finished-3-days-ago', model: 'LesionSegmenter', status: 'completed', created_at: '2026-10-23T12:00:00' };
beforeEach(() => { localStorage.clear(); setRecentUploadsAccount('u1'); });

it.each(['Completed', 'Failed', 'Cancelled'] as const)('does not regress a newer %s poll on a delayed running history response', status => {
  mergeServerHistory('u1', [{ ...job, status: 'running', updated_at: '2026-10-23T12:00:01' }]);
  updateRecentUploadStatus(job.session_id, status, 'u1', '2026-10-23T12:00:02');
  mergeServerHistory('u1', [{ ...job, status: 'running', updated_at: '2026-10-23T12:00:01' }]);
  expect(loadRecentUploads()[0].status).toBe(status);
});

it('keeps an unversioned local cancellation terminal until a terminal server confirmation', () => {
  mergeServerHistory('u1', [{ ...job, status: 'running', updated_at: '2026-10-23T12:00:01' }]);
  updateRecentUploadStatus(job.session_id, 'Cancelled');
  mergeServerHistory('u1', [{ ...job, status: 'running', updated_at: '2026-10-23T12:00:03' }]);
  expect(loadRecentUploads()[0].status).toBe('Cancelled');
  mergeServerHistory('u1', [{ ...job, updated_at: '2026-10-23T12:00:04' }]);
  expect(loadRecentUploads()[0].status).toBe('Completed');
});

it('allows a provably newer retry and reconnects its polling only once', () => {
  mergeServerHistory('u1', [{ ...job, updated_at: '2026-10-23T12:00:02' }]);
  const listener = vi.fn();
  window.addEventListener(RECENT_UPLOADS_MIGRATED, listener);
  try {
    const retry = { ...job, status: 'running', updated_at: '2026-10-23T12:00:03' };
    mergeServerHistory('u1', [retry]);
    mergeServerHistory('u1', [retry]);
    expect(loadRecentUploads()[0].status).toBe('Processing');
    expect(listener).toHaveBeenCalledOnce();
    updateRecentUploadStatus(job.session_id, 'Completed', 'u1', '2026-10-23T12:00:02');
    expect(loadRecentUploads()[0].status).toBe('Processing');
  } finally { window.removeEventListener(RECENT_UPLOADS_MIGRATED, listener); }
});

it('restores validated pipeline provenance and whitelists stage metadata', () => {
  mergeServerHistory('u1', [{ ...job,
    pipeline: { preprocessing: 'OpenVAE', postprocessing: 'ShapeKit', lesion_target: 'liver', private_path: '/secret' },
    pipeline_stages: [{ id: 'segmentation', model: 'LesionSegmenter', status: 'completed', started_at: '2026-10-23T12:00:00', completed_at: 'bad', error: 'secret', private_path: '/secret' }],
  }]);
  expect(loadRecentUploads()[0].pipeline).toEqual({ preprocessing: 'OpenVAE', postprocessing: 'ShapeKit', lesionTarget: 'liver' });
  expect(loadRecentUploads()[0].pipelineStages).toEqual([{ id: 'segmentation', model: 'LesionSegmenter', status: 'completed', started_at: '2026-10-23T12:00:00', completed_at: null, error: null }]);
  expect(JSON.stringify(loadRecentUploads())).not.toContain('secret');
});

it('restores completed server jobs on a device with empty local storage', () => {
  mergeServerHistory('u1', [job]);
  expect(loadRecentUploads()).toEqual([expect.objectContaining({ sessionId: job.session_id, status: 'Completed', timestamp: Date.parse('2026-10-23T12:00:00Z') })]);
});

it('preserves local names, batch membership and viewed state, updating server status', () => {
  addRecentUpload({ sessionId: job.session_id, label: 'My scan', model: job.model, status: 'Processing', timestamp: 1, batchId: 'batch', viewed: true });
  mergeServerHistory('u1', [job, job]);
  expect(loadRecentUploads()).toEqual([expect.objectContaining({ label: 'My scan', batchId: 'batch', viewed: true, status: 'Completed' })]);
});

it('ignores malformed jobs and never stores server paths or exception details', () => {
  mergeServerHistory('u1', [{...job, ct_path: '/private/scan', error: 'secret'}, {...job, session_id: '../other'}, {...job, created_at: 'bad'}, {...job, status: 'constructor'}]);
  expect(loadRecentUploads()).toHaveLength(1);
  expect(JSON.stringify(loadRecentUploads())).not.toMatch(/private|secret|ct_path/);
});

it('does not resurrect removed rows or leak history across account scopes', () => {
  mergeServerHistory('u1', [job]);
  removeRecentUpload(job.session_id);
  mergeServerHistory('u1', [job]);
  expect(loadRecentUploads()).toEqual([]);
  setRecentUploadsAccount('u2');
  expect(loadRecentUploads()).toEqual([]);
});

it('restores OpenVAE to the reconstruction route and caps the list', () => {
  mergeServerHistory('u1', Array.from({ length: 220 }, (_, i) => ({...job, session_id: `scan-${i}`, model: 'OpenVAE'})));
  expect(loadRecentUploads()).toHaveLength(200);
  expect(loadRecentUploads().every(scan => scan.isReconstruction)).toBe(true);
});

it('removes server-confirmed history deleted elsewhere without discarding local pending uploads', () => {
  mergeServerHistory('u1', [job]);
  addRecentUpload({ sessionId: 'not-on-server-yet', label: 'Pending upload', model: job.model, status: 'Processing', timestamp: 1 });
  mergeServerHistory('u1', []);
  expect(loadRecentUploads().map(scan => scan.sessionId)).toEqual(['not-on-server-yet']);
});

it('notifies the workspace to reconnect status polling only for new running jobs', () => {
  const listener = vi.fn();
  window.addEventListener(RECENT_UPLOADS_MIGRATED, listener);
  try {
    mergeServerHistory('u1', [{...job, status: 'running'}]);
    mergeServerHistory('u1', [{...job, status: 'running'}]);
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ ownerId: 'u1', sessionIds: [job.session_id] });
  } finally { window.removeEventListener(RECENT_UPLOADS_MIGRATED, listener); }
});
