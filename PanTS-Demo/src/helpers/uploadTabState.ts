import { getRecentUploadsAccount, loadRecentUploads } from "./recentUploads";

// Uploads outlive the page that started them. Leaving /upload unmounts the page,
// but an upload or a run request already under way carries on in the old page's
// closures, and the page mounted on return used to start the same session again:
// a second copy of the file racing the first to finalize, a second run request,
// or a poll for a job that did not exist yet, which marked the run Failed after
// three misses. So the abort controllers, the upload progress and a hold on every
// session whose upload or run request is still going live here, where every
// mount of the page sees them. A held session is left to finish, and the page
// that is showing takes it up from the state it ended in.

/** One AbortController per session with an upload or run request in flight. */
export const uploadControllers = new Map<string, AbortController>();
/** Bytes still to send per session, summed for the "safe to close" line. */
export const uploadRemaining = new Map<string, number>();
/** Bytes this tab has put on the wire; the page diffs it to measure throughput. */
export const uploadBytesSent = { current: 0 };
/** Whether the upload on the wire has a resumable IndexedDB copy. */
export const uploadResumable = { current: false };

// Uploads still waiting for their turn on a page's one-file-at-a-time line, by
// session, one ticket per queued turn. The line belongs to the page that queued
// the upload, but Cancel can come from a page mounted after it: cancelling
// deletes the session here, and the turn that finds its ticket gone never starts.
export const queuedUploads = new Map<string, Set<symbol>>();

// Cancel can also land before a run has a controller or a ticket: while its
// resumable copy is being written, or while another tab is being asked whether
// it carries the session. Those steps go on regardless, so they check, before
// anything reaches the wire, that the run was not cancelled. The sessions
// cancelled in this tab are remembered, because the card alone can be removed
// after a Cancel; the card reading Cancelled is what tells a tab that was never
// told, when there is no BroadcastChannel.
const cancelledSessions = new Set<string>();

/** Whether the run was cancelled, in this tab or (by its card) in another one. */
export const runCancelled = (sid: string): boolean =>
	cancelledSessions.has(sid)
	|| loadRecentUploads().find((upload) => upload.sessionId === sid)?.status === "Cancelled";

/** Cancels a session's upload in this tab: aborts it, or takes it out of the line. */
export const cancelSessionUpload = (sid: string): void => {
	cancelledSessions.add(sid);
	uploadControllers.get(sid)?.abort();
	// Waiting behind another file: it never starts, and the bytes it registered
	// are dropped, which nothing else would do.
	if (queuedUploads.delete(sid)) uploadRemaining.delete(sid);
};

// Cancel can only reach what its own tab holds: a session another tab carries
// (see the locks below) has its controller and its place in the line in that
// tab's memory. So the tab that cancels announces it, and every tab signed in
// to the same account stops that session's upload and re-reads its runs.
// Without BroadcastChannel the carrying tab still finds the card Cancelled
// before it sends the run request.
const CANCEL_CHANNEL = "bodymaps-upload-cancel";
export type CancelNotice = { sid: string; ownerId: string | null };
let cancelChannel: BroadcastChannel | null | undefined;
const cancelListeners = new Set<(notice: CancelNotice) => void>();
const openCancelChannel = (): BroadcastChannel | null => {
	if (cancelChannel !== undefined) return cancelChannel;
	try {
		cancelChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CANCEL_CHANNEL);
		cancelChannel?.addEventListener("message", (event: MessageEvent) => {
			const data = event.data as Partial<CancelNotice> | null;
			if (typeof data?.sid !== "string") return;
			const notice = { sid: data.sid, ownerId: typeof data.ownerId === "string" ? data.ownerId : null };
			// Another account's runs are not this tab's to stop.
			if (notice.ownerId !== getRecentUploadsAccount()) return;
			cancelSessionUpload(notice.sid);
			cancelListeners.forEach((listener) => listener(notice));
		});
	} catch {
		cancelChannel = null;
	}
	return cancelChannel;
};

/** Tells the other tabs that this one cancelled a run. */
export const announceCancel = (sid: string, ownerId: string | null): void => {
	try {
		openCancelChannel()?.postMessage({ sid, ownerId } satisfies CancelNotice);
	} catch {
		// Nobody to tell; the carrying tab still refuses to start a Cancelled run.
	}
};

