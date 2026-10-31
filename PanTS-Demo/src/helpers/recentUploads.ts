// Recent uploads are scoped to the authenticated account on this browser.
// The legacy, unscoped key is retained only for ownership-verified migration.

import type { InferenceSelection, PipelinePreviewSelection, PipelineStage } from "./inferencePipeline";

export type RecentUploadStatus = "Processing" | "Completed" | "Failed" | "Cancelled";

export type RecentUpload = PipelinePreviewSelection & {
	sessionId: string;
	// User-facing name. Defaults to a friendly "<model> · <date>" (see
	// friendlyScanName) rather than the raw upload filename, and is renameable.
	label: string;
	// The original filename, kept for reference (shown as a tooltip) even after
	// the label is renamed. Optional so older localStorage entries still parse.
	sourceName?: string;
	model: string;
	// Choices captured when Run was pressed, never read from later composer state.
	pipeline?: InferenceSelection;
	pipelineStages?: PipelineStage[];
	status: RecentUploadStatus;
	timestamp: number;
	isReconstruction?: boolean;
	// Scans run together (multi-select) share a batchId + batchLabel. A scan run
	// on its own has neither and is treated as an individual entry.
	batchId?: string;
	batchLabel?: string;
	// Has the user opened this scan's result yet? Drives the Upload page's
	// completed-uploads list: an unviewed finished scan stays there regardless
	// of age (that's the whole point - it's still waiting to be looked at),
	// while a viewed one is done being "new" and behaves like any other
	// finished scan for the age-based History split. Optional/undefined for
	// older localStorage entries and for anything still Processing.
	viewed?: boolean;
	// Server-confirmed entries can be removed when absent from a later owned list.
	serverSynced?: boolean;
	// Last server status version; never compare server time with the device clock.
	serverUpdatedAt?: number;
};

// Retain the original key as an archive; never display it as the active user's history.
export const RECENT_UPLOADS_KEY = "recentUploads";
let activeAccountId: string | null = null;
export const getRecentUploadsAccount = (): string | null => activeAccountId;
export const recentUploadsStorageKey = (ownerId: string): string =>
	`${RECENT_UPLOADS_KEY}:${encodeURIComponent(ownerId)}`;
export const isRecentUploadsStorageKey = (key: string | null): boolean =>
	key === null || key === RECENT_UPLOADS_KEY || key.startsWith(`${RECENT_UPLOADS_KEY}:`);
export const setRecentUploadsAccount = (ownerId: string | null): void => {
	if (activeAccountId === ownerId) return;
	activeAccountId = ownerId;
	window.dispatchEvent(new Event(RECENT_UPLOADS_CHANGED));
};
export const RECENT_UPLOADS_CHANGED = "bodymaps:recent-uploads-changed";
export const RECENT_UPLOADS_MIGRATED = "bodymaps:recent-uploads-migrated";
export type RecentUploadsMigratedDetail = { ownerId: string; sessionIds: string[] };
// Raised from 8 so a multi-scan batch isn't half-evicted from the list, and
// again from 60 once anything older than a day became the History page's
// content — a history that forgets your 61st scan isn't much of one.
export const MAX_RECENT_UPLOADS = 200;

const TERMINAL: RecentUploadStatus[] = ["Completed", "Failed", "Cancelled"];
export const isTerminalStatus = (s: RecentUploadStatus): boolean => TERMINAL.includes(s);

// A grouped view over the flat upload list: each entry is either a lone scan or
// a batch of scans sharing a batchId. Ordered by most-recent activity.
export type UploadGroup =
	| { kind: "single"; upload: RecentUpload; timestamp: number }
	| {
			kind: "batch";
			batchId: string;
			label: string;
			uploads: RecentUpload[];
			timestamp: number;
	  };

