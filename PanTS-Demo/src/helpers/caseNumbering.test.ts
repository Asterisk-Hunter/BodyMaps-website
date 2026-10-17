import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CANCERVERSE_CASE_COUNT,
	CANCERVERSE_LAST_NUMBER,
	PANTS_CASE_COUNT,
	caseIdToNumber,
	caseNumberToCaseId,
	caseNumberToPath,
	fetchAbdomenAtlasCount,
	fetchCancerVerseCount,
	numberRouteToCaseId,
	numberToCaseId,
	resetCancerVerseCountCache,
} from "./caseNumbering";

const CV_COUNT = 24422;
const ATLAS_COUNT = 9262;

afterEach(() => {
	resetCancerVerseCountCache();
	vi.unstubAllGlobals();
});

describe("numberToCaseId", () => {
	it("keeps PanTS numbers as they are", () => {
		expect(numberToCaseId(1)).toBe(1);
		expect(numberToCaseId(17)).toBe(17);
		expect(numberToCaseId(PANTS_CASE_COUNT)).toBe(9901);
	});

	it("continues with CancerVerse from 9,902", () => {
		expect(numberToCaseId(9902)).toBe("CV_00000001");
		expect(numberToCaseId(9903)).toBe("CV_00000002");
		expect(numberToCaseId(34323)).toBe("CV_00024422");
	});

	it("continues with AbdomenAtlas from 34,324, and CancerVerse's block does not move", () => {
		expect(CANCERVERSE_LAST_NUMBER).toBe(34323);
		expect(numberToCaseId(34324)).toBe("BDMAP_00000001");
		expect(numberToCaseId(34325)).toBe("BDMAP_00000002");
		expect(numberToCaseId(43585)).toBe("BDMAP_00009262");
		expect(numberToCaseId(34323)).toBe("CV_00024422");
	});

	it("clamps a number that is too large to the last case of the dataset, when the count is known", () => {
		expect(numberToCaseId(99999, CV_COUNT, ATLAS_COUNT)).toBe("BDMAP_00009262");
		expect(numberToCaseId(43585, CV_COUNT, ATLAS_COUNT)).toBe("BDMAP_00009262");
		expect(numberToCaseId(43586, CV_COUNT, ATLAS_COUNT)).toBe("BDMAP_00009262");
		expect(numberToCaseId(34323, CV_COUNT, ATLAS_COUNT)).toBe("CV_00024422");
		expect(numberToCaseId(34324, CV_COUNT, ATLAS_COUNT)).toBe("BDMAP_00000001");
	});

	it("clamps inside CancerVerse's own block only by CancerVerse's count", () => {
		expect(numberToCaseId(9902 + 99, 100)).toBe("CV_00000100");
		expect(numberToCaseId(34323, 100)).toBe("CV_00000100");
	});

	it("does not clamp when the count is unknown", () => {
		expect(numberToCaseId(34324)).toBe("BDMAP_00000001");
		expect(numberToCaseId(50000, undefined, 0)).toBe("BDMAP_00015677");
		expect(numberToCaseId(34323, 0)).toBe("CV_00024422");
	});

	it("rejects anything that is not a positive whole number", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(numberToCaseId(bad)).toBeNull();
		}
	});
});

describe("caseIdToNumber", () => {
	it("reads every id form the app uses", () => {
		expect(caseIdToNumber(17)).toBe(17);
		expect(caseIdToNumber("17")).toBe(17);
		expect(caseIdToNumber("PanTS_00008854")).toBe(8854);
		expect(caseIdToNumber("CV_00000001")).toBe(9902);
		expect(caseIdToNumber("cv_00024422")).toBe(34323);
		expect(caseIdToNumber("BDMAP_00000001")).toBe(34324);
		expect(caseIdToNumber("bdmap_00009262")).toBe(43585);
	});

	it("returns null for ids that are not in the library numbering", () => {
		for (const bad of ["", "abc", "BDMAP_", "BDMAP_00000000", "BDMAP_SAMPLE", "CV_", "CV_00000000", "PanTS_00000000", 0, -3, 2.5]) {
			expect(caseIdToNumber(bad as string | number)).toBeNull();
		}
	});

	it("is the exact inverse of numberToCaseId for every case in the library", () => {
		for (let n = 1; n <= PANTS_CASE_COUNT + CV_COUNT + ATLAS_COUNT; n++) {
			const id = numberToCaseId(n, CV_COUNT, ATLAS_COUNT) as number | string;
			expect(caseIdToNumber(id)).toBe(n);
		}
	});

	it("never moves a case that already has a number: CancerVerse's block is fixed", () => {
		expect(CANCERVERSE_CASE_COUNT).toBe(24422);
		for (const [n, id] of [[1, 1], [9901, 9901], [9902, "CV_00000001"], [20000, "CV_00010099"], [34323, "CV_00024422"]] as const) {
			expect(numberToCaseId(n)).toBe(id);
		}
	});

	it("never gives two cases the same number", () => {
		const seen = new Set<number | null>();
		for (let k = 1; k <= CV_COUNT; k++) seen.add(caseIdToNumber(`CV_${String(k).padStart(8, "0")}`));
		for (let n = 1; n <= PANTS_CASE_COUNT; n++) seen.add(caseIdToNumber(`PanTS_${String(n).padStart(8, "0")}`));
		for (let k = 1; k <= ATLAS_COUNT; k++) seen.add(caseIdToNumber(`BDMAP_${String(k).padStart(8, "0")}`));
		expect(seen.size).toBe(PANTS_CASE_COUNT + CV_COUNT + ATLAS_COUNT);
	});
});

