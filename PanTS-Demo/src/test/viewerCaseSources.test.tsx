import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the viewer reads a dataset case from, decided by a HEAD probe of the lab server's CT.
// A case is only "not in the dataset" when the lab server answers 404 and the public mirror
// does too. Any other answer that is not OK (unreachable, any 5xx such as the dataset storage
// being down, a refused 401 or 403) loads the case from the mirror, mask included, because the
// lab server will not read or convert the mask either. A case the lab server says it does not
// store (404) still gets its mask from the backend, which reads the mirror and converts the
// organ numbering. A CancerVerse case keeps its Report button.

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

// labServer: the status the lab server gives the CT (0: the request never reaches it);
// mirror: the status the mirror gives it.
function stubApi({ labServer, mirror }: { labServer: number; mirror: number }) {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "HEAD") {
			if (url.includes("/api/get-main-nifti/")) {
				if (labServer === 0) throw new TypeError("Failed to fetch");
				return { ok: labServer < 300, status: labServer, headers: { get: () => null } };
			}
			if (url.startsWith(MIRROR)) return { ok: mirror < 300, status: mirror, headers: { get: () => null } };
			if (url.includes("/api/get-segmentations/")) return { ok: true, status: 200, headers: { get: () => "application/gzip" } };
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
	it("says the case is not available when the lab server and the mirror both answer 404", async () => {
		stubApi({ labServer: 404, mirror: 404 });
		const { unmount } = open("1");
		expect(await screen.findByRole("heading", { name: "This case isn't available" })).toBeInTheDocument();
		expect(renderVisualization).not.toHaveBeenCalled();
		unmount();
	});

	it("loads the mirror's CT and mask while the dataset storage is down, even for a case the mirror lacks", async () => {
		stubApi({ labServer: 503, mirror: 404 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("heading", { name: "This case isn't available" })).toBeNull();
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(new RegExp(`^${MIRROR}/mask_only/`));
		unmount();
	});

	it.each([
		["cannot be reached", 0],
		["answers with a gateway error", 502],
		["answers with a server error", 500],
		["answers that the sign-in has ended", 401],
		["refuses the request", 403],
	])("loads the mirror's CT and mask when the lab server %s", async (_why, labServer) => {
		stubApi({ labServer, mirror: 200 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("heading", { name: "This case isn't available" })).toBeNull();
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(new RegExp(`^${MIRROR}/mask_only/`));
		unmount();
	});

	it("asks the backend for the converted mask of a case it reads from the mirror", async () => {
		stubApi({ labServer: 404, mirror: 200 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?labels=viewer-v1$/);
		unmount();
	});

	it("keeps the Report button and the tumor mask on a CancerVerse case", async () => {
		stubApi({ labServer: 200, mirror: 404 });
		const { unmount } = open("CV_00000007");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(loadedUrls().seg).toMatch(/\/api\/get-segmentations\/CV_00000007\.nii\.gz\?res=low$/);
		expect(screen.getByRole("button", { name: "Open report" })).toBeInTheDocument();
		unmount();
	});
});