export const groupUploads = (list: RecentUpload[]): UploadGroup[] => {
	const batches = new Map<string, RecentUpload[]>();
	const groups: UploadGroup[] = [];

	for (const u of list) {
		if (u.batchId) {
			if (!batches.has(u.batchId)) batches.set(u.batchId, []);
			batches.get(u.batchId)!.push(u);
		} else {
			groups.push({ kind: "single", upload: u, timestamp: u.timestamp });
		}
	}

	for (const [batchId, uploads] of batches) {
		groups.push({
			kind: "batch",
			batchId,
			label: uploads[0].batchLabel || `${uploads.length} scans`,
			uploads,
			timestamp: Math.max(...uploads.map((u) => u.timestamp)),
		});
	}

	return groups.sort((a, b) => b.timestamp - a.timestamp);
};

// A batch is "in flight" while any of its scans is still processing; it's
// "done" once every scan has reached a terminal state.
export const isGroupInFlight = (g: UploadGroup): boolean =>
	g.kind === "single"
		? g.upload.status === "Processing"
		: g.uploads.some((u) => u.status === "Processing");

// Longest a finished scan stays on the Upload page if it's never opened - a
// day is generous enough to notice it finished, but the page still shouldn't
// accumulate scans someone genuinely walked away from forever.
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// A group counts as "viewed" once every scan in it has been opened - a batch
// with one scan still unlooked-at is still something to come back to. Only a
// Completed scan can be opened, so a batch is judged by those: a failed or
// cancelled one never gets a View button and must not hold the rest here. A
// batch with nothing to open is left to the age cutoff.
const isGroupViewed = (g: UploadGroup): boolean => {
	if (g.kind === "single") return Boolean(g.upload.viewed);
	const viewable = g.uploads.filter((u) => u.status === "Completed");
	return viewable.length > 0 && viewable.every((u) => Boolean(u.viewed));
};

// What a screen reader hears once a batch stops running ("3 scans: 2 of 3
// complete, 1 failed"); empty while any scan in it is still going.
export const batchAnnouncement = (title: string, uploads: RecentUpload[]): string => {
	const count = (status: RecentUploadStatus) => uploads.filter((u) => u.status === status).length;
	if (count("Processing") > 0) return "";
	const failed = count("Failed");
	const cancelled = count("Cancelled");
	return `${title}: ${count("Completed")} of ${uploads.length} complete${failed ? `, ${failed} failed` : ""}${cancelled ? `, ${cancelled} cancelled` : ""}`;
};

/** Split finished groups into what the Upload page shows and what History gets.
 *  A group belongs to History once it's been viewed (its job here is done -
 *  see markRecentUploadViewed) OR once RECENT_WINDOW_MS has passed unviewed,
 *  whichever comes first. A batch is judged by its most recent scan for the
 *  age check, so a batch straddling the age boundary stays whole rather than
 *  being torn in half. */
export const splitByAge = (
	groups: UploadGroup[],
	now: number = Date.now()
): { recent: UploadGroup[]; older: UploadGroup[] } => {
	const cutoff = now - RECENT_WINDOW_MS;
	const belongsToHistory = (g: UploadGroup) => isGroupViewed(g) || g.timestamp < cutoff;
	return {
		recent: groups.filter((g) => !belongsToHistory(g)),
		older: groups.filter(belongsToHistory),
	};
};

const readUploads = (key: string): RecentUpload[] => {
	try {
		const arr: unknown = JSON.parse(localStorage.getItem(key) || "[]");
		if (!Array.isArray(arr)) return [];
		return arr.filter((entry): entry is RecentUpload => entry !== null && typeof entry === "object"
			&& typeof entry.sessionId === "string" && entry.sessionId.length > 0
			&& typeof entry.label === "string" && typeof entry.model === "string"
			&& ["Processing", ...TERMINAL].includes(entry.status)
			&& typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))
			.slice(0, MAX_RECENT_UPLOADS);
	} catch {
		return [];
	}
};

export const loadRecentUploads = (ownerId: string | null = activeAccountId): RecentUpload[] =>
	ownerId ? readUploads(recentUploadsStorageKey(ownerId)) : [];

