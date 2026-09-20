import { describe, expect, it } from "vitest";
import {
	AI_FLYOUT_OPTIONS,
	CONTROL_INFO,
	EDIT_SECTIONS,
	ONBOARDING_STEPS,
	ONBOARDING_STORAGE_KEY,
	TOOL_INFO,
	aiSlotCopy,
	deriveToolbarState,
	inlineToolIds,
	isAiTool,
	toolbarLayout,
	type EditTool,
} from "../components/viewer/annotationToolbarState";

const ALL_CONTROLS = [TOOL_INFO, CONTROL_INFO];

describe("deriveToolbarState", () => {
	it("is NO_STRUCTURE_SELECTED until a structure is targeted", () => {
		expect(deriveToolbarState({ hasActiveTarget: false, hasTargetSegmentation: false, activeTool: null }))
			.toBe("NO_STRUCTURE_SELECTED");
		// A mask existing somewhere in the volume is irrelevant without a target.
		expect(deriveToolbarState({ hasActiveTarget: false, hasTargetSegmentation: true, activeTool: null }))
			.toBe("NO_STRUCTURE_SELECTED");
	});

	it("splits STRUCTURE_SELECTED_NO_SEGMENTATION from SEGMENTATION_EXISTS on the mask", () => {
		expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: false, activeTool: null }))
			.toBe("STRUCTURE_SELECTED_NO_SEGMENTATION");
		expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: null }))
			.toBe("SEGMENTATION_EXISTS");
	});

	it("enters EDITING for any manual tool, with or without an existing mask", () => {
		for (const tool of ["paint", "erase", "scissors", "levelTracing", "margin", "smoothing", "islands", "logicalOperators", "growFromSeeds", "fillBetweenSlices", "copyAcrossSlices", "hollow"] as EditTool[]) {
			expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: tool })).toBe("EDITING");
			expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: false, activeTool: tool })).toBe("EDITING");
		}
	});

	it("does not treat an armed AI tool as editing", () => {
		expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "pointSegment" }))
			.toBe("SEGMENTATION_EXISTS");
		expect(deriveToolbarState({ hasActiveTarget: true, hasTargetSegmentation: false, activeTool: "scribbleSegment" }))
			.toBe("STRUCTURE_SELECTED_NO_SEGMENTATION");
	});
});

describe("toolbar layout per state", () => {
	it("NO_STRUCTURE_SELECTED shows the picker and nothing else", () => {
		const layout = toolbarLayout("NO_STRUCTURE_SELECTED", null);
		expect(layout.structurePicker).toBe(true);
		// Everything else hidden — including the AI slot, Edit, Undo, Redo, Save.
		expect(layout.ai).toBeNull();
		expect(layout.polarity).toBe(false);
		expect([layout.edit, layout.brush, layout.eraser, layout.more, layout.done]).toEqual([false, false, false, false, false]);
		expect([layout.undo, layout.redo, layout.save, layout.pinned]).toEqual([false, false, false, false]);
	});

	it("STRUCTURE_SELECTED_NO_SEGMENTATION promotes the AI slot and hides Edit", () => {
		const layout = toolbarLayout("STRUCTURE_SELECTED_NO_SEGMENTATION", null);
		expect(layout.structurePicker).toBe(true);
		expect(layout.ai).toBe("start");
		expect(layout.edit).toBe(false);
		expect([layout.undo, layout.redo, layout.save, layout.pinned]).toEqual([false, false, false, false]);
	});

	it("SEGMENTATION_EXISTS offers refine, edit, history and save", () => {
		const layout = toolbarLayout("SEGMENTATION_EXISTS", null);
		expect(layout.ai).toBe("refine");
		expect(layout.edit).toBe(true);
		expect(layout.pinned).toBe(true);
		expect([layout.undo, layout.redo, layout.save]).toEqual([true, true, true]);
		// Not editing yet, so no inline brush/eraser and no Done.
		expect([layout.brush, layout.eraser, layout.more, layout.done]).toEqual([false, false, false, false]);
	});

	it("EDITING swaps Save for Done and puts Brush/Eraser on the ribbon", () => {
		const layout = toolbarLayout("EDITING", "paint");
		expect([layout.brush, layout.eraser, layout.more]).toEqual([true, true, true]);
		expect([layout.undo, layout.redo, layout.done]).toEqual([true, true, true]);
		expect(layout.save).toBe(false);
		expect(layout.ai).toBeNull();
	});
});

