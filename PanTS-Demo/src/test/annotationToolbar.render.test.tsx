import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnnotationToolbar, { type PrimaryEditTool, type ScissorsOptions } from "../components/viewer/AnnotationToolbar";

// The ribbon is a portal rendered to <body>, so everything is queried from
// `screen` (document.body) rather than the render container. It needs no
// Cornerstone/Niivue mocks: every piece of viewer state it renders from
// arrives as props, which is the point of the state machine.
function renderToolbar(overrides: Partial<Parameters<typeof AnnotationToolbar>[0]> = {}) {
	const props = {
		open: true,
		disabled: false,
		hasSegments: true,
		hasActiveTarget: false,
		activeTool: null as PrimaryEditTool,
		onToolChange: vi.fn(),
		diameterMm: 5,
		onDiameterChange: vi.fn(),
		scissorsOptions: { operation: "eraseInside" } as ScissorsOptions,
		onScissorsOptionsChange: vi.fn(),
		scissorsPointCount: 0,
		onScissorsCancel: vi.fn(),
		targetKey: null,
		renderFlyout: () => null,
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onSave: vi.fn(),
		canUndo: true,
		canRedo: true,
		isSaving: false,
		hasTargetSegmentation: false,
		structures: [{ id: 1, label: "Liver" }, { id: 2, label: "Spleen" }],
		colors: { 1: "#ff0000", 2: "#00ff00" },
		activeStructureId: null,
		onSelectStructure: vi.fn(),
		...overrides,
	};
	return { ...render(<AnnotationToolbar {...props} />), props };
}

const q = (name: RegExp) => screen.queryByRole("button", { name });
const startSegmentation = /start segmentation/i;
const refine = /refine/i;

beforeEach(() => {
	window.localStorage.clear();
});

describe("NO_STRUCTURE_SELECTED", () => {
	it("keeps the closed ribbon out of keyboard and screen reader navigation", () => {
		renderToolbar({ open: false, hasActiveTarget: true, hasTargetSegmentation: true });
		expect(q(/select structure/i)).toBeNull();
		expect(q(refine)).toBeNull();
		expect(document.querySelector(".atb-shell")).toHaveAttribute("inert");
	});

	it("renders only the structure picker", () => {
		renderToolbar({ hasActiveTarget: false });

		expect(q(/select structure/i)).toBeTruthy();
		expect(q(startSegmentation)).toBeNull();
		expect(q(refine)).toBeNull();
		expect(q(/^edit/i)).toBeNull();
		expect(q(/undo/i)).toBeNull();
		expect(q(/redo/i)).toBeNull();
		expect(q(/save/i)).toBeNull();
	});

	it("shows the picked structure's name in the picker", () => {
		renderToolbar({ hasActiveTarget: true, activeStructureId: 1 });
		expect(screen.getByRole("button", { name: /liver/i })).toBeTruthy();
	});
});

describe("STRUCTURE_SELECTED_NO_SEGMENTATION", () => {
	it("promotes a primary Start segmentation button and still hides Edit", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false });

		const start = screen.getByRole("button", { name: startSegmentation });
		expect(start.className).toContain("atb__label-btn--primary");
		expect(q(/^edit/i)).toBeNull();
		expect(q(/undo/i)).toBeNull();
		expect(q(/save/i)).toBeNull();
	});
});

describe("SEGMENTATION_EXISTS", () => {
	it("offers refine, edit, undo, redo and save", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true });

		expect(q(refine)).toBeTruthy();
		expect(q(/^edit/i)).toBeTruthy();
		expect(q(/undo/i)).toBeTruthy();
		expect(q(/redo/i)).toBeTruthy();
		expect(q(/save/i)).toBeTruthy();
		// Not the empty-structure state any more, and not editing either.
		expect(q(startSegmentation)).toBeNull();
		expect(q(/^brush$/i)).toBeNull();
		expect(q(/done/i)).toBeNull();
	});

	it("shows Add / Remove only once an AI prompt tool is armed", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true });
		expect(q(/^add$/i)).toBeNull();

		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "pointSegment" });
		expect(q(/^add$/i)).toBeTruthy();
		expect(q(/^remove$/i)).toBeTruthy();
	});

	it("hides Add / Remove during manual editing", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "paint" });
		expect(q(/^add$/i)).toBeNull();
		expect(q(/^remove$/i)).toBeNull();
	});
});