export const hasLegacyRecentUploads = (): boolean => readUploads(RECENT_UPLOADS_KEY).length > 0;

export const persistRecentUploads = (list: RecentUpload[], ownerId: string | null = activeAccountId) => {
	if (!ownerId) return;
	try {
		localStorage.setItem(recentUploadsStorageKey(ownerId), JSON.stringify(list.slice(0, MAX_RECENT_UPLOADS)));
		if (ownerId === activeAccountId) window.dispatchEvent(new Event(RECENT_UPLOADS_CHANGED));
	} catch (e) {
		console.warn("saveRecentUploads failed", e);
	}
};

/** Only GET /api/me/jobs may supply these IDs: it filters strictly by the
 * authenticated owner, unlike an admin-capable result endpoint. Keep unknown
 * legacy entries archived instead of attributing them to the next sign-in. */
export const migrateVerifiedRecentUploads = (ownerId: string, ownedSessionIds: Iterable<string>): void => {
	const owned = new Set(ownedSessionIds);
	const existing = loadRecentUploads(ownerId);
	const alreadyScoped = new Set(existing.map((entry) => entry.sessionId));
	const markerKey = `recentUploadsMigration:${encodeURIComponent(ownerId)}`;
	let imported: Set<string>;
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(markerKey) || "[]");
		imported = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
	} catch { imported = new Set(); }
	const legacy = readUploads(RECENT_UPLOADS_KEY);
	const verified = legacy.filter((entry) => owned.has(entry.sessionId)
		&& !alreadyScoped.has(entry.sessionId) && !imported.has(entry.sessionId));
	if (verified.length) persistRecentUploads(
		[...existing, ...verified].sort((a, b) => b.timestamp - a.timestamp), ownerId);
	// Once imported, an explicitly removed entry must stay removed on the next
	// sign-in. Keep the source archive, but remember IDs actually saved before.
	const persisted = new Set(loadRecentUploads(ownerId).map((entry) => entry.sessionId));
	legacy.forEach((entry) => { if (owned.has(entry.sessionId) && persisted.has(entry.sessionId)) imported.add(entry.sessionId); });
	try { localStorage.setItem(markerKey, JSON.stringify([...imported])); } catch { /* optional migration bookkeeping */ }
	const sessionIds = verified.filter((entry) => persisted.has(entry.sessionId)).map((entry) => entry.sessionId);
	if (ownerId === activeAccountId && sessionIds.length) window.dispatchEvent(
		new CustomEvent<RecentUploadsMigratedDetail>(RECENT_UPLOADS_MIGRATED, { detail: { ownerId, sessionIds } }));
};

// Capture ownerId when starting asynchronous work: a late response must never
// write into an account that signed in while that request was in flight.
export const addRecentUpload = (entry: RecentUpload, ownerId: string | null = activeAccountId): RecentUpload[] => {
	if (!ownerId) return [];
	try {
		const hidden = hiddenRecentUploadIds(ownerId);
		if (hidden.delete(entry.sessionId)) localStorage.setItem(`hiddenRecentUploads:${encodeURIComponent(ownerId)}`, JSON.stringify([...hidden]));
	} catch { /* optional local removal bookkeeping */ }
	const list = [entry, ...loadRecentUploads(ownerId).filter((u) => u.sessionId !== entry.sessionId)];
	const trimmed = list.slice(0, MAX_RECENT_UPLOADS);
	persistRecentUploads(trimmed, ownerId);
	return trimmed;
};

export const removeRecentUpload = (sessionId: string, ownerId: string | null = activeAccountId): RecentUpload[] => {
	if (ownerId) {
		try {
			const ids = hiddenRecentUploadIds(ownerId);
			ids.add(sessionId);
			localStorage.setItem(`hiddenRecentUploads:${encodeURIComponent(ownerId)}`, JSON.stringify([...ids].slice(-MAX_RECENT_UPLOADS)));
		} catch { /* optional local removal bookkeeping */ }
	}
	const list = loadRecentUploads(ownerId).filter((u) => u.sessionId !== sessionId);
	persistRecentUploads(list, ownerId);
	return list;
};

