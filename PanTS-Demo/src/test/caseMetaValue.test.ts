import { describe, expect, it } from "vitest";
import { formatCaseMetaValue } from "../helpers/demographics";

describe("formatCaseMetaValue", () => {
	it("names sex the way the dataset and compare cards do", () => {
		expect(formatCaseMetaValue("sex", "M")).toBe("Male");
		expect(formatCaseMetaValue("sex", "f")).toBe("Female");
		expect(formatCaseMetaValue("sex", "X")).toBe("X");
		expect(formatCaseMetaValue("sex", "")).toBe("Unknown");
		expect(formatCaseMetaValue("sex", null)).toBe("Unknown");
	});

	it("keeps the tumor, number and text rows as before", () => {
		expect(formatCaseMetaValue("tumor", 1)).toBe("Yes");
		expect(formatCaseMetaValue("tumor", 0)).toBe("No");
		expect(formatCaseMetaValue("tumor", null)).toBe("Unknown");
		expect(formatCaseMetaValue("age", 54)).toBe("54");
		expect(formatCaseMetaValue("age", 54.25)).toBe("54.3");
		expect(formatCaseMetaValue("ct phase", "venous")).toBe("venous");
	});

	it("reads a tumor-free case's tumor type as None, and only that case's", () => {
		expect(formatCaseMetaValue("tumor label", "Liver, Kidney", 1)).toBe("Liver, Kidney");
		expect(formatCaseMetaValue("tumor label", null, 0)).toBe("None");
		expect(formatCaseMetaValue("tumor label", null, null)).toBe("Unknown");
		expect(formatCaseMetaValue("tumor label", null, 1)).toBe("Unknown");
		expect(formatCaseMetaValue("site nationality", null, 0)).toBe("Unknown");
	});
});