describe("EDITING", () => {
	it("puts Brush, Eraser, More, Undo/Redo and Done on the ribbon — and no Save", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "paint" });

		expect(screen.getByRole("button", { name: /^brush$/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^eraser$/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
		expect(q(/undo/i)).toBeTruthy();
		expect(q(/redo/i)).toBeTruthy();
		expect(q(/done/i)).toBeTruthy();
		expect(q(/save/i)).toBeNull();
		expect(q(refine)).toBeNull();
	});
});

describe("pinned tools", () => {
	it("render on the ribbon between Edit and Undo", () => {
		window.localStorage.setItem("bodymaps_pinned_tools", JSON.stringify(["margin"]));
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true });

		expect(screen.getByRole("button", { name: /^margin$/i })).toBeTruthy();
	});

	it("do not duplicate tools the state already renders inline", () => {
		window.localStorage.setItem("bodymaps_pinned_tools", JSON.stringify(["paint"]));
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "paint" });

		expect(screen.getAllByRole("button", { name: /^brush$/i })).toHaveLength(1);
	});

	it("are hidden entirely while no structure is selected", () => {
		window.localStorage.setItem("bodymaps_pinned_tools", JSON.stringify(["margin"]));
		renderToolbar({ hasActiveTarget: false });
		expect(q(/^margin$/i)).toBeNull();
	});
});

describe("AI slot label", () => {
	/** The slot is the one labelled button carrying the ✦ glyph. */
	const aiSlot = () =>
		screen.getAllByRole("button").find((b) => (b.textContent ?? "").includes("✦"));

	it("says Start segmentation / Refine when nothing is armed", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false });
		expect(aiSlot()?.textContent).toContain("Start segmentation");
	});

	it("names the armed AI option instead of still saying Refine", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "boxSegment" });
		expect(aiSlot()?.textContent).toContain("Box");
		expect(aiSlot()?.textContent).not.toContain("Refine");
		expect(aiSlot()?.className).toContain("is-active");
	});

	it("reports the armed option in the empty-structure state too", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false, activeTool: "scribbleSegment" });
		expect(aiSlot()?.textContent).toContain("Scribble");
	});
});

describe("cancelling an in-flight AI run", () => {
	it("turns the ✕ into a Stop control, and it stops the run rather than the tool", () => {
		const onAiCancelRun = vi.fn();
		const onAiCancel = vi.fn();
		renderToolbar({
			hasActiveTarget: true,
			hasTargetSegmentation: true,
			activeTool: "pointSegment",
			disabled: true, // the page disables the ribbon for the duration of a run
			aiRunBusy: true,
			onAiCancelRun,
			onAiCancel,
		});

		const stop = screen.getByRole("button", { name: /stop this ai step/i });
		expect(stop.className).toContain("is-stop");
		expect(q(/^cancel ai tool$/i)).toBeNull();
		stop.click();
		expect(onAiCancelRun).toHaveBeenCalledTimes(1);
		expect(onAiCancel).not.toHaveBeenCalled();
	});

	it("goes back to being the ✕ once the run is over", () => {
		const onAiCancel = vi.fn();
		renderToolbar({
			hasActiveTarget: true,
			hasTargetSegmentation: true,
			activeTool: "pointSegment",
			aiRunBusy: false,
			onAiCancel,
		});

		screen.getByRole("button", { name: /^cancel ai tool$/i }).click();
		expect(onAiCancel).toHaveBeenCalledTimes(1);
		expect(q(/stop this ai step/i)).toBeNull();
	});
});

describe("onboarding", () => {
	it("does not auto-start the first-run tour", () => {
		renderToolbar({ hasActiveTarget: false });
		expect(screen.queryByRole("dialog", { name: /annotation tour/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /skip tour/i })).toBeNull();
	});
});
