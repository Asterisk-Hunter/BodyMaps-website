import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The dual-cursor regression (site-fixes U13) has been "fixed" once before and
// came back, because the fix was a hover-scoped rule that hid the wrong layer.
// These assertions pin the shape of the real fix — one pointer for every pane,
// and no per-hover suppression of the annotation layer — so a future edit has
// to be deliberate about it.
// Read from disk rather than importing: under the jsdom environment `?raw`
// resolves through the dev server, and the assertions below are about the
// file's own text.
const css = readFileSync(resolve(process.cwd(), "src/routes/VisualizationPage.css"), "utf8");

/** Comments stripped: the "what used to be here" notes in the stylesheet name
 *  the rules they replaced, and only real declarations should be asserted on. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of `selector { ... }`, without nested blocks. `.vp-pane` has an
 *  earlier rule of its own (the accent ring), and the pointer block is the one
 *  that ships last, so the search runs from the end. */
function ruleBody(selector: string): string {
	const start = css.lastIndexOf(`${selector} {`);
	if (start === -1) throw new Error(`No rule for ${selector}`);
	const end = css.indexOf("\n}", start);
	return css.slice(start, end);
}

describe("one pointer, one truth", () => {
	it("gives every interactive pane the same drawn pointer", () => {
		const body = ruleBody(".vp-pane");
		expect(body).toContain("cursor: url(");
		// The glyph is our own, not the OS crosshair — a bare `crosshair` here is
		// what made the pointer look like a second reticle.
		expect(body).toMatch(/cursor: url\("data:image\/svg\+xml,("|[^"]+)"\) 10 10, crosshair;/);
	});

	it("keeps the polarity state on the same glyph, one accent apart", () => {
		const remove = ruleBody(".vp-pane--pointer-remove");
		expect(remove).toContain("cursor: url(");
		// Amber, not red: red is the mask/lesion colour in this viewer.
		expect(remove).toContain("%23ffb020");
		expect(remove).not.toContain("%23ff5a5a");
	});

	it("has no stale cursor classes left behind", () => {
		expect(code).not.toContain("vp-pane--cursor-pos");
		expect(code).not.toContain("vp-pane--cursor-neg");
	});

	it("no longer blanks the whole annotation layer on hover", () => {
		// The old hack hid the crosshair — and every measurement and reference
		// line with it — in the hovered pane only. Assert on the rule, not the
		// word: the tombstone comment above still names it.
		expect(code).not.toContain("svg-layer");
	});

	it("keeps hover-to-identify's distinct cursor winning over the pointer", () => {
		// Declared after `.vp-pane`, so the cascade's last word is `help`.
		expect(css.indexOf(".vp-pane--hover-identify {")).toBeGreaterThan(css.indexOf(".vp-pane--pointer-remove {"));
		expect(ruleBody(".vp-pane--hover-identify")).toContain("cursor: help");
	});
});
