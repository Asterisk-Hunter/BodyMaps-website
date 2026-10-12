import { getRecentUploadsAccount, RECENT_UPLOADS_CHANGED } from "./recentUploads";

/** An asynchronous transfer may outlive its page, but never its account. */
export const isUploadAccountCurrent = (ownerId: string | null): boolean =>
	Boolean(ownerId && getRecentUploadsAccount() === ownerId);

export const assertUploadAccount = (ownerId: string | null, signal?: AbortSignal): void => {
	if (!isUploadAccountCurrent(ownerId) || signal?.aborted) throw new DOMException("Upload session changed", "AbortError");
};

/** The listener belongs to the transfer, not the page. Call abort in its finally
 * block to release it after completion; route navigation alone does not abort. */
export const createAccountUploadController = (ownerId: string | null): AbortController => {
	const controller = new AbortController();
	const check = () => { if (!isUploadAccountCurrent(ownerId)) controller.abort(); };
	window.addEventListener(RECENT_UPLOADS_CHANGED, check);
	controller.signal.addEventListener("abort", () => window.removeEventListener(RECENT_UPLOADS_CHANGED, check), { once: true });
	check();
	return controller;
};
