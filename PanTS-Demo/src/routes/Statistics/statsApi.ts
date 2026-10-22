// The Statistics page's data layer: the shape /api/stats answers with, and the query it is asked with.
//
// The query is the library's own: the same SearchFilters, written to the URL by the same
// buildSearchParams, so a link from the library opens the statistics of exactly that search and a
// click on a bar here is a filter the library understands too. The one addition is `dataset`, which
// narrows the statistics to a single dataset (the library has no such filter and ignores it).

import { API_BASE } from "../../helpers/constants";
import {
	EMPTY_FILTERS,
	buildSearchParams,
	countActiveFilters,
	parseFiltersFromParams,
	type MultiFilterKey,
	type SearchFilters,
	type TumorFilter,
} from "../../helpers/search";

export const DATASET_KEYS = ["PanTS", "CancerVerse", "AbdomenAtlas"] as const;
export type DatasetKey = (typeof DATASET_KEYS)[number];
export type Split = Record<DatasetKey, number>;

export type Coverage = {
	recorded: number;
	total: number;
	not_reported: number;
	share: number | null;
};

export type StatRow = { key: string; label: string; count: number; datasets: Split };

export type SummaryNumbers = {
	median: number | null;
	q1: number | null;
	q3: number | null;
	mean: number | null;
	min: number | null;
	max: number | null;
};

export type AgeBin = { lo: number; hi: number | null; label: string; count: number; datasets: Split };
export type YearRow = { year: number; count: number; datasets: Split };

export type StatsResponse = {
	schema: string;
	total: number;
	query?: string;
	datasets: { key: DatasetKey; count: number }[];
	tumor: Coverage & {
		with_tumor: Split;
		without_tumor: Split;
		unknown: Split;
		types: StatRow[];
	};
	phase: Coverage & { rows: StatRow[] };
	sex: Coverage & {
		rows: StatRow[];
		ratio: { male_percent: number; female_percent: number } | null;
	};
	age: Coverage &
		SummaryNumbers & { bins: AgeBin[]; bin_width: number; under_15: number; implausible: number };
	manufacturer: Coverage & { rows: StatRow[] };
	model: Coverage & { rows: StatRow[] };
	year: Coverage & { rows: YearRow[]; range_only: number };
	country: Coverage & { rows: StatRow[] };
	slice_thickness: Coverage & SummaryNumbers & { rows: StatRow[] };
	coverage: Coverage & SummaryNumbers & { rows: StatRow[] };
	completeness: {
		field: string;
		datasets: Record<DatasetKey, { recorded: number; total: number; share: number | null }>;
	}[];
};

// ---------------------------------------------------------------------------------------------- query
export type StatsQuery = { filters: SearchFilters; dataset: DatasetKey | null };

export const EMPTY_QUERY: StatsQuery = { filters: EMPTY_FILTERS, dataset: null };

const DATASET_PARAM: Record<DatasetKey, string> = {
	PanTS: "pants",
	CancerVerse: "cancerverse",
	AbdomenAtlas: "abdomenatlas",
};

/** The query a page URL names: library filters plus an optional ?dataset=. */
export const readQuery = (params: URLSearchParams): StatsQuery => {
	const wanted = (params.get("dataset") ?? "").trim().toLowerCase();
	const dataset = DATASET_KEYS.find((key) => DATASET_PARAM[key] === wanted) ?? null;
	return { filters: parseFiltersFromParams(params), dataset };
};

/** The URL (and API) params of a query. `dataset` is left out for "all datasets" so a link from here
 *  reads like one from the library. */
export const writeQuery = (query: StatsQuery): URLSearchParams => {
	const params = buildSearchParams({ ...query.filters, dataset: [] });
	params.delete("dataset");
	if (query.dataset) params.set("dataset", DATASET_PARAM[query.dataset]);
	return params;
};

/** The library's page for the same scans (the library lists every dataset: it has no dataset filter). */
export const libraryHref = (query: StatsQuery): string => {
	const params = buildSearchParams({ ...query.filters, dataset: [] });
	params.delete("dataset");
	// With no filter the library would show its curated strip, not "every scan": ask for the list.
	if (countActiveFilters(query.filters) === 0) params.set("browse", "1");
	return `/dashboard?${params.toString()}`;
};

