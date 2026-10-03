import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const startSegmentation = /ai segment/i;
const refine = /ai refine/i;

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
	it("offers AI segmentation and a Draw entry for an empty target", async () => {
		const onToolChange = vi.fn();
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false, onToolChange });

		const start = screen.getByRole("button", { name: startSegmentation });
		expect(start.className).toContain("atb__label-btn--primary");
		fireEvent.click(screen.getByRole("button", { name: /^draw/i }));
		await waitFor(() => expect(screen.getByRole("button", { name: /^brush$/i })).toBeTruthy());
		expect(screen.getByRole("button", { name: /^eraser$/i })).toBeTruthy();
		expect(q(/smoothing/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^brush$/i }));
		expect(onToolChange).toHaveBeenCalledWith("paint");
		expect(q(/undo/i)).toBeNull();
		expect(q(/save/i)).toBeNull();
	});

	it("keeps AI prompt modes available for an empty structure", () => {
		const onToolChange = vi.fn();
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false, onToolChange });
		fireEvent.click(screen.getByRole("button", { name: /ai segment/i }));
		fireEvent.click(screen.getByRole("button", { name: /^box$/i }));
		expect(onToolChange).toHaveBeenCalledWith("boxSegment");
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
		expect(q(/finish editing/i)).toBeNull();
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
	it("keeps Save available beside Finish editing without saving on exit", () => {
		const onToolChange = vi.fn();
		const onSave = vi.fn();
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, activeTool: "paint", onToolChange, onSave });

		expect(screen.getByRole("button", { name: /^brush$/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^eraser$/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
		expect(q(/undo/i)).toBeTruthy();
		expect(q(/redo/i)).toBeTruthy();
		const finish = screen.getByRole("button", { name: /finish editing/i });
		const save = screen.getByRole("button", { name: /^save$/i });
		expect(finish).toBeTruthy();
		expect(save).toBeTruthy();
		save.click();
		expect(onSave).toHaveBeenCalledTimes(1);
		finish.click();
		expect(onToolChange).toHaveBeenCalledWith(null);
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(q(refine)).toBeNull();
	});

	it("makes controls natively disabled while the viewer is busy", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: true, disabled: true, activeTool: "paint" });
		expect(screen.getByRole("button", { name: /more/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /^brush$/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /brush settings/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /finish editing/i })).toBeDisabled();
	});

	it("shows compact save feedback and retries failures", () => {
		const onRetrySave = vi.fn();
		renderToolbar({
			hasActiveTarget: true,
			hasTargetSegmentation: true,
			activeTool: "paint",
			saveStatus: "error",
			saveError: "Network unavailable",
			onRetrySave,
		});
		expect(screen.getByRole("status")).toHaveTextContent("Save failed");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRetrySave).toHaveBeenCalledTimes(1);
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

	it("uses the AI segment / AI refine labels when no prompt mode is armed", () => {
		renderToolbar({ hasActiveTarget: true, hasTargetSegmentation: false });
		expect(aiSlot()?.textContent).toContain("AI segment");
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
