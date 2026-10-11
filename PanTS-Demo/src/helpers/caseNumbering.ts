// One running number across the whole library.
//
//   1 .. 9,901          PanTS        (bare number in the URL: /case/17)
//   9,902 .. 34,323     CancerVerse  (CV_00000001 is number 9,902, CV_00024422 is 34,323)
//
// This is only a way to *address* cases by number (search box, /case/<number> links, the number
// shown on a card). The ids the app and the backend use are unchanged ("17" for PanTS,
// "CV_00000001" for CancerVerse), so existing links, caches and thumbnails keep working.
//
// PanTS has a fixed 9,901 cases, so CancerVerse numbers never move. A dataset added after
// CancerVerse should start where CancerVerse ends at the time it is added and then be frozen
// (a later CancerVerse release would otherwise renumber it).

export const PANTS_CASE_COUNT = 9901;

const CV_ID = /^CV_(\d{1,8})$/i;
const PANTS_ID = /^PanTS_(\d{1,8})$/i;

const cvId = (k: number): string => `CV_${String(k).padStart(8, "0")}`;

/**
 * The id the app uses for library number `n`: the number itself for PanTS, "CV_xxxxxxxx" for
 * CancerVerse. `cvCount` (how many CancerVerse cases exist) clamps a number that is too large to
 * the last case, like the old search box clamped to 9,901; leave it out to skip the clamp.
 * Returns null for anything that is not a positive whole number.
 */
export function numberToCaseId(n: number, cvCount?: number): number | string | null {
	if (!Number.isInteger(n) || n < 1) return null;
	if (n <= PANTS_CASE_COUNT) return n;
	let k = n - PANTS_CASE_COUNT;
	if (cvCount !== undefined && cvCount >= 1) k = Math.min(k, cvCount);
	return cvId(k);
}

/** The library number for an app id ("17", 17, "PanTS_00000017" or "CV_00000001"), or null. */
export function caseIdToNumber(id: number | string): number | null {
	if (typeof id === "number") return Number.isInteger(id) && id >= 1 ? id : null;
	const s = String(id).trim();
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		return n >= 1 ? n : null;
	}
	const pants = PANTS_ID.exec(s);
	if (pants) return Number(pants[1]) >= 1 ? Number(pants[1]) : null;
	const cv = CV_ID.exec(s);
	if (cv) return Number(cv[1]) >= 1 ? PANTS_CASE_COUNT + Number(cv[1]) : null;
	return null;
}

/**
 * For a /case/<param> URL: the CancerVerse id to redirect to when the param is a library number
 * above PanTS' range (/case/9902 -> CV_00000001), otherwise null (keep the URL as it is).
 */
export function numberRouteToCaseId(param: string): string | null {
	if (!/^\d+$/.test(param)) return null;
	const n = Number(param);
	return n > PANTS_CASE_COUNT ? (numberToCaseId(n) as string) : null;
}

let cachedCvCount: number | undefined;

/** How many CancerVerse cases the library has (cached per page load); undefined if it cannot be read. */
export async function fetchCancerVerseCount(apiBase: string): Promise<number | undefined> {
	if (cachedCvCount !== undefined) return cachedCvCount;
	try {
		const res = await fetch(`${apiBase}/api/search?per_page=1&dataset=cancerverse`);
		if (!res.ok) return undefined;
		const data = await res.json();
		if (typeof data?.total === "number" && data.total >= 1) cachedCvCount = data.total;
	} catch {
		/* no clamp then: an out-of-range case just shows the viewer's "not found" */
	}
	return cachedCvCount;
}

/** The viewer URL for a number typed in the search box, e.g. 17 -> /case/17, 9902 -> /case/CV_00000001. */
export async function caseNumberToPath(n: number, apiBase: string): Promise<string | null> {
	const count = n > PANTS_CASE_COUNT ? await fetchCancerVerseCount(apiBase) : undefined;
	const id = numberToCaseId(n, count);
	return id === null ? null : `/case/${id}`;
}

/** Test hook: forget the cached CancerVerse count. */
export function resetCancerVerseCountCache(): void {
	cachedCvCount = undefined;
}
