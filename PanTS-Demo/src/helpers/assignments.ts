import { API_BASE } from "./constants";
import { CANCERVERSE_LAST_NUMBER, PANTS_CASE_COUNT, fetchAbdomenAtlasCount, fetchCancerVerseCount, numberToCaseId } from "./caseNumbering";

// Annotation assignments: a manager hands an annotator a range of library case numbers for one task, and the
// annotator marks each case done or flagged as they go. A case with no mark is still to do.

export type CaseMark = "done" | "flagged";
export type CaseStatus = CaseMark | "todo";

export type Assignment = {
	id: string;
	assignee: { id: string; name: string | null; email: string | null };
	start: number;
	end: number;
	task: string;
	note: string | null;
	due_at: string | null;
	created_at: string | null;
	total: number;
	done: number;
	flagged: number;
	todo: number;
	/** Only on "mine": the mark on each case that has one, keyed by case number. */
	marks?: Record<string, CaseMark>;
};

export type Person = { id: string; name: string | null; email: string; annotator?: boolean; manager?: boolean };

/** An account found by searching part of a name or email, with the roles that matter here. */
export type Account = { id: string; name: string | null; email: string; annotator: boolean; manager: boolean };

export type Overlap = { id: string; assignee: string; start: number; end: number; shared_start: number; shared_end: number };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string; reason?: string; overlaps?: Overlap[] };

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
	try {
		const res = await fetch(`${API_BASE}/api${path}`, {
			credentials: "include",
			...init,
			headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
		});
		let body: Record<string, unknown> = {};
		try {
			body = await res.json();
		} catch {
			/* an empty or non-JSON body */
		}
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				message: typeof body.error === "string" ? body.error : "Something went wrong. Try again.",
				reason: typeof body.reason === "string" ? body.reason : undefined,
				overlaps: Array.isArray(body.overlaps) ? (body.overlaps as Overlap[]) : undefined,
			};
		}
		return { ok: true, data: body as T };
	} catch {
		return { ok: false, status: 0, message: "Couldn't reach the server. Check your connection and try again." };
	}
}

export const fetchMine = () => call<{ assignments: Assignment[] }>("/assignments/mine");
export const fetchAll = () => call<{ assignments: Assignment[] }>("/assignments");
export const fetchPeople = () => call<{ people: Person[] }>("/assignments/people");

export const searchAccounts = (q: string) => call<{ accounts: Account[] }>(`/assignments/accounts?q=${encodeURIComponent(q)}`);

export const makeAnnotator = (userId: string) => call<Account>("/assignments/annotators", { method: "POST", body: JSON.stringify({ user_id: userId }) });

export const removeAnnotator = (userId: string) => call<Account>(`/assignments/annotators/${encodeURIComponent(userId)}`, { method: "DELETE" });

/** Fewest characters the server accepts when searching for an account. */
export const MIN_ACCOUNT_SEARCH = 3;

export type NewAssignment = { assignee_id: string; start: number; end: number; task: string; note?: string; due?: string; force?: boolean };

export const createAssignment = (body: NewAssignment) =>
	call<Assignment>("/assignments", { method: "POST", body: JSON.stringify(body) });