export const isFiltered = (query: StatsQuery): boolean =>
	countActiveFilters(query.filters) > 0 || query.dataset !== null;

const addOrRemove = (list: string[], value: string): string[] =>
	list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

export const toggleFilter = (query: StatsQuery, key: MultiFilterKey, value: string): StatsQuery => ({
	...query,
	filters: { ...query.filters, [key]: addOrRemove(query.filters[key], value) },
});

export const setTumor = (query: StatsQuery, tumor: TumorFilter): StatsQuery => ({
	...query,
	filters: { ...query.filters, tumor: query.filters.tumor === tumor ? "any" : tumor },
});

/** Clicking the dataset that is already focused returns to all three. */
export const toggleDataset = (query: StatsQuery, dataset: DatasetKey): StatsQuery => ({
	...query,
	dataset: query.dataset === dataset ? null : dataset,
});

// What a bar's key means to the library's filters. The phases use the spellings of the library's own
// pills (the catalog stores "Delay", and its phase filter matches by substring, so "Delayed" would
// find nothing), so a bar and the library's pill are the same filter.
export const PHASE_FILTER_VALUE: Record<string, string | undefined> = {
	"Non-contrast": "Non-contrast",
	Arterial: "Arterial",
	Venous: "Venous",
	Delayed: "Delay",
};

/** The library's age bins are decades; a 5-year bar picks the decade it sits in. */
export const decadeBin = (lo: number): string => {
	const start = Math.floor(lo / 10) * 10;
	return start >= 90 ? "90-99" : `${start}-${start + 9}`;
};

export const decadeOf = (bin: string): [number, number] | null => {
	const match = /^(\d+)-(\d+)$/.exec(bin);
	return match ? [Number(match[1]), Number(match[2])] : null;
};

export type Chip = { id: string; group: string; text: string; remove: (query: StatsQuery) => StatsQuery };

const SEX_TEXT: Record<string, string> = { M: "Male", F: "Female", UNKNOWN: "Sex unknown" };
const TUMOR_TEXT: Record<TumorFilter, string> = { any: "", tumor: "With tumor", no_tumor: "No tumor" };

/** One removable chip per active filter, in the order the page reads. */
export const activeChips = (query: StatsQuery, label: (group: string, value: string) => string): Chip[] => {
	const chips: Chip[] = [];
	const { filters } = query;
	if (query.dataset) {
		chips.push({
			id: `dataset:${query.dataset}`,
			group: "Dataset",
			text: query.dataset,
			remove: (q) => ({ ...q, dataset: null }),
		});
	}
	if (filters.tumor !== "any") {
		chips.push({
			id: `tumor:${filters.tumor}`,
			group: "Tumor",
			text: TUMOR_TEXT[filters.tumor],
			remove: (q) => ({ ...q, filters: { ...q.filters, tumor: "any" } }),
		});
	}
	const multi: [MultiFilterKey, string, (value: string) => string][] = [
		["tumorType", "Tumor type", (value) => label("tumorType", value)],
		["sex", "Sex", (value) => SEX_TEXT[value] ?? value],
		["age", "Age", (value) => (value === "UNKNOWN" ? "Age unknown" : value)],
		["ctPhase", "Phase", (value) => label("ctPhase", value)],
		["manufacturer", "Scanner", (value) => label("manufacturer", value)],
		["siteNat", "Country", (value) => label("siteNat", value)],
		["year", "Year", (value) => value],
	];
	for (const [key, group, text] of multi) {
		for (const value of filters[key]) {
			chips.push({
				id: `${key}:${value}`,
				group,
				text: text(value),
				remove: (q) => toggleFilter(q, key, value),
			});
		}
	}
	return chips;
};

// ---------------------------------------------------------------------------------------------- fetch
export async function fetchStats(query: StatsQuery, signal?: AbortSignal): Promise<StatsResponse> {
	const params = buildSearchParams({ ...query.filters, dataset: query.dataset ? [query.dataset] : [] });
	const response = await fetch(`${API_BASE}/api/stats?${params.toString()}`, { signal });
	if (!response.ok) throw new Error(`Statistics failed (${response.status})`);
	const body = (await response.json()) as StatsResponse;
	if (!body || typeof body.total !== "number" || !Array.isArray(body.datasets)) {
		throw new Error("Statistics answered in an unexpected shape");
	}
	return body;
}
