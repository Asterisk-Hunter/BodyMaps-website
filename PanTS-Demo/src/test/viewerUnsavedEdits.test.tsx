import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mask edit history keeps its newest 50 entries. An edit that falls off the end
// cannot be undone, but its voxels are still in the scan, so the page keeps asking
// before it is left even when nothing is left to undo.

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));
const edits = vi.hoisted(() => ({ listener: null as null | (() => void) }));

vi.mock("@niivue/niivue", () => ({
	Niivue: class {
		attachToCanvas() {}
		loadVolumes() {
			return Promise.resolve();
		}
		setSliceType() {}
		setInterpolation() {}
		drawScene() {}
	},
}));

vi.mock("../helpers/CornerstoneNifti2", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
	return {
		...actual,
		getOrganLabelOnClick: vi.fn(),
		getOrganLabelAtPoint: vi.fn(() => undefined),
		moveCornerstoneCrosshairToMm: vi.fn(),
		renderVisualization: vi.fn().mockImplementation(async () => ({
			renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() },
			viewportIds: [],
			volumeId: `test-volume-${++viewerVolumeSequence.value}`,
			dispose: viewerDispose,
		})),
		setFillOpacity: vi.fn(),
		setPaneSliceIndex: vi.fn(),
		subscribeToSliceChanges: vi.fn(() => () => {}),
		setOutlineOpacity: vi.fn(),
		setVisibilities: vi.fn(),
		subscribeToCrosshairChanges: vi.fn(),
		subscribeToVolumeProgress: vi.fn(() => () => {}),
		toggleCrosshairTool: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		cancelMeasurementInProgress: vi.fn(() => false),
		clearMeasurements: vi.fn(),
		applyRemoteMeasurement: vi.fn(),
		removeRemoteMeasurement: vi.fn(),
		getCrosshairMm: vi.fn(() => null),
		getOrganCentroids: vi.fn(() => null),
		// Measurement inventory + reading-session capture APIs
		getMeasurementSummaries: vi.fn(() => []),
		subscribeToMeasurementChanges: vi.fn(() => () => {}),
		captureViewportImages: vi.fn(async () => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(() => null),
		// Zoom controls now live in the top toolbar (previously ZoomHandle)
		setZoom: vi.fn(),
		centerOnCursor: vi.fn(),
		zoomToFit: vi.fn(),
		zoomToCursor: vi.fn(),
		// Progressive full-res upgrade + shaded volume rendering (3D pane)
		upgradeCtVolume: vi.fn(async () => null),
		enableVolume3D: vi.fn(async () => false),
		disableVolume3D: vi.fn(),
		applyVolume3DPreset: vi.fn(),
		getCurrentVolumeModality: () => undefined,
		// Mask editing (brush/eraser + labelmap export)
		setActiveMaskEditTool: vi.fn(),
		setActiveEditSegment: vi.fn(),
		setMaskBrushSize: vi.fn(),
		undoMaskEdit: vi.fn(),
		redoMaskEdit: vi.fn(),
		getMaskEditHistoryState: () => history.state,
      subscribeToSegmentationEdits: vi.fn((listener: () => void) => {
        edits.listener = listener;
        return () => { edits.listener = null; };
      }),
		getEditedSegments: vi.fn(() => new Set()),
		getSegmentationExport: vi.fn(() => null),
		hasSegmentation: vi.fn(() => false),
		getPresentSegmentIndices: vi.fn(() => null),
		buildMaskFilter: vi.fn(() => () => true),
		setBrushMaskingScope: vi.fn(),
		// Cine playback + oblique-MPR reset
		startCine: vi.fn(() => false),
		stopCine: vi.fn(),
		setReferenceLinesEnabled: vi.fn(),
		flipPaneHorizontal: vi.fn(),
		rotatePane90Clockwise: vi.fn(),
		resetMprOrientation: vi.fn(),
	};
});

import { cancelMeasurementInProgress, renderVisualization, setActiveMeasurementTool } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

function stubApi() {
	global.fetch = vi.fn(async () => ({
		ok: true, status: 200,
		arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob(), json: async () => ({}),
		text: async () => "", headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
}

const open = () =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={["/case/1"]}>
				<Routes>
					<Route path="/case/:caseId" element={<VisualizationPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

// What the browser does on a tab close or reload: a guarded page cancels the event.
const leaveIsQuestioned = () => {
	const unload = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(unload);
	return unload.defaultPrevented;
};

beforeEach(() => {
	vi.clearAllMocks();
	stubApi();
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});
afterEach(() => {
	edits.listener = null;
});

describe("leaving a case with edits", () => {
	it("asks before leaving while a segmentation edit is unsaved", async () => {
		const { unmount } = open();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		await waitFor(() => expect(edits.listener).toBeTypeOf("function"));
		edits.listener?.();
		await waitFor(() => expect(leaveIsQuestioned()).toBe(true));
		unmount();
	});

	it("does not ask when there are no unsaved edits", async () => {
		const { unmount } = open();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(leaveIsQuestioned()).toBe(false);
		unmount();
	});
});

describe("Escape during an unfinished measurement", () => {
	it("cancels the in-progress drawing before disarming viewer tools", async () => {
		const { unmount } = open();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		vi.mocked(setActiveMeasurementTool).mockClear();
		vi.mocked(cancelMeasurementInProgress).mockReturnValue(true);

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(cancelMeasurementInProgress).toHaveBeenCalled();
		expect(setActiveMeasurementTool).not.toHaveBeenCalled();
		unmount();
	});
});