describe("numberRouteToCaseId (the /case/<number> redirect)", () => {
	it("redirects numbers above PanTS' range to CancerVerse", () => {
		expect(numberRouteToCaseId("9902")).toBe("CV_00000001");
		expect(numberRouteToCaseId("20000")).toBe("CV_00010099");
		expect(numberRouteToCaseId("34324")).toBe("BDMAP_00000001");
	});

	it("leaves PanTS numbers and every other id alone", () => {
		for (const keep of ["1", "9901", "00012", "CV_00000001", "PanTS_00000017", "BDMAP_00000001", "abc", ""]) {
			expect(numberRouteToCaseId(keep)).toBeNull();
		}
	});
});

describe("fetchCancerVerseCount / caseNumberToPath", () => {
	const stubSearch = (total: unknown, ok = true) => {
		const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => ({ total }) });
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	it("reads the count from the API once and caches it", async () => {
		const fetchMock = stubSearch(CV_COUNT);
		expect(await fetchCancerVerseCount("http://api")).toBe(CV_COUNT);
		expect(await fetchCancerVerseCount("http://api")).toBe(CV_COUNT);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("http://api/api/search?per_page=1&dataset=cancerverse");
	});

	it("gives undefined, and caches nothing, when the API fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await fetchCancerVerseCount("http://api")).toBeUndefined();
		stubSearch(null, false);
		expect(await fetchCancerVerseCount("http://api")).toBeUndefined();
		stubSearch(CV_COUNT);
		expect(await fetchCancerVerseCount("http://api")).toBe(CV_COUNT);
	});

	it("builds the viewer path without any request for PanTS numbers", async () => {
		const fetchMock = stubSearch(CV_COUNT);
		expect(await caseNumberToPath(17, "http://api")).toBe("/case/17");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("builds the CancerVerse path and clamps with the live count", async () => {
		stubSearch(CV_COUNT);
		expect(await caseNumberToPath(9902, "http://api")).toBe("/case/CV_00000001");
		expect(await caseNumberToPath(34323, "http://api")).toBe("/case/CV_00024422");
	});

	it("builds the AbdomenAtlas path and clamps with the live count", async () => {
		const fetchMock = stubSearch(ATLAS_COUNT);
		expect(await caseNumberToPath(34324, "http://api")).toBe("/case/BDMAP_00000001");
		expect(await caseNumberToPath(500000, "http://api")).toBe("/case/BDMAP_00009262");
		expect(fetchMock.mock.calls[0][0]).toBe("http://api/api/search?per_page=1&dataset=abdomenatlas");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends a number past the end to the last CancerVerse case when the library has no AbdomenAtlas", async () => {
		stubSearch(0);
		expect(await fetchAbdomenAtlasCount("http://api")).toBe(0);
		expect(await caseNumberToCaseId(500000, "http://api")).toBe("CV_00024422");
		expect(await caseNumberToCaseId(34324, "http://api")).toBe("CV_00024422");
	});

	it("still works (unclamped) when the count cannot be read", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await caseNumberToPath(9902, "http://api")).toBe("/case/CV_00000001");
		expect(await caseNumberToPath(34324, "http://api")).toBe("/case/BDMAP_00000001");
		expect(await fetchAbdomenAtlasCount("http://api")).toBeUndefined();
	});

	it("asks for a dataset's size only when the number is in that dataset's range", async () => {
		const fetchMock = stubSearch(CV_COUNT);
		await caseNumberToPath(9902, "http://api");
		expect(String(fetchMock.mock.calls[0][0])).toContain("dataset=cancerverse");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns null for a number that is not valid", async () => {
		expect(await caseNumberToPath(0, "http://api")).toBeNull();
	});
});
