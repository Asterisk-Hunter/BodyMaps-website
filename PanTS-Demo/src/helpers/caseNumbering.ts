// One running number across the whole library.
//
//   1 .. 9,901          PanTS         (bare number in the URL: /case/17)
//   9,902 .. 34,323     CancerVerse   (CV_00000001 is number 9,902, CV_00024422 is 34,323)
//   34,324 ..           AbdomenAtlas  (BDMAP_00000001 is number 34,324, BDMAP_00009262 is 43,585)
//
// This is only a way to *address* cases by number (search box, /case/<number> links, the number
// shown on a card). The ids the app and the backend use are unchanged ("17" for PanTS,
// "CV_00000001" for CancerVerse), so existing links, caches and thumbnails keep working.
//
// PanTS has a fixed 9,901 cases, so CancerVerse numbers never move. A dataset added after
// CancerVerse starts where CancerVerse ended at the time it was added and is then frozen (a later
// CancerVerse release would otherwise renumber it). That is why CancerVerse's block is a constant here
// and not the live count: AbdomenAtlas starts at 34,324 whatever CancerVerse grows to.

export const PANTS_CASE_COUNT = 9901;
export const CANCERVERSE_CASE_COUNT = 24422;
/** The library number of the last CancerVerse block entry; AbdomenAtlas continues after it. */
export const CANCERVERSE_LAST_NUMBER = PANTS_CASE_COUNT + CANCERVERSE_CASE_COUNT;

const CV_ID = /^CV_(\d{1,8})$/i;
const PANTS_ID = /^PanTS_(\d{1,8})$/i;
const ATLAS_ID = /^BDMAP_(\d{1,8})$/i;

const cvId = (k: number): string => `CV_${String(k).padStart(8, "0")}`;
const atlasId = (k: number): string => `BDMAP_${String(k).padStart(8, "0")}`;

/**
 * The id the app uses for library number `n`: the number itself for PanTS, "CV_xxxxxxxx" for
 * CancerVerse, "BDMAP_xxxxxxxx" for AbdomenAtlas. `cvCount` / `atlasCount` (how many cases the
 * dataset has) clamp a number that is too large to that dataset's last case, like the old search box
 * clamped to 9,901: the CancerVerse count clamps only inside CancerVerse's own block, and the
 * AbdomenAtlas count clamps everything past the end of the library. Leave them out to skip the clamp.
 * Returns null for anything that is not a positive whole number.
 */
export function numberToCaseId(n: number, cvCount?: number, atlasCount?: number): number | string | null {
	if (!Number.isInteger(n) || n < 1) return null;
	if (n <= PANTS_CASE_COUNT) return n;
	if (n <= CANCERVERSE_LAST_NUMBER) {
		let k = n - PANTS_CASE_COUNT;
		if (cvCount !== undefined && cvCount >= 1) k = Math.min(k, cvCount);
		return cvId(k);
	}
	let k = n - CANCERVERSE_LAST_NUMBER;
	if (atlasCount !== undefined && atlasCount >= 1) k = Math.min(k, atlasCount);
	return atlasId(k);
}

/** The library number for an app id ("17", 17, "PanTS_00000017", "CV_00000001" or "BDMAP_00000001"), or null. */
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
	const atlas = ATLAS_ID.exec(s);
	if (atlas) return Number(atlas[1]) >= 1 ? CANCERVERSE_LAST_NUMBER + Number(atlas[1]) : null;
	return null;
}

/**
 * For a /case/<param> URL: the CancerVerse or AbdomenAtlas id to redirect to when the param is a
 * library number above PanTS' range (/case/9902 -> CV_00000001, /case/34324 -> BDMAP_00000001),
 * otherwise null (keep the URL as it is).
 */
export function numberRouteToCaseId(param: string): string | null {
	if (!/^\d+$/.test(param)) return null;
	const n = Number(param);
	return n > PANTS_CASE_COUNT ? (numberToCaseId(n) as string) : null;
}

let cachedCvCount: number | undefined;
let cachedAtlasCount: number | undefined;

// The size the API reports for a dataset: a whole number (0 when the library has none of it), or
// undefined when the API cannot be read.
async function fetchDatasetCount(apiBase: string, dataset: string): Promise<number | undefined> {
	try {
		const res = await fetch(`${apiBase}/api/search?per_page=1&dataset=${dataset}`);
		if (!res.ok) return undefined;
		const data = await res.json();
		if (typeof data?.total === "number" && data.total >= 0) return data.total;
	} catch {
		/* no clamp then: an out-of-range case just shows the viewer's "not found" */
	}
	return undefined;
}

/** How many CancerVerse cases the library has (cached per page load); undefined if it cannot be read. */
export async function fetchCancerVerseCount(apiBase: string): Promise<number | undefined> {
	if (cachedCvCount !== undefined) return cachedCvCount;
	const count = await fetchDatasetCount(apiBase, "cancerverse");
	if (count !== undefined && count >= 1) cachedCvCount = count;
	return count !== undefined && count >= 1 ? count : undefined;
}

/**
 * How many AbdomenAtlas cases the library has (cached per page load): 0 when this library does not
 * have the dataset (it is optional), undefined when the API cannot be read.
 */
export async function fetchAbdomenAtlasCount(apiBase: string): Promise<number | undefined> {
	if (cachedAtlasCount !== undefined) return cachedAtlasCount;
	const count = await fetchDatasetCount(apiBase, "abdomenatlas");
	if (count !== undefined && count >= 1) cachedAtlasCount = count;
	return count;
}

/**
 * The app id for library number `n`, clamped to the last case of the dataset it falls in. Asks the
 * API for a dataset's size only when `n` is in that dataset's range (PanTS numbers need no request).
 * A number past the end of a library that has no AbdomenAtlas goes to the last CancerVerse case.
 */
export async function caseNumberToCaseId(n: number, apiBase: string): Promise<number | string | null> {
	if (n > CANCERVERSE_LAST_NUMBER) {
		const atlasCount = await fetchAbdomenAtlasCount(apiBase);
		if (atlasCount === 0) return numberToCaseId(CANCERVERSE_LAST_NUMBER);
		return numberToCaseId(n, undefined, atlasCount);
	}
	if (n > PANTS_CASE_COUNT) return numberToCaseId(n, await fetchCancerVerseCount(apiBase));
	return numberToCaseId(n);
}

/** The viewer URL for a number typed in the search box, e.g. 17 -> /case/17, 9902 -> /case/CV_00000001. */
export async function caseNumberToPath(n: number, apiBase: string): Promise<string | null> {
	const id = await caseNumberToCaseId(n, apiBase);
	return id === null ? null : `/case/${id}`;
}

/** Test hook: forget the cached dataset counts. */
export function resetCancerVerseCountCache(): void {
	cachedCvCount = undefined;
	cachedAtlasCount = undefined;
}
