import { describe, expect, it } from "vitest";
import {
	buildReportHtml,
	buildReportMarkdown,
	caseDisplayName,
	caseFileSlug,
	type ReportInput,
} from "../helpers/sessionReport";

// The fixture's own event and shot text is user data; it is kept plain so only the
// template's words are checked.
const plain: ReportInput = {
	caseId: "42",
	startedAt: 1750000000000,
	durationMs: 219000,
	events: [{ t: 0, type: "session", detail: "Reading session started" }],
	shots: [],
	transcript: [],
	measurements: [{ tool: "Length", label: "", value: "12 mm" }],
};

// The report title line is left out: only the template copy below it is checked.
const withoutTitle = (text: string) =>
	text
		.replace(/^# .*$/m, "")
		.replace(/<title>[\s\S]*?<\/title>/, "")
		.replace(/<h1>[\s\S]*?<\/h1>/, "");

describe("report template copy", () => {
	it("uses no em dashes, even for a measurement with no label", () => {
		const md = buildReportMarkdown(plain);
		const html = buildReportHtml(plain);
		expect(withoutTitle(md)).not.toMatch(/—/);
		expect(withoutTitle(html)).not.toMatch(/—/);
		expect(md).toContain("| 1 | Distance | No label | 12 mm |");
		expect(html).toContain("<td>No label</td>");
		expect(md).toContain("Review and edit before any clinical use. This is not medical advice");
	});

	it("points to the session audio only when there is some", () => {
		expect(buildReportMarkdown(plain)).toContain("_No dictation captured._");
		expect(buildReportMarkdown({ ...plain, hasAudio: true })).toContain(
			"_No dictation captured (see the session audio for the spoken narration)._"
		);
	});
});

describe("case names", () => {
	it("reads a PanTS or CancerVerse id as a case and anything else as its own name", () => {
		expect(caseDisplayName("42")).toBe("case 42");
		expect(caseDisplayName("CV_00000007")).toBe("case CV_00000007");
		expect(caseDisplayName("the local NIfTI scan")).toBe("the local NIfTI scan");
	});

	it("turns the name into a file-name-safe stem", () => {
		expect(caseFileSlug("42")).toBe("case-42");
		expect(caseFileSlug("CV_00000007")).toBe("case-cv-00000007");
		expect(caseFileSlug("the uploaded scan")).toBe("uploaded-scan");
		expect(caseFileSlug("Liver follow-up (March)")).toBe("liver-follow-up-march");
	});
});
