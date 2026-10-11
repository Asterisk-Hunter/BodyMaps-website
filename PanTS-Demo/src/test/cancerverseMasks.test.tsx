import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

// The CT viewer relies on WebGL (Niivue + Cornerstone) and a three.js loader,
// none of which run under jsdom/CI (no GPU). Mock those modules so we can verify
// the page component itself mounts and wires up without crashing.
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
		hasSegmentationVolume: vi.fn(() => false),
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

vi.mock("../helpers/NiiVueNifti", () => ({
	create3DVolume: vi.fn().mockResolvedValue(undefined),
	moveNiiVueCrosshairToMm: vi.fn(),
	updateVisibilities: vi.fn(),
}));

import { renderVisualization } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

// CancerVerse has tumor masks only, for the scans with an annotated tumor. The viewer must hand the
// mask to the viewer when the scan has one (decided before the CT URL is set, so it loads once) and
// open CT-only when it does not (the route answers {"masks_available": false}, which hangs the loader).

type Answer = { ok?: boolean; contentType?: string };

function stubApi(segAnswer: Answer | "network-error") {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/get-segmentations/") && init?.method === "HEAD") {
			if (segAnswer === "network-error") throw new TypeError("network down");
			return { ok: segAnswer.ok ?? true, status: 200, headers: { get: () => segAnswer.contentType ?? "application/gzip" } };
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

const segArg = () => vi.mocked(renderVisualization).mock.calls.at(-1)?.[5];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});

describe("CancerVerse tumor mask in the viewer", () => {
	it("loads the tumor mask alongside the CT, in a single load", async () => {
		stubApi({ contentType: "application/gzip" });
		const { unmount } = open("CV_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(String(segArg())).toContain("/api/get-segmentations/CV_00000007.nii.gz");
		expect(vi.mocked(renderVisualization).mock.calls.length).toBe(1);
		unmount();
	});

	it("opens a scan with no tumor mask CT-only, even though the route answers 200 with JSON", async () => {
		stubApi({ contentType: "application/json" });
		const { unmount } = open("CV_00000008");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(segArg()).toBeUndefined();
		unmount();
	});

	it("opens CT-only, without hanging, when the mask check fails", async () => {
		stubApi("network-error");
		const { unmount } = open("CV_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(segArg()).toBeUndefined();
		unmount();
	});

	it("opens CT-only when the route says the mask is missing", async () => {
		stubApi({ ok: false });
		const { unmount } = open("CV_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(segArg()).toBeUndefined();
		unmount();
	});

	it("still loads a PanTS case's segmentation as before", async () => {
		stubApi({ contentType: "application/gzip" });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(String(segArg())).toContain("/api/get-segmentations/1.nii.gz");
		unmount();
	});
});

describe("organ panel for CancerVerse cases", () => {
	it("lists tumors, not the PanTS organs, for a scan with a tumor mask", async () => {
		stubApi({ contentType: "application/gzip" });
		const { findByText, queryByText, unmount } = open("CV_00000007");
		expect(await findByText("Tumors")).toBeTruthy();
		// the tumor types themselves are listed (all thirteen until the loaded mask says which are present)
		expect(await findByText("liver lesion")).toBeTruthy();
		expect(await findByText("gallbladder lesion")).toBeTruthy();
		expect(queryByText("Organs")).toBeNull();
		expect(queryByText("Digestive System")).toBeNull();
		unmount();
	});

	it("says there is no tumor mask for a scan without one", async () => {
		stubApi({ contentType: "application/json" });
		const { findByText, queryByText, unmount } = open("CV_00000008");
		expect(await findByText("No tumor mask for this scan.")).toBeTruthy();
		expect(queryByText("Digestive System")).toBeNull();
		unmount();
	});

	it("keeps the PanTS organ list for a PanTS case", async () => {
		stubApi({ contentType: "application/gzip" });
		const { findByText, queryByText, unmount } = open("1");
		expect(await findByText("Digestive System")).toBeTruthy();
		expect(queryByText("Tumors")).toBeNull();
		unmount();
	});
});
