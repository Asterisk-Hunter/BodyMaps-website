import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { segmentation_categories } from "../helpers/constants";

// A CancerVerse case's organ panel is one "Tumors" group: every tumor type until the mask has
// loaded, then only the types the loaded mask holds. The class list is read from the mask once,
// when its last slice arrives, so the group must narrow on that signal and not stay at the full
// list it showed while the mask was still streaming in.

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));
const present = vi.hoisted(() => ({ value: null as Set<number> | null }));
const loaded = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

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
		getMaskEditHistoryState: vi.fn(() => ({ canUndo: false, canRedo: false })),
		subscribeToSegmentationEdits: vi.fn(() => () => {}),
		getEditedSegments: vi.fn(() => new Set()),
		getSegmentationExport: vi.fn(() => null),
		hasSegmentation: vi.fn(() => false),
		getPresentSegmentIndices: vi.fn(() => present.value),
		subscribeToSegmentationLoaded: vi.fn((cb: () => void) => {
			loaded.listeners.add(cb);
			return () => loaded.listeners.delete(cb);
		}),
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

import { renderVisualization } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

const idOf = (key: string) => segmentation_categories.indexOf(key as never) + 1;

function stubApi() {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/get-segmentations/") && init?.method === "HEAD") {
			return { ok: true, status: 200, headers: { get: () => "application/gzip" } };
		}
		return {
			ok: true, status: 200,
			arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob(), json: async () => ({}),
			text: async () => "", headers: { get: () => "application/json" },
		};
	}) as unknown as typeof fetch;
}

const open = (caseId: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[`/case/${caseId}`]}>
				<Routes>
					<Route path="/case/:caseId" element={<VisualizationPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

beforeEach(() => {
	vi.clearAllMocks();
	present.value = null;
	loaded.listeners.clear();
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});

describe("CancerVerse tumor group after the mask loads", () => {
	it("lists every tumor type while the mask loads, then only the ones it holds", async () => {
		stubApi();
		const { findByText, queryByText, unmount } = open("CV_00000007");
		expect(await findByText("Tumors")).toBeTruthy();
		expect(await findByText("liver lesion")).toBeTruthy();
		expect(await findByText("gallbladder lesion")).toBeTruthy();
		await waitFor(() => expect(loaded.listeners.size).toBeGreaterThan(0));

		present.value = new Set([0, idOf("liver_lesion")]);
		act(() => loaded.listeners.forEach((cb) => cb()));

		await waitFor(() => expect(queryByText("gallbladder lesion")).toBeNull());
		expect(queryByText("liver lesion")).toBeTruthy();
		expect(queryByText("Digestive System")).toBeNull();
		unmount();
	});

	it("keeps the full tumor list when the loaded mask holds no known class", async () => {
		stubApi();
		const { findByText, queryByText, unmount } = open("CV_00000007");
		expect(await findByText("gallbladder lesion")).toBeTruthy();
		await waitFor(() => expect(loaded.listeners.size).toBeGreaterThan(0));

		present.value = new Set([0]);
		act(() => loaded.listeners.forEach((cb) => cb()));

		expect(await findByText("gallbladder lesion")).toBeTruthy();
		expect(queryByText("liver lesion")).toBeTruthy();
		unmount();
	});
});