/** Per-browser removals must not reappear on every server-history refresh. */
export const hiddenRecentUploadIds = (ownerId: string): Set<string> => {
	try {
		const ids: unknown = JSON.parse(localStorage.getItem(`hiddenRecentUploads:${encodeURIComponent(ownerId)}`) || '[]');
		return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
	} catch { return new Set(); }
};

export const updateRecentUploadStatus = (
	sessionId: string,
	status: RecentUploadStatus,
	ownerId: string | null = activeAccountId,
	updatedAt?: unknown,
): RecentUpload[] => {
	const version = readJobUpdatedAt(updatedAt);
	const list = loadRecentUploads(ownerId).map((u) => {
		if (u.sessionId !== sessionId || (version !== undefined && u.serverUpdatedAt !== undefined && version < u.serverUpdatedAt)) return u;
		return { ...u, status, serverUpdatedAt: version };
	});
	persistRecentUploads(list, ownerId);
	return list;
};

/** Stages are updated only from an authenticated server status response. */
export const updateRecentUploadStages = (sessionId: string, pipelineStages: PipelineStage[], ownerId: string | null = activeAccountId, updatedAt?: unknown): RecentUpload[] => {
	const version = readJobUpdatedAt(updatedAt);
	const list = loadRecentUploads(ownerId).map((u) => {
		if (u.sessionId !== sessionId || (version !== undefined && u.serverUpdatedAt !== undefined && version < u.serverUpdatedAt)) return u;
		return { ...u, pipelineStages, serverUpdatedAt: version ?? u.serverUpdatedAt };
	});
	persistRecentUploads(list, ownerId);
	return list;
};

/** Backend SQL timestamps are UTC but older serializers omit their offset. */
export const readJobUpdatedAt = (value: unknown): number | undefined => {
	if (typeof value !== 'string' || value.length > 64) return undefined;
	const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? timestamp : undefined;
};

export const markRecentUploadViewed = (sessionId: string, ownerId: string | null = activeAccountId): RecentUpload[] => {
	const list = loadRecentUploads(ownerId).map((u) =>
		u.sessionId === sessionId && !u.viewed ? { ...u, viewed: true } : u
	);
	persistRecentUploads(list, ownerId);
	return list;
};

export const renameRecentUpload = (
	sessionId: string,
	label: string,
	ownerId: string | null = activeAccountId
): RecentUpload[] => {
	const list = loadRecentUploads(ownerId).map((u) => {
		if (u.sessionId !== sessionId) return u;
		const next = label.trim();
		return { ...u, label: next || friendlyScanName(u.model, u.timestamp) };
	});
	persistRecentUploads(list, ownerId);
	return list;
};

// A meaningful default name for a scan: the model it was run with plus the date,
// e.g. "ePAI · Aug 13, 2026". Far more useful in the history list than the raw
// upload filename (often "ct.nii.gz" or a cryptic export name). The user can
// rename it afterwards.
export const friendlyScanName = (model: string, timestamp: number): string => {
	const who = model && model !== "None" ? model : "Scan";
	let date: string;
	try {
		date = new Date(timestamp).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		date = new Date(timestamp).toISOString().slice(0, 10);
	}
	return `${who} · ${date}`;
};

export const formatRelativeTime = (ts: number): string => {
	const mins = Math.floor((Date.now() - ts) / 60000);
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "Yesterday" : `${days} days ago`;
};

export const recentStatusColor = (status: RecentUploadStatus): string =>
	status === "Failed"
		? "#ef4444"
		: status === "Cancelled"
			? "#d97706"
			: status === "Processing"
				? "#6a6a6a"
				: "#8f8f8f";
