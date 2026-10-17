import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the viewer reads a dataset case from, decided by a HEAD probe of the lab server's CT.
// PanTS fallback masks pass through the backend's source-label adapter. CancerVerse and
// AbdomenAtlas stay on the lab server because neither dataset has a PanTS mirror.

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

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

import { renderVisualization } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

const MIRROR = "https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main";

// labServer: the status the lab server gives the CT (0: the request never reaches it).
function stubApi({ labServer, maskType = "application/gzip" }: { labServer: number; maskType?: string }) {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "HEAD") {
			if (url.includes("/api/get-main-nifti/")) {
				if (labServer === 0) throw new TypeError("Failed to fetch");
				return { ok: labServer < 300, status: labServer, headers: { get: () => null } };
			}
			if (url.includes("/api/get-segmentations/")) return { ok: true, status: 200, headers: { get: () => maskType } };
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

const loadedUrls = () => {
	const call = vi.mocked(renderVisualization).mock.calls.at(-1);
	return { ct: call?.[4], seg: call?.[5] };
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});

describe("dataset case sources", () => {
	it("loads a PanTS CT from the mirror and routes its mask through the backend adapter", async () => {
		stubApi({ labServer: 404 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?source=hf$/);
		unmount();
	});

	it("keeps the Report button and the tumor mask on a CancerVerse case", async () => {
		stubApi({ labServer: 200 });
		const { unmount } = open("CV_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(loadedUrls().seg).toMatch(/\/api\/get-segmentations\/CV_00000007\.nii\.gz\?res=low$/);
		expect(screen.getByRole("button", { name: "Open report" })).toBeInTheDocument();
		unmount();
	});

	it("loads an AbdomenAtlas case from the lab server, with its mask as stored, and never from the mirror", async () => {
		stubApi({ labServer: 200 });
		const { unmount } = open("BDMAP_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(/\/api\/get-main-nifti\/BDMAP_00000007\.nii\.gz\?res=low$/);
		expect(seg).toMatch(/\/api\/get-segmentations\/BDMAP_00000007\.nii\.gz\?res=low$/);
		expect(String(ct) + String(seg)).not.toContain("huggingface");
		expect(screen.getByRole("button", { name: "Open report" })).toBeInTheDocument();
		unmount();
	});

	it("opens an AbdomenAtlas case CT-only when the route answers that its mask is not built", async () => {
		stubApi({ labServer: 200, maskType: "application/json" });
		const { unmount } = open("BDMAP_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(loadedUrls().ct).toMatch(/\/api\/get-main-nifti\/BDMAP_00000007\.nii\.gz/);
		expect(loadedUrls().seg).toBeFalsy();
		unmount();
	});
});
