/**
 * The Statistics page's query: it is the library's own filter set, so a library link opens the statistics
 * of the same scans and a click on a chart is a filter the library understands. Also the formatting that
 * keeps a chart honest about how many scans it is drawn from.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../helpers/search";
import { statisticsHref } from "../helpers/statisticsLink";
import { titleForPath } from "../helpers/routeTitles";
import { routePattern } from "../helpers/analytics";
import {
	EMPTY_QUERY,
	PHASE_FILTER_VALUE,
	activeChips,
	decadeBin,
	decadeOf,
	isFiltered,
	libraryHref,
	readQuery,
	setTumor,
	toggleDataset,
	toggleFilter,
	writeQuery,
} from "../routes/Statistics/statsApi";
import { coverageText, niceMax, number1, percent } from "../routes/Statistics/statsFormat";

const params = (text: string) => new URLSearchParams(text);

describe("the statistics query", () => {
	it("reads the library's own params and an optional dataset, and writes them back unchanged", () => {
		const text = "tumor_type[]=liver&sex[]=F&sex[]=M&tumor=1&age_bin[]=60-69&manufacturer[]=Siemens&ct_phase[]=Venous&site_nat[]=US&year[]=2020&dataset=pants";
		const query = readQuery(params(text));
		expect(query.dataset).toBe("PanTS");
		expect(query.filters).toMatchObject({
			tumor: "tumor",
			tumorType: ["liver"],
			sex: ["F", "M"],
			age: ["60-69"],
			manufacturer: ["Siemens"],
			ctPhase: ["Venous"],
			siteNat: ["US"],
			year: ["2020"],
		});
		expect(writeQuery(query).toString()).toBe(
			"tumor_type%5B%5D=liver&sex%5B%5D=F&sex%5B%5D=M&tumor=1&age_bin%5B%5D=60-69&manufacturer%5B%5D=Siemens&ct_phase%5B%5D=Venous&site_nat%5B%5D=US&year%5B%5D=2020&dataset=pants",
		);
	});

	it("treats a missing or unknown dataset as all datasets and writes no dataset param for it", () => {
		expect(readQuery(params("dataset=nonsense")).dataset).toBeNull();
		expect(readQuery(params("")).dataset).toBeNull();
		expect(writeQuery(EMPTY_QUERY).toString()).toBe("");
		expect(readQuery(params("dataset=abdomenatlas")).dataset).toBe("AbdomenAtlas");
		expect(readQuery(params("dataset=CancerVerse")).dataset).toBe("CancerVerse");
	});

	it("toggles a filter on and off, one value at a time", () => {
		let q = toggleFilter(EMPTY_QUERY, "sex", "F");
		q = toggleFilter(q, "sex", "M");
		expect(q.filters.sex).toEqual(["F", "M"]);
		q = toggleFilter(q, "sex", "F");
		expect(q.filters.sex).toEqual(["M"]);
		expect(EMPTY_QUERY.filters.sex).toEqual([]);          // never mutates
		expect(isFiltered(q)).toBe(true);
		expect(isFiltered(EMPTY_QUERY)).toBe(false);
	});

	it("the tumor filter is a toggle between a value and any; the dataset focus returns to all on a second click", () => {
		expect(setTumor(EMPTY_QUERY, "tumor").filters.tumor).toBe("tumor");
		expect(setTumor(setTumor(EMPTY_QUERY, "tumor"), "tumor").filters.tumor).toBe("any");
		expect(setTumor(setTumor(EMPTY_QUERY, "tumor"), "no_tumor").filters.tumor).toBe("no_tumor");
		const focused = toggleDataset(EMPTY_QUERY, "CancerVerse");
		expect(focused.dataset).toBe("CancerVerse");
		expect(toggleDataset(focused, "CancerVerse").dataset).toBeNull();
		expect(toggleDataset(focused, "PanTS").dataset).toBe("PanTS");
		expect(isFiltered(focused)).toBe(true);
	});

	it("a phase bar is the same filter as the library's pill, spelled the way the catalog stores it", () => {
		expect(PHASE_FILTER_VALUE).toEqual({ "Non-contrast": "Non-contrast", Arterial: "Arterial", Venous: "Venous", Delayed: "Delay" });
		expect(PHASE_FILTER_VALUE.Other).toBeUndefined();
	});

	it("an age column picks the library's ten-year band", () => {
		expect(decadeBin(0)).toBe("0-9");
		expect(decadeBin(5)).toBe("0-9");
		expect(decadeBin(60)).toBe("60-69");
		expect(decadeBin(65)).toBe("60-69");
		expect(decadeBin(95)).toBe("90-99");
		expect(decadeOf("60-69")).toEqual([60, 69]);
		expect(decadeOf("UNKNOWN")).toBeNull();
	});

	it("links back to the library with the same filters, and to the whole list when there are none", () => {
		const query = toggleFilter(toggleDataset(EMPTY_QUERY, "PanTS"), "ctPhase", "Venous");
		expect(libraryHref(query)).toBe("/dashboard?ct_phase%5B%5D=Venous");          // the library has no dataset filter
		expect(libraryHref(EMPTY_QUERY)).toBe("/dashboard?browse=1");
	});

	it("one removable chip per active filter, named for the reader", () => {
		const label = (group: string, value: string) => (group === "tumorType" && value === "liver" ? "Liver" : value);
		let q = toggleDataset(EMPTY_QUERY, "AbdomenAtlas");
		q = setTumor(q, "tumor");
		q = toggleFilter(q, "tumorType", "liver");
		q = toggleFilter(q, "sex", "F");
		q = toggleFilter(q, "age", "60-69");
		const chips = activeChips(q, label);
		expect(chips.map((c) => `${c.group}: ${c.text}`)).toEqual([
			"Dataset: AbdomenAtlas",
			"Tumor: With tumor",
			"Tumor type: Liver",
			"Sex: Female",
			"Age: 60-69",
		]);
		let rest = q;
		for (const chip of chips) rest = chip.remove(rest);
		expect(rest).toEqual({ filters: EMPTY_FILTERS, dataset: null });
	});
});

describe("the library's link to the statistics", () => {
	it("carries the search on screen and leaves paging and sorting behind", () => {
		expect(statisticsHref("")).toBe("/statistics");
		expect(statisticsHref("?browse=1&page=3")).toBe("/statistics");
		expect(statisticsHref("?sex[]=F&ct_phase[]=Venous&page=2&dataset=pants")).toBe(
			"/statistics?sex%5B%5D=F&ct_phase%5B%5D=Venous",
		);
	});

	it("the page has a title and an analytics route name", () => {
		expect(titleForPath("/statistics")).toBe("Statistics | BodyMaps");
		expect(titleForPath("/statistics/")).toBe("Statistics | BodyMaps");
		expect(routePattern("/statistics")).toBe("/statistics");
	});
});

describe("how a chart says what it is drawn from", () => {
	const coverage = (recorded: number, total: number) => ({
		recorded,
		total,
		not_reported: total - recorded,
		share: total ? recorded / total : null,
	});

	it("states the number recorded, never leaves the rest to look like zero", () => {
		expect(coverageText(coverage(31300, 43585))).toBe("Recorded for 31,300 of 43,585 scans (71.8%).");
		expect(coverageText(coverage(10, 10))).toBe("Recorded for all 10 scans.");
		expect(coverageText(coverage(0, 12))).toBe("Recorded for none of the 12 scans.");
		expect(coverageText(coverage(0, 0))).toBe("No scans match.");
	});

	it("formats shares and numbers", () => {
		expect(percent(0.7181)).toBe("71.8%");
		expect(percent(1)).toBe("100%");
		expect(percent(0)).toBe("0.0%");
		expect(percent(0.0004)).toBe("<0.1%");
		expect(percent(null)).toBe("—");
		expect(number1(66)).toBe("66");
		expect(number1(64.8847)).toBe("64.9");
		expect(number1(null)).toBe("—");
	});

	it("rounds an axis maximum up to a tidy number", () => {
		expect(niceMax(0)).toBe(1);
		expect(niceMax(87)).toBe(100);
		expect(niceMax(1234)).toBe(2000);
		expect(niceMax(2400)).toBe(2500);
		expect(niceMax(5)).toBe(5);
		expect(niceMax(6000)).toBe(10000);
	});
});
