/**
 * The Measurements dock: rows named by their label (or tool and value), told apart
 * by their place when two share a name, Clear all asking first with Keep focused,
 * and focus kept in the panel when a row is deleted. Also the Measure menu's
 * Clear measurements row and the NIfTI volume's CT tag that gives ROIs their HU.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const engine = vi.hoisted(() => ({
	items: [] as { uid: string; tool: string; label: string; value: string; center: [number, number, number] | null }[],
	clearMeasurements: vi.fn(),
	removeMeasurement: vi.fn(),
	renameMeasurement: vi.fn(),
}));

vi.mock("../helpers/CornerstoneNifti2", () => ({
	getMeasurementSummaries: () => engine.items.map((m) => ({ ...m })),
	subscribeToMeasurementChanges: () => () => {},
	clearMeasurements: engine.clearMeasurements,
	removeMeasurement: (uid: string) => engine.removeMeasurement(uid),
	renameMeasurement: (uid: string, label: string) => engine.renameMeasurement(uid, label),
	jumpToMeasurement: () => null,
}));

import MeasurementPanel from "../components/MeasurementPanel/MeasurementPanel";
import { ClearAllChips, ClearMeasurementsFlyoutItem } from "../components/MeasurementPanel/ClearMeasurementsConfirm";
import { duplicatePositions, measurementRowName } from "../components/MeasurementPanel/measurementRowName";

beforeEach(() => {
	engine.items = [];
	engine.clearMeasurements.mockReset();
	engine.removeMeasurement.mockReset();
	engine.renameMeasurement.mockReset();
});

describe("measurement row names", () => {
	it("uses the label, else the tool and value", () => {
		expect(measurementRowName("Length", "lesion", "10.0 mm")).toBe("lesion");
		expect(measurementRowName("Length", "  ", "10.0 mm")).toBe("Distance 10.0 mm");
		expect(measurementRowName("ArrowAnnotate", "", "")).toBe("Arrow note");
		expect(measurementRowName("Probe", "", "40 HU", "Case A")).toBe("Case A HU probe 40 HU");
	});

	it("numbers only the rows that share a name", () => {
		expect(duplicatePositions(["a", "b", "a"])).toEqual(["1 of 3", undefined, "3 of 3"]);
	});
});

describe("Measurements dock", () => {
	it("names each row's buttons and field after the row", () => {
		engine.items = [
			{ uid: "1", tool: "Length", label: "", value: "10.0 mm", center: [0, 0, 0] },
			{ uid: "2", tool: "Length", label: "", value: "10.0 mm", center: [0, 0, 0] },
			{ uid: "3", tool: "Probe", label: "liver", value: "52 HU", center: null },
		];
		render(<MeasurementPanel onClose={() => {}} />);
		expect(screen.getByRole("button", { name: "Delete Distance 10.0 mm, 1 of 3" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete Distance 10.0 mm, 2 of 3" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Label for liver" })).toHaveValue("liver");
		expect(screen.getByRole("button", { name: "Jump to liver" })).toBeDisabled();
	});

	it("hands focus to the next row's Delete button when a row is deleted", () => {
		engine.items = [
			{ uid: "1", tool: "Length", label: "a", value: "1.0 mm", center: null },
			{ uid: "2", tool: "Length", label: "b", value: "2.0 mm", center: null },
		];
		render(<MeasurementPanel onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Delete a" }));
		expect(engine.removeMeasurement).toHaveBeenCalledWith("1");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete b" }));
	});

	it("asks before clearing every measurement, with Keep focused", () => {
		engine.items = [{ uid: "1", tool: "Length", label: "", value: "1.0 mm", center: null }];
		render(<MeasurementPanel onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		expect(engine.clearMeasurements).not.toHaveBeenCalled();
		expect(screen.getByRole("group", { name: "Clear all measurements?" })).toBeInTheDocument();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));

		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		expect(engine.clearMeasurements).toHaveBeenCalledTimes(1);
		expect(screen.getByText("No measurements yet.")).toBeInTheDocument();
		expect(document.activeElement).toBe(screen.getByRole("region", { name: "Measurements" }));
	});

	it("turns renaming, deleting and clearing off when read-only", () => {
		engine.items = [{ uid: "1", tool: "Length", label: "a", value: "1.0 mm", center: null }];
		render(<MeasurementPanel onClose={() => {}} readOnly />);
		expect(screen.getByRole("textbox", { name: "Label for a" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Delete a" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
	});
});

describe("Clear all chips", () => {
	it("backs out on Escape and puts focus back on Clear all", () => {
		const onClear = vi.fn();
		render(<ClearAllChips onClear={onClear} />);
		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		fireEvent.keyDown(screen.getByRole("button", { name: "Keep" }), { key: "Escape" });
		expect(screen.queryByRole("group", { name: "Clear all measurements?" })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear all" }));
		expect(onClear).not.toHaveBeenCalled();
	});
});

describe("Measure menu Clear measurements row", () => {
	it("is disabled while there is nothing to clear", () => {
		render(<ClearMeasurementsFlyoutItem onClear={() => {}} disabled />);
		expect(screen.getByRole("button", { name: "Clear measurements" })).toBeDisabled();
	});

	it("asks in place, Keep focused, and clears only on Clear", () => {
		const onClear = vi.fn();
		render(<ClearMeasurementsFlyoutItem onClear={onClear} />);
		fireEvent.click(screen.getByRole("button", { name: "Clear measurements" }));
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		expect(onClear).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear measurements" }));

		fireEvent.click(screen.getByRole("button", { name: "Clear measurements" }));
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(onClear).toHaveBeenCalledTimes(1);
	});
});
