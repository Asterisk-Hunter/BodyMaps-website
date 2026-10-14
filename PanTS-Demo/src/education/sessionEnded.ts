// The site's API answers 401 with this code once the account's sign-in has ended
// (it ran out, or the account signed out in another tab). That says nothing about
// the attempt itself: a solo challenge attempt stays saved, and signing in again
// brings the page back with it.
export const SESSION_ENDED_CODE = "authentication_required";

// The same words a live room uses when its connection is closed for this reason.
export const SESSION_ENDED_TEXT = "Your session ended. Sign in to continue.";

export function isSessionEnded(caught: unknown): boolean {
	return (caught as { code?: unknown } | null)?.code === SESSION_ENDED_CODE;
}

// Tells the account context that the sign-in has ended, as a live room does, so
// the page is signed out and the sign-in prompt comes up.
export function reportSessionEnded(): void {
	window.dispatchEvent(new Event("bodymaps:session-expired"));
}

// For a request that otherwise treats any refusal as a plain failure (the report, a share
// link, the tutor): when the answer is the ended sign-in, report it as above. Reads the
// response body only for a 401.
export async function reportIfSessionEnded(response: { status: number; json: () => Promise<unknown> }): Promise<boolean> {
	if (response.status !== 401) return false;
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		return false;
	}
	if (!isSessionEnded(body)) return false;
	reportSessionEnded();
	return true;
}
