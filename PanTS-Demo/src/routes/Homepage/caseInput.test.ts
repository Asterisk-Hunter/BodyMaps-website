import { describe, expect, it } from "vitest";
import { CASE_INPUT_HINT, PANTS_RANGE_HINT, cleanCaseInput, parseCaseInput } from "./caseInput";

describe("parseCaseInput", () => {
	it("is empty for an empty field", () => {
		expect(parseCaseInput("")).toBeNull();
		expect(parseCaseInput("  #, ")).toBeNull();
	});

	it("reads a library number as the card prints it", () => {
		expect(parseCaseInput("17")).toEqual({ kind: "number", n: 17 });
		expect(parseCaseInput("#9,902")).toEqual({ kind: "number", n: 9902 });
		expect(parseCaseInput("34,324")).toEqual({ kind: "number", n: 34324 });
		expect(cleanCaseInput(" #9,902 ")).toBe("9902");
	});

	it("reads an id copied from a card, in any letter case", () => {
		expect(parseCaseInput("PanTS_00000017")).toEqual({ kind: "id", id: 17 });
		expect(parseCaseInput("cv_00000001")).toEqual({ kind: "id", id: "CV_00000001" });
		expect(parseCaseInput("CV_1")).toEqual({ kind: "id", id: "CV_00000001" });
		expect(parseCaseInput("BDMAP_00000001")).toEqual({ kind: "id", id: "BDMAP_00000001" });
		expect(parseCaseInput("bdmap_42")).toEqual({ kind: "id", id: "BDMAP_00000042" });
	});

	it("refuses what is not a case, with the hint that names all three id forms", () => {
		for (const bad of ["abc", "CV_", "BDMAP_", "BDMAP_0", "CV_00000000", "BDMAP_SAMPLE"]) {
			expect(parseCaseInput(bad)).toEqual({ kind: "invalid", message: CASE_INPUT_HINT });
		}
		expect(CASE_INPUT_HINT).toContain("PanTS_00000017");
		expect(CASE_INPUT_HINT).toContain("CV_00000001");
		expect(CASE_INPUT_HINT).toContain("BDMAP_00000001");
	});

	it("keeps PanTS ids inside PanTS' range", () => {
		expect(parseCaseInput("PanTS_00009901")).toEqual({ kind: "id", id: 9901 });
		expect(parseCaseInput("PanTS_00009902")).toEqual({ kind: "invalid", message: PANTS_RANGE_HINT });
	});
});
