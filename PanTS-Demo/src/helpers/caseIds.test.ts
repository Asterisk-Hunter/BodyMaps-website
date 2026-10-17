import { describe, expect, it } from "vitest";
import {
	isAbdomenAtlasCaseId,
	isCancerVerseCaseId,
	isServerOnlyCaseId,
} from "./caseIds";

describe("which dataset an id belongs to", () => {
	it("recognizes CancerVerse ids in any letter case, padded or not", () => {
		for (const id of ["CV_00000001", "cv_00000001", "CV_1", " CV_00024422 "]) {
			expect(isCancerVerseCaseId(id)).toBe(true);
			expect(isAbdomenAtlasCaseId(id)).toBe(false);
		}
	});

	it("recognizes AbdomenAtlas ids in any letter case, padded or not", () => {
		for (const id of ["BDMAP_00000001", "bdmap_00000001", "BDMAP_1", " BDMAP_00009262 "]) {
			expect(isAbdomenAtlasCaseId(id)).toBe(true);
			expect(isCancerVerseCaseId(id)).toBe(false);
		}
	});

	it("treats PanTS ids and anything else as neither", () => {
		for (const id of [17, "17", "PanTS_00000017", "", null, undefined, 0]) {
			expect(isCancerVerseCaseId(id)).toBe(false);
			expect(isAbdomenAtlasCaseId(id)).toBe(false);
			expect(isServerOnlyCaseId(id)).toBe(false);
		}
	});

	it("groups the two datasets whose CT is only on the lab's server", () => {
		expect(isServerOnlyCaseId("CV_00000001")).toBe(true);
		expect(isServerOnlyCaseId("BDMAP_00000001")).toBe(true);
	});
});
