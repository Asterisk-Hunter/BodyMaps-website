import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";

// The dual viewer pulls the Cornerstone WebGL stack, which can't run under jsdom — mock
// the isolated setup helper so we can verify the page mounts + lays out two panes.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const { setupCompare } = vi.hoisted(() => ({ setupCompare: vi.fn() }));
vi.mock("../helpers/compareViewer", () => ({
	setupCompare,
	getOrganLabelAtPoint: vi.fn(),
	VIEWPORT_IDS: {
		aAx: "cmp_a_ax", aSag: "cmp_a_sag", aCor: "cmp_a_cor",
		bAx: "cmp_b_ax", bSag: "cmp_b_sag", bCor: "cmp_b_cor",
	},
	LENGTH_TOOL: "Length",
	BIDIRECTIONAL_TOOL: "Bidirectional",
	ANGLE_TOOL: "Angle",
	PROBE_TOOL: "Probe",
	ROI_TOOL: "RectangleROI",
	ELLIPSE_TOOL: "EllipticalROI",
	FREEHAND_ROI_TOOL: "PlanarFreehandROI",
	ARROW_TOOL: "ArrowAnnotate",
	MAGNIFY_TOOL: "AdvancedMagnify",
}));

import CompareViewerPage from "../routes/CompareViewerPage";

beforeEach(() => {
	setupCompare.mockResolvedValue({
		setLinked: vi.fn(),
		setSyncCursor: vi.fn(),
		setSegVisible: vi.fn(),
		setSegOpacity: vi.fn(),
		setOrganVisibility: vi.fn(),
		applyWindow: vi.fn(),
		applyZoom: vi.fn(),
		centerCursor: vi.fn(),
		jumpToOrgan: vi.fn(),
		refit: vi.fn(),
		resetView: vi.fn(),
		setFocusedViewport: vi.fn(),
		setReferenceLines: vi.fn(),
		flipFocused: vi.fn(),
		rotateFocused90: vi.fn(),
		startCine: vi.fn(() => true),
		stopCine: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		clearMeasurements: vi.fn(),
		getMeasurementSummaries: vi.fn(() => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(),
		subscribeToMeasurementChanges: vi.fn(() => vi.fn()),
		destroy: vi.fn(),
	});
	// resolveCtUrl does a HEAD probe; return not-ok so it falls back to the HF url.
	global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

// Rendered inside the auth context, as in the app, where the page sits behind sign-in.
const renderAt = (path: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/compare-viewer" element={<CompareViewerPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

describe("CompareViewerPage", () => {
	it("mounts two labelled panes and calls setupCompare for two cases", async () => {
		renderAt("/compare-viewer?a=1&b=2");
		expect(await screen.findByText("Case 1")).toBeTruthy();
		expect(await screen.findByText("Case 2")).toBeTruthy();

		// The current compare viewer opens full-bleed with its toolbar collapsed.
		fireEvent.click(screen.getByRole("button", { name: "Toggle toolbar" }));
		fireEvent.click(screen.getByRole("button", { name: "Sync" }));
		expect(screen.getByText(/Link scroll/i)).toBeTruthy();

		// The isolated Cornerstone setup is invoked once with both viewport elements.
		await vi.waitFor(() => expect(setupCompare).toHaveBeenCalledTimes(1));
	});

	it("asks for both case ids when the URL does not include them", async () => {
		renderAt("/compare-viewer");
		expect(await screen.findByText(/Provide two case ids in the URL/)).toBeInTheDocument();
		expect(setupCompare).not.toHaveBeenCalled();
	});

	it("does not initialize until both case ids are present", async () => {
		renderAt("/compare-viewer?a=7");
		expect(await screen.findByText(/Provide two case ids in the URL/)).toBeInTheDocument();
		expect(setupCompare).not.toHaveBeenCalled();
	});

	it("ends a failed load with a clear error and a back link (no endless spinner)", async () => {
		setupCompare.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { which: "a" }));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		renderAt("/compare-viewer?a=99999999&b=2");

		expect(await screen.findByText(/Couldn't load one or both cases/)).toBeInTheDocument();
		expect(screen.queryByText(/Loading both cases/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Toggle toolbar" }));
		expect(screen.getByRole("link", { name: "Back to comparison" })).toHaveAttribute(
			"href", "/compare?a=99999999&b=2"
		);
		errorLog.mockRestore();
	});
});
