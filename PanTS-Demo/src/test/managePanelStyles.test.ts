import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The manager's tools once used style classes defined in the Account page's stylesheet. That stylesheet only loads when
// the Account page is opened, so on the Assignments page itself the buttons lost their colour and the text boxes lost
// their borders (black boxes). The panel must style itself.

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The panel is several files now (cards, the two windows, the form, the annotator search); all of them count.
const FILES = ["ManagePanel", "PeopleCards", "ManageModal", "HandOut", "Annotators", "parts"];

describe("the manager's tools style themselves", () => {
	const panel = FILES.map((f) => source(`../routes/AssignmentsPage/${f}.tsx`)).join("\n");
	const css = source("../routes/AssignmentsPage/ManagePanel.css");

	it("use no class from the Account page's stylesheet (set-...)", () => {
		expect(panel.match(/(?<![\w-])set-[\w-]+/g) ?? []).toEqual([]);
	});

	it("import their own stylesheet and not the Account page's", () => {
		expect(source("../routes/AssignmentsPage/ManagePanel.tsx")).toContain('import "./ManagePanel.css"');
		expect(panel).not.toMatch(/Settings\.css/);
	});

	it("define every asg- class they use for buttons, boxes and banners", () => {
		const used = new Set(panel.match(/asg-[\w-]+/g) ?? []);
		for (const needed of ["asg-btn", "asg-btn--primary", "asg-input", "asg-banner", "asg-step", "asg-picklist", "asg-pcard", "asg-tile", "asg-modal"]) {
			expect(used.has(needed)).toBe(true);
			expect(css).toContain(`.${needed}`);
		}
	});

	it("give text boxes a visible border and buttons a visible background", () => {
		const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
		expect(rule(".asg-input")).toMatch(/border:\s*1\.5px solid #/);
		expect(rule(".asg-input")).toMatch(/background:\s*#fff/);
		expect(rule(".asg-btn--primary")).toMatch(/background:\s*#002d72/);
		expect(rule(".asg-btn--primary")).toMatch(/color:\s*#fff/);
	});
});
