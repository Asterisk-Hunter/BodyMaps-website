import { friendlyScanName, getRecentUploadsAccount, hiddenRecentUploadIds, isTerminalStatus, loadRecentUploads, persistRecentUploads, readJobUpdatedAt, RECENT_UPLOADS_MIGRATED, type RecentUpload, type RecentUploadStatus } from './recentUploads';
import { readPipelineStages, type InferenceSelection } from './inferencePipeline';

const statuses: Record<string, RecentUploadStatus> = {
  queued: 'Processing', running: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

function readHistoryPipeline(value: unknown): InferenceSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pipeline = value as Record<string, unknown>;
  if (![null, 'OpenVAE'].includes(pipeline.preprocessing as string | null)
    || ![null, 'ShapeKit'].includes(pipeline.postprocessing as string | null)) return undefined;
  const selection: InferenceSelection = {
    preprocessing: pipeline.preprocessing as InferenceSelection['preprocessing'],
    postprocessing: pipeline.postprocessing as InferenceSelection['postprocessing'],
  };
  if (['pancreatic', 'liver', 'kidney', 'colon'].includes(pipeline.lesion_target as string)) {
    selection.lesionTarget = pipeline.lesion_target as InferenceSelection['lesionTarget'];
  }
  return selection;
}

/** Only call after /me/jobs has verified BOTH the response owner and live account.
 * No paths, error details or arbitrary server fields enter browser storage.
 * Local labels/batches/viewed state are retained; new-device names use model/date.
 */
export function mergeServerHistory(ownerId: string, jobs: unknown[]): void {
  const entries = new Map(loadRecentUploads(ownerId).map(entry => [entry.sessionId, entry]));
  const hidden = hiddenRecentUploadIds(ownerId);
  const newlyRunning: string[] = [];
  const ownedIds = new Set(jobs.flatMap(raw => raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).session_id === 'string'
    ? [(raw as { session_id: string }).session_id] : []));
  for (const [id, entry] of entries) if (entry.serverSynced && !ownedIds.has(id)) entries.delete(id);
  for (const raw of jobs) {
    if (!raw || typeof raw !== 'object') continue;
    const job = raw as Record<string, unknown>;
    if (typeof job.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(job.session_id)
      || hidden.has(job.session_id) || typeof job.model !== 'string' || job.model.length > 128
      || typeof job.status !== 'string' || !Object.hasOwn(statuses, job.status)
      || typeof job.created_at !== 'string') continue;
    // The SQL timestamp is UTC, serialized without an offset by the backend.
    const timestamp = readJobUpdatedAt(job.created_at);
    if (timestamp === undefined) continue;
    const previous = entries.get(job.session_id);
    const version = readJobUpdatedAt(job.updated_at);
    const nextStatus = statuses[job.status];
    if (previous?.serverUpdatedAt !== undefined && version !== undefined && version < previous.serverUpdatedAt) continue;
    // An unversioned/older list must not undo a newer terminal poll or local
    // cancellation. Reopen only on proof of a genuinely newer server attempt.
    if (previous && isTerminalStatus(previous.status) && nextStatus === 'Processing'
      && !(version !== undefined && previous.serverUpdatedAt !== undefined && version > previous.serverUpdatedAt)) continue;
    if ((!previous || previous.status !== 'Processing') && nextStatus === 'Processing') newlyRunning.push(job.session_id);
    const pipeline = readHistoryPipeline(job.pipeline);
    const stages = readPipelineStages(job.pipeline_stages)?.map(stage => ({
      id: stage.id, status: stage.status,
      model: stage.model?.slice(0, 128) ?? null,
      started_at: readJobUpdatedAt(stage.started_at) !== undefined ? stage.started_at : null,
      completed_at: readJobUpdatedAt(stage.completed_at) !== undefined ? stage.completed_at : null,
      // Operator errors and extra server fields must not enter browser storage.
      error: null,
    }));
    entries.set(job.session_id, {
      ...previous,
      sessionId: job.session_id,
      label: previous?.label ?? friendlyScanName(job.model, timestamp),
      model: job.model,
      status: nextStatus,
      timestamp: previous?.timestamp ?? timestamp,
      isReconstruction: previous?.isReconstruction ?? job.model === 'OpenVAE',
      serverSynced: true,
      serverUpdatedAt: version ?? previous?.serverUpdatedAt,
      pipeline: pipeline ?? previous?.pipeline,
      pipelineStages: stages ?? previous?.pipelineStages,
    } satisfies RecentUpload);
  }
  persistRecentUploads([...entries.values()].sort((a, b) => b.timestamp - a.timestamp || a.sessionId.localeCompare(b.sessionId)), ownerId);
  // Reuse the ownership-verified hydration event: Upload reconnects read-only
  // status polling for these jobs; it does not submit inference again.
  if (ownerId === getRecentUploadsAccount() && newlyRunning.length) window.dispatchEvent(
    new CustomEvent(RECENT_UPLOADS_MIGRATED, { detail: { ownerId, sessionIds: newlyRunning } }));
}