describe("polarity toggle", () => {
	it("only renders while an AI prompt tool is armed", () => {
		expect(toolbarLayout("SEGMENTATION_EXISTS", "pointSegment").polarity).toBe(true);
		expect(toolbarLayout("STRUCTURE_SELECTED_NO_SEGMENTATION", "boxSegment").polarity).toBe(true);
		// Hidden while no AI tool is armed, even in a state that allows it...
		expect(toolbarLayout("SEGMENTATION_EXISTS", null).polarity).toBe(false);
		// ...and during manual editing, where Brush/Eraser carry their own implicit polarity.
		expect(toolbarLayout("EDITING", "paint").polarity).toBe(false);
	});

	it("recognizes exactly the three AI prompt tools", () => {
		for (const id of AI_FLYOUT_OPTIONS) expect(isAiTool(id)).toBe(true);
		expect(isAiTool("paint")).toBe(false);
		expect(isAiTool(null)).toBe(false);
	});
});

describe("inline tool slots", () => {
	it("only EDITING renders tools the pinned slot would otherwise duplicate", () => {
		expect(inlineToolIds("EDITING")).toEqual(["paint", "erase"]);
		expect(inlineToolIds("SEGMENTATION_EXISTS")).toEqual([]);
		expect(inlineToolIds("NO_STRUCTURE_SELECTED")).toEqual([]);
	});
});

describe("AI flyout contents", () => {
	it("offers exactly click / box / scribble, in that order", () => {
		expect(AI_FLYOUT_OPTIONS).toEqual(["pointSegment", "boxSegment", "scribbleSegment"]);
	});

	it("describes each option in plain English, with no internal names", () => {
		expect(TOOL_INFO.pointSegment.what).toBe("Click inside the structure. Fastest for simple areas.");
		expect(TOOL_INFO.boxSegment.what).toBe("Draw a box around it. Useful for larger regions.");
		expect(TOOL_INFO.scribbleSegment.what).toBe("Draw over the structure. More guidance for complex cases.");
		for (const [, info] of Object.entries(TOOL_INFO)) {
			expect(info.what.toLowerCase()).not.toContain("nninteractive");
			expect(info.useWhen.toLowerCase()).not.toContain("nninteractive");
		}
		for (const [, info] of Object.entries(CONTROL_INFO)) {
			expect(info.what.toLowerCase()).not.toContain("nninteractive");
		}
	});
});

describe("edit flyout sections", () => {
	it("groups the tools exactly as the redesign specifies", () => {
		const byTitle = Object.fromEntries(EDIT_SECTIONS.map((s) => [s.title, s]));
		expect(byTitle.Basic.tools).toEqual(["paint", "erase", "scissors", "levelTracing"]);
		expect(byTitle.Advanced.tools).toEqual(["smoothing", "margin", "islands", "growFromSeeds"]);
		expect(byTitle["Across slices"].tools).toEqual(["fillBetweenSlices", "copyAcrossSlices"]);
		expect(byTitle.More.tools).toEqual(["logicalOperators", "hollow"]);
		expect(byTitle.More.collapsed).toBe(true);
	});

	it("keeps AI prompt tools out of the manual editing flyout", () => {
		for (const section of EDIT_SECTIONS) {
			for (const id of section.tools) expect(isAiTool(id)).toBe(false);
		}
	});
});

