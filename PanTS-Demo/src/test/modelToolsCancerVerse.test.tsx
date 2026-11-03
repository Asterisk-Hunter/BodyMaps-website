/**
 * Dataset-specific model tools were removed from the annotation ribbon. Keep
 * this contract local to the current toolbar instead of mounting the page for
 * an API prop that no longer exists.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationToolbar, { type PrimaryEditTool, type ScissorsOptions } from "../components/viewer/AnnotationToolbar";

describe("annotation toolbar after removing model-specific tools", () => {
	it("keeps the current AI refine and direct manual controls without the old model or Edit menus", () => {
		const props = {
			open: true,
			disabled: false,
			hasSegments: true,
			hasActiveTarget: true,
			activeTool: null as PrimaryEditTool,
			onToolChange: vi.fn(),
			diameterMm: 5,
			onDiameterChange: vi.fn(),
			scissorsOptions: { operation: "eraseInside" } as ScissorsOptions,
			onScissorsOptionsChange: vi.fn(),
			scissorsPointCount: 0,
			onScissorsCancel: vi.fn(),
			targetKey: 1,
			renderFlyout: () => null,
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			onSave: vi.fn(),
			canUndo: true,
			canRedo: true,
			isSaving: false,
			hasTargetSegmentation: true,
			structures: [{ id: 1, label: "Liver" }],
			activeStructureId: 1,
			onSelectStructure: vi.fn(),
		};
		render(<AnnotationToolbar {...props} />);

		expect(screen.getByRole("button", { name: /AI refine/i })).toBeInTheDocument();
		for (const name of ["Brush", "Scissors", "Eraser"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") })).toBeInTheDocument();
		}
		expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /model tools?/i })).toBeNull();
	});
});