export const updateAssignment = (id: string, changes: Partial<{ assignee_id: string; task: string; note: string; due: string }>) =>
	call<Assignment>(`/assignments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) });

export const deleteAssignment = (id: string) =>
	call<{ deleted: boolean }>(`/assignments/${encodeURIComponent(id)}`, { method: "DELETE" });

export const markCase = (id: string, caseNumber: number, status: CaseStatus) =>
	call<Assignment>(`/assignments/${encodeURIComponent(id)}/cases/${caseNumber}`, { method: "PUT", body: JSON.stringify({ status }) });

export const statusOf = (a: Assignment, n: number): CaseStatus => a.marks?.[String(n)] ?? "todo";

/** The first case after `after` (wrapping to the start of the range) that is still to do, or null when none is left. */
export function nextTodo(a: Assignment, after?: number): number | null {
	if (a.end < a.start) return null;
	const first = after === undefined ? a.start : Math.min(Math.max(after + 1, a.start), a.end + 1);
	for (let n = first; n <= a.end; n++) if (statusOf(a, n) === "todo") return n;
	for (let n = a.start; n < first && n <= a.end; n++) if (statusOf(a, n) === "todo") return n;
	return null;
}

/** The assignments whose range contains `n`, those with work left first. */
export function assignmentsFor(list: Assignment[], n: number): Assignment[] {
	return list.filter((a) => a.start <= n && n <= a.end).sort((x, y) => Number(y.todo > 0) - Number(x.todo > 0));
}

export const percentDone = (a: Pick<Assignment, "done" | "total">) => (a.total ? Math.round((100 * a.done) / a.total) : 0);

export const whoLabel = (p: { name: string | null; email: string | null }) => p.name || p.email || "Unknown";

/** "55 to 95", or just "55" for a single case. */
export const rangeLabel = (a: Pick<Assignment, "start" | "end">) => (a.start === a.end ? `${a.start}` : `${a.start} to ${a.end}`);

export type DueState = "none" | "overdue" | "soon" | "later";

export function dueState(iso: string | null, now = Date.now()): DueState {
	if (!iso) return "none";
	const due = Date.parse(iso);
	if (Number.isNaN(due)) return "none";
	if (due + 86_400_000 < now) return "overdue"; // due dates are whole days: overdue only after that day ends
	return due - now < 3 * 86_400_000 ? "soon" : "later";
}

/**
 * A due date for display. It is a calendar day (the server stores midnight UTC), so it is shown as that same day for
 * everyone: formatting it in a viewer's own timezone would show a day early west of UTC.
 */
export function dueLabel(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Parse "55", "55-95", "55 to 95" or "55–95" into [start, end]; null if it is not a valid range. */
export function parseRange(text: string): [number, number] | null {
	// A number is plain digits or digits grouped in thousands (20,201); "1,2" is not a number.
	const number = String.raw`(\d{1,3}(?:,\d{3})+|\d{1,6})`;
	const m = new RegExp(String.raw`^\s*${number}\s*(?:(?:-|–|—|to)\s*${number})?\s*$`, "i").exec(text);
	if (!m) return null;
	const start = Number(m[1].replace(/,/g, ""));
	const end = m[2] === undefined ? start : Number(m[2].replace(/,/g, ""));
	return start <= 999999 && end <= 999999 && start >= 1 && end >= start ? [start, end] : null;
}

export type DatasetShare = { dataset: string; first: number; last: number; count: number; firstId: string; lastId: string };

/**
 * Which datasets the library numbers start..end (both included) fall in, in library order, with each dataset's own
 * share: PanTS 1 to 9,901, CancerVerse after it, AbdomenAtlas after that (see caseNumbering.ts). `atlasCount` is how
 * many AbdomenAtlas cases exist; leave it out when unknown and the last block runs to `end`.
 */
export function datasetBreakdown(start: number, end: number, atlasCount?: number): DatasetShare[] {
	const atlasLast = atlasCount !== undefined ? CANCERVERSE_LAST_NUMBER + Math.max(0, atlasCount) : Infinity;
	const blocks: { dataset: string; from: number; to: number }[] = [
		{ dataset: "PanTS", from: 1, to: PANTS_CASE_COUNT },
		{ dataset: "CancerVerse", from: PANTS_CASE_COUNT + 1, to: CANCERVERSE_LAST_NUMBER },
		{ dataset: "AbdomenAtlas", from: CANCERVERSE_LAST_NUMBER + 1, to: atlasLast },
	];
	const out: DatasetShare[] = [];
	for (const b of blocks) {
		const first = Math.max(start, b.from);
		const last = Math.min(end, b.to);
		if (first > last) continue;
		out.push({
			dataset: b.dataset, first, last, count: last - first + 1,
			firstId: String(numberToCaseId(first)), lastId: String(numberToCaseId(last)),
		});
	}
	return out;
}

/**
 * Split start..end (both included) into `parts` consecutive blocks of near-equal size, the first blocks taking the
 * extra case when it does not divide evenly. Null when there are more parts than cases (someone would get nothing).
 */
export function splitRange(start: number, end: number, parts: number): [number, number][] | null {
	const total = end - start + 1;
	if (!Number.isInteger(parts) || parts < 1 || total < parts) return null;
	const base = Math.floor(total / parts);
	const extra = total % parts;
	const out: [number, number][] = [];
	let at = start;
	for (let i = 0; i < parts; i++) {
		const size = base + (i < extra ? 1 : 0);
		out.push([at, at + size - 1]);
		at += size;
	}
	return out;
}

/**
 * The highest library case number that exists: PanTS, then CancerVerse, then AbdomenAtlas, using the sizes the API
 * reports. Null when the sizes cannot be read (then the server's own limits are the only check).
 */
export async function libraryMaxNumber(apiBase: string = API_BASE): Promise<number | null> {
	const [cv, atlas] = await Promise.all([fetchCancerVerseCount(apiBase), fetchAbdomenAtlasCount(apiBase)]);
	if (atlas === undefined && cv === undefined) return null;
	if (atlas !== undefined && atlas > 0) return CANCERVERSE_LAST_NUMBER + atlas;
	if (cv !== undefined && cv > 0) return PANTS_CASE_COUNT + cv;
	return PANTS_CASE_COUNT;
}