describe("tooltip copy", () => {
	it("gives every tool a name, a what, and a when", () => {
		for (const [id, info] of Object.entries(TOOL_INFO)) {
			expect(info.label, id).toBeTruthy();
			expect(info.what.trim().length, id).toBeGreaterThan(10);
			expect(info.useWhen.trim().length, id).toBeGreaterThan(10);
		}
		for (const [key, info] of Object.entries(CONTROL_INFO)) {
			expect(info.label, key).toBeTruthy();
			expect(info.what.trim().length, key).toBeGreaterThan(10);
			expect(info.useWhen.trim().length, key).toBeGreaterThan(10);
		}
	});

	it("only advertises shortcuts that actually exist", () => {
		// P/B/S equip the AI prompt tools, X flips polarity, tab letters for undo/redo.
		expect(TOOL_INFO.pointSegment.shortcut).toBe("P");
		expect(TOOL_INFO.boxSegment.shortcut).toBe("B");
		expect(TOOL_INFO.scribbleSegment.shortcut).toBe("S");
		expect(CONTROL_INFO.undo.shortcut).toBe("Ctrl+Z");
		expect(CONTROL_INFO.redo.shortcut).toBe("Ctrl+Shift+Z");
		expect(CONTROL_INFO.polarity.shortcut).toBe("X");
		// Manual tools carry no letter key, so they must not claim one.
		for (const id of ["paint", "erase", "scissors", "levelTracing", "smoothing", "margin", "islands", "growFromSeeds", "fillBetweenSlices", "copyAcrossSlices", "logicalOperators", "hollow"] as EditTool[]) {
			expect(TOOL_INFO[id].shortcut).toBeUndefined();
		}
	});

	it("spells the user-facing labels the way the redesign asks", () => {
		expect(TOOL_INFO.erase.label).toBe("Eraser");
		expect(TOOL_INFO.smoothing.label).toBe("Smooth");
		expect(TOOL_INFO.levelTracing.label).toBe("Level Trace");
		expect(CONTROL_INFO.polarity.label).toBe("Add / Remove");
	});
});

describe("aiSlotCopy", () => {
	it("uses the state's own wording when no option is armed", () => {
		expect(aiSlotCopy("start", null)).toEqual({ label: "Start segmentation", info: CONTROL_INFO.aiSegmentStart });
		expect(aiSlotCopy("refine", null)).toEqual({ label: "Refine", info: CONTROL_INFO.aiSegmentRefine });
	});

	it("hands the label to whichever AI option is in hand", () => {
		// The point of the change: after picking "Box" out of the flyout the slot
		// must not still be advertising "Refine".
		expect(aiSlotCopy("refine", "boxSegment").label).toBe("Box");
		expect(aiSlotCopy("refine", "pointSegment").label).toBe("Click");
		expect(aiSlotCopy("start", "scribbleSegment").label).toBe("Scribble");
	});

	it("reuses the tool's own tooltip, so flyout and ribbon can't drift", () => {
		expect(aiSlotCopy("refine", "pointSegment").info).toBe(TOOL_INFO.pointSegment);
	});

	it("ignores a manual tool — the slot is a state, not a tool", () => {
		expect(aiSlotCopy("refine", "paint").label).toBe("Refine");
	});
});

describe("onboarding", () => {
	it("uses the documented localStorage flag", () => {
		expect(ONBOARDING_STORAGE_KEY).toBe("annotation_onboarded");
	});

	it("has the four specified steps in order", () => {
		expect(ONBOARDING_STEPS.map((s) => s.text)).toEqual([
			"Select a structure to annotate.",
			"Click inside the structure — we'll generate a segmentation.",
			"Need to fix something? Brush adds, Eraser removes.",
			"Scroll through the slices to review your work. Save when done.",
		]);
		expect(ONBOARDING_STEPS.map((s) => s.target)).toEqual([
			"structurePicker", "aiSegment", "brushAndEraser", null,
		]);
	});

	it("does not teach any of the tools the spec excludes", () => {
		const copy = ONBOARDING_STEPS.map((s) => `${s.title} ${s.text}`).join(" ").toLowerCase();
		for (const forbidden of [
			"smooth", "island", "margin", "grow from seeds", "fill between slices",
			"copy across slices", "logical", "hollow", "pin", "shortcut",
		]) {
			expect(copy, forbidden).not.toContain(forbidden);
		}
	});
});

describe("control copy", () => {
	it("keeps the AI slot's two labels distinct and actionable", () => {
		expect(CONTROL_INFO.aiSegmentStart.label).toBe("Start segmentation");
		expect(CONTROL_INFO.aiSegmentRefine.label).toBe("Refine");
		expect(CONTROL_INFO.structurePicker.label).toBe("Structure");
	});

	it("never names an implementation detail in any user-visible string", () => {
		for (const group of ALL_CONTROLS) {
			for (const [, info] of Object.entries(group)) {
				const text = `${info.label} ${info.what} ${info.useWhen}`.toLowerCase();
				expect(text).not.toContain("nninteractive");
				expect(text).not.toContain("interaction_bbox");
				expect(text).not.toContain("include_interaction");
			}
		}
	});
});