/** Calls back when another tab cancels a run; returns the way to stop listening. */
export const onCancelFromOtherTab = (listener: (notice: CancelNotice) => void): (() => void) => {
	openCancelChannel();
	cancelListeners.add(listener);
	return () => { cancelListeners.delete(listener); };
};

// The holds below only see this tab. A Web Lock per session, taken with the
// first hold and let go with the last, tells every other tab on /upload that
// this one is carrying the session, so two tabs never resume one IndexedDB
// upload (or poll for a job the other has not asked for yet). A lock also goes
// when its tab closes, which hands the session to a tab waiting on it.
// Browsers without Web Locks keep the in-tab hold alone.
const sessionLockName = (sid: string) => `bodymaps-upload:${sid}`;
const webLocks = (): LockManager | undefined =>
	typeof navigator === "undefined" ? undefined : navigator.locks;

/** Takes a session's lock if no tab holds it: its release, or null when another tab does. */
const lockSessionAcrossTabs = (sid: string): Promise<(() => void) | null> => {
	const locks = webLocks();
	if (!locks) return Promise.resolve(() => {});
	return new Promise((resolve) => {
		try {
			locks
				.request(sessionLockName(sid), { ifAvailable: true }, (lock) => {
					if (!lock) {
						resolve(null);
						return;
					}
					// Held until the release this hands out settles the promise.
					return new Promise<void>((release) => resolve(() => release()));
				})
				.catch(() => resolve(() => {}));
		} catch {
			resolve(() => {});
		}
	});
};

/** Resolves once no other tab holds the session's lock, or the signal aborts. */
export const waitForSessionLock = (sid: string, signal: AbortSignal): Promise<void> => {
	const locks = webLocks();
	if (!locks) return Promise.resolve();
	return new Promise((resolve) => {
		try {
			locks.request(sessionLockName(sid), { signal }, () => resolve()).catch(() => resolve());
		} catch {
			resolve();
		}
	});
};

type SessionHold = {
	count: number;
	settled: Promise<void>;
	settle: () => void;
	tabLock: Promise<(() => void) | null>;
};
const sessionHolds = new Map<string, SessionHold>();

/** Holds a session until the returned release is called (calling it twice is harmless). */
export const holdSession = (sid: string): (() => void) => {
	let hold = sessionHolds.get(sid);
	if (!hold) {
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => { settle = resolve; });
		hold = { count: 0, settled, settle, tabLock: lockSessionAcrossTabs(sid) };
		sessionHolds.set(sid, hold);
	}
	const held = hold;
	held.count += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		held.count -= 1;
		if (held.count === 0) {
			if (sessionHolds.get(sid) === held) sessionHolds.delete(sid);
			void held.tabLock.then((unlock) => unlock?.());
			held.settle();
		}
	};
};

/** Settles once nothing in this tab holds the session; undefined when nothing holds it now. */
export const sessionReleased = (sid: string): Promise<void> | undefined => sessionHolds.get(sid)?.settled;

/** Whether this tab got the lock of a session it holds (false: another tab is carrying it). */
export const holdsTabLock = async (sid: string): Promise<boolean> =>
	(await sessionHolds.get(sid)?.tabLock) !== null;

/** Whether no other tab is carrying the session right now (nothing stays held). */
export const sessionFreeAcrossTabs = async (sid: string): Promise<boolean> => {
	const unlock = await lockSessionAcrossTabs(sid);
	unlock?.();
	return unlock !== null;
};

/** Stops and forgets everything above. It belongs to the tab rather than to a mounted
 * page, so in a test file it would otherwise outlive the test that filled it. */
export const resetUploadTabState = (): void => {
	uploadControllers.forEach((controller) => controller.abort());
	uploadControllers.clear();
	uploadRemaining.clear();
	uploadBytesSent.current = 0;
	uploadResumable.current = false;
	queuedUploads.clear();
	cancelledSessions.clear();
	sessionHolds.forEach((hold) => {
		void hold.tabLock.then((unlock) => unlock?.());
		hold.settle();
	});
	sessionHolds.clear();
};
