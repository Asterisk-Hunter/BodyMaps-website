import { describe, expect, it } from "vitest";
import {
	buildSearchParams,
	caseIdToApiId,
	countActiveFilters,
	EMPTY_FILTERS,
	formatTumorBadge,
	itemToId,
	parseFiltersFromParams,
	type SearchFilters,
} from "./search";

describe("itemToId", () => {
	it("parses the numeric id out of a PanTS case id", () => {
		expect(itemToId({ case_id: "PanTS_00008854" })).toBe(8854);
		expect(itemToId({ case_id: "PanTS_00000001" })).toBe(1);
	});

	it("falls back across id fields and handles numbers", () => {
		expect(itemToId({ "PanTS ID": "PanTS_00000900" })).toBe(900);
		expect(itemToId({ id: 42 })).toBe(42);
	});

	it("returns 0 when no usable id is present", () => {
		expect(itemToId({})).toBe(0);
		expect(itemToId({ case_id: "no-digits-here" })).toBe(0);
	});

	it("keeps CancerVerse ids as the full prefixed string (not a stripped number)", () => {
		expect(itemToId({ case_id: "CV_00000001" })).toBe("CV_00000001");
		expect(itemToId({ "PanTS ID": "CV_00012345" })).toBe("CV_00012345");
	});
});

describe("caseIdToApiId", () => {
	it("formats PanTS ids and preserves CancerVerse ids", () => {
		expect(caseIdToApiId(42)).toBe("PanTS_00000042");
		expect(caseIdToApiId("CV_00000007")).toBe("CV_00000007");
	});
});

describe("buildSearchParams", () => {
	const base: SearchFilters = EMPTY_FILTERS;

	it("omits the tumor param for 'any' and maps tumor/no_tumor to 1/0", () => {
		expect(buildSearchParams(base).has("tumor")).toBe(false);
		expect(buildSearchParams({ ...base, tumor: "tumor" }).get("tumor")).toBe("1");
		expect(buildSearchParams({ ...base, tumor: "no_tumor" }).get("tumor")).toBe("0");
	});

	it("appends sex[] and age_bin[] for each selected value", () => {
		const params = buildSearchParams({
			...base,
			sex: ["M", "F"],
			age: ["0-9", "90-99"],
		});
		expect(params.getAll("sex[]")).toEqual(["M", "F"]);
		expect(params.getAll("age_bin[]")).toEqual(["0-9", "90-99"]);
	});

	it("appends the metadata facet filters with their backend param names", () => {
		const params = buildSearchParams({
			...base,
			manufacturer: ["SIEMENS"],
			ctPhase: ["Arterial"],
			siteNat: ["US"],
			year: ["2018", "2019"],
		});
		expect(params.getAll("manufacturer[]")).toEqual(["SIEMENS"]);
		expect(params.getAll("ct_phase[]")).toEqual(["Arterial"]);
		expect(params.getAll("site_nat[]")).toEqual(["US"]);
		expect(params.getAll("year[]")).toEqual(["2018", "2019"]);
	});

	it("sends the tumor-type selection as tumor_type[]", () => {
		const params = buildSearchParams({ ...base, tumorType: ["pancreas", "liver"] });
		expect(params.getAll("tumor_type[]")).toEqual(["pancreas", "liver"]);
		expect(buildSearchParams(base).has("tumor_type[]")).toBe(false);
	});

	it("adds sort_by and per_page only when provided", () => {
		expect(buildSearchParams(base).has("sort_by")).toBe(false);
		const params = buildSearchParams(base, { sortBy: "quality", perPage: 12 });
		expect(params.get("sort_by")).toBe("quality");
		expect(params.get("per_page")).toBe("12");
	});

	it("maps the dataset selection to ?dataset= (empty/both = all)", () => {
		expect(buildSearchParams(base).get("dataset")).toBe("all"); // none selected
		expect(buildSearchParams({ ...base, dataset: ["PanTS"] }).get("dataset")).toBe("pants");
		expect(buildSearchParams({ ...base, dataset: ["CancerVerse"] }).get("dataset")).toBe("cancerverse");
		expect(
			buildSearchParams({ ...base, dataset: ["PanTS", "CancerVerse"] }).get("dataset")
		).toBe("all");
	});
});

describe("parseFiltersFromParams", () => {
	it("round-trips filters through the URL query string", () => {
		const filters: SearchFilters = {
			tumor: "tumor",
			dataset: [],
			tumorType: ["kidney", "liver"],
			sex: ["F"],
			age: ["50-59"],
			manufacturer: ["GE"],
			ctPhase: ["Venous"],
			siteNat: ["US"],
			year: ["2020"],
		};
		const restored = parseFiltersFromParams(buildSearchParams(filters));
		expect(restored).toEqual(filters);
	});

	it("ignores a ?dataset= from an old bookmark instead of applying a filter nobody can see", () => {
		for (const value of ["cancerverse", "cv", "pants", "all"]) {
			const restored = parseFiltersFromParams(new URLSearchParams({ dataset: value }));
			expect(restored).toEqual(EMPTY_FILTERS);
			expect(countActiveFilters(restored)).toBe(0);
		}
	});

	it("defaults to EMPTY_FILTERS for an empty query", () => {
		expect(parseFiltersFromParams(new URLSearchParams())).toEqual(EMPTY_FILTERS);
	});
});

describe("countActiveFilters", () => {
	it("counts tumor + every selected multi value", () => {
		expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
		expect(
			countActiveFilters({ ...EMPTY_FILTERS, tumor: "tumor", sex: ["M"], year: ["2018", "2019"] })
		).toBe(4);
	});

	it("counts each selected tumor type", () => {
		expect(countActiveFilters({ ...EMPTY_FILTERS, tumorType: ["pancreas", "liver"] })).toBe(2);
	});
});

describe("formatTumorBadge", () => {
	it("names the organ, and falls back to a plain label when none is known", () => {
		expect(formatTumorBadge("Pancreas")).toBe("Pancreas tumor");
		expect(formatTumorBadge(null)).toBe("Tumor");
		expect(formatTumorBadge("")).toBe("Tumor");
		expect(formatTumorBadge(undefined)).toBe("Tumor");
	});

	it("keeps several organs short enough for a card", () => {
		expect(formatTumorBadge("Liver, Kidney")).toBe("Liver, Kidney tumor");
		expect(formatTumorBadge("Liver, Kidney, Colon, Spleen")).toBe("Liver, Kidney +2 tumor");
	});
});
