import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the viewer reads a dataset case from, decided by a HEAD probe of the lab server's CT.
// PanTS fallback masks pass through the backend source-label adapter, including during
// storage outages. Denied cases never bypass admission through the public mirror.
// CancerVerse and AbdomenAtlas stay on the lab server because neither has a PanTS mirror.

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

import { enableVolume3D, renderVisualization } from "../helpers/CornerstoneNifti2";
import { VIEWER_PREFS_KEY, VIEWER_PREFS_VERSION } from "../helpers/viewer/viewerPrefs";
import VisualizationPage from "../routes/VisualizationPage";

const MIRROR = "https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main";

// labServer: the status the lab server gives the CT (0: the request never reaches it).
function stubApi({ labServer, mirror = 200, sessionStatus = 200, maskType = "application/gzip" }: { labServer: number; mirror?: number; sessionStatus?: number; maskType?: string }) {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "HEAD") {
			if (url.includes("/api/session-reconstruction/") || url.includes("/api/session-ct/")) {
				return { ok: sessionStatus >= 200 && sessionStatus < 300, status: sessionStatus, headers: { get: () => "application/gzip" } };
			}
			if (url.includes("/api/get-main-nifti/")) {
				if (labServer === 0) throw new TypeError("Failed to fetch");
				return { ok: labServer < 300, status: labServer, headers: { get: () => null } };
			}
			if (url.startsWith(MIRROR)) return { ok: mirror < 300, status: mirror, headers: { get: () => null } };
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
	openRoute(`/case/${caseId}`);

const openRoute = (path: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/case/:caseId" element={<VisualizationPage />} />
					<Route path="/session/:sessionId" element={<VisualizationPage />} />
					<Route path="/reconstruction/:reconstructionId" element={<VisualizationPage />} />
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
	window.localStorage.removeItem(VIEWER_PREFS_KEY);
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});

describe("reconstruction session sources", () => {
	it("opens only the reconstructed CT and keeps segmentation controls and saved organ panels hidden", async () => {
		stubApi({ labServer: 200 });
		window.localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({
			version: VIEWER_PREFS_VERSION,
			prefs: { panels: { stats: true, metadata: true } },
		}));
		const { unmount } = openRoute("/reconstruction/rebuilt-scan");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(loadedUrls().ct).toMatch(/\/api\/session-reconstruction\/rebuilt-scan$/);
		expect(loadedUrls().seg).toBeUndefined();
		await waitFor(() => expect(enableVolume3D).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Segment" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open report" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Meshes" })).not.toBeInTheDocument();
		expect(screen.queryByText("Organ Statistics")).not.toBeInTheDocument();
		expect(screen.queryByText("Case Metadata")).not.toBeInTheDocument();
		const requestedUrls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(requestedUrls.some(url => /\/api\/(?:get-main-nifti|session-ct|session-segmentation|segmentation-metadata)\//.test(url))).toBe(false);
		expect(requestedUrls.some(url => url.startsWith(MIRROR))).toBe(false);
		unmount();
	});

	it.each([401, 403, 404])("never substitutes a dataset case when reconstruction admission fails (%s)", async (sessionStatus) => {
		stubApi({ labServer: 200, sessionStatus });
		const { unmount } = openRoute("/reconstruction/private-scan");
		expect(await screen.findByRole("heading", { name: "This scan isn't available" })).toBeInTheDocument();
		expect(renderVisualization).not.toHaveBeenCalled();
		const requestedUrls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(requestedUrls.some(url => url.includes("/api/get-main-nifti/") || url.startsWith(MIRROR))).toBe(false);
		unmount();
	});

	it("preserves the uploaded session CT, segmentation, and editing controls", async () => {
		stubApi({ labServer: 200 });
		const { unmount } = openRoute("/session/uploaded-scan");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(loadedUrls().ct).toMatch(/\/api\/session-ct\/uploaded-scan$/);
		expect(loadedUrls().seg).toMatch(/\/api\/session-segmentation\/uploaded-scan$/);
		expect(screen.getByRole("button", { name: "Segment" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Segment", exact: true }));
		fireEvent.click(await screen.findByRole("button", { name: "Select structure" }));
		fireEvent.click(screen.getByRole("option", { name: /^spleen$/i }));
		fireEvent.click(screen.getByRole("button", { name: "Brush", exact: true }));
		expect(within(screen.getByRole("toolbar")).getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		unmount();
	});
});

describe("dataset case sources", () => {
    it.each([401,403])("does not bypass a denied showcase/session grant through the mirror (%s)", async (labServer) => {
        stubApi({labServer,mirror:200});
        const {unmount}=open('1');
        expect(await screen.findByRole('heading',{name:"This case isn't available"})).toBeInTheDocument();
        expect(renderVisualization).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).startsWith(MIRROR))).toBe(false);
        unmount();
    });
	it("says the case is not available when the lab server and the mirror both answer 404", async () => {
		stubApi({ labServer: 404, mirror: 404 });
		const { unmount } = open("1");
		expect(await screen.findByRole("heading", { name: "This case isn't available" })).toBeInTheDocument();
		expect(renderVisualization).not.toHaveBeenCalled();
		unmount();
	});

	it("loads the mirror CT and an adapted mask while dataset storage is down without treating a mirror 404 as authoritative", async () => {
		stubApi({ labServer: 503, mirror: 404 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("heading", { name: "This case isn't available" })).toBeNull();
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?source=hf$/);
		unmount();
	});

	it.each([
		["cannot be reached", 0],
		["answers with a gateway error", 502],
		["answers with a server error", 500],
	])("loads the mirror CT and an adapted mask when the lab server %s", async (_why, labServer) => {
		stubApi({ labServer, mirror: 200 });
		const { unmount } = open("1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("heading", { name: "This case isn't available" })).toBeNull();
		const { ct, seg } = loadedUrls();
		expect(ct).toMatch(new RegExp(`^${MIRROR}/image_only/`));
		expect(seg).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?source=hf$/);
		unmount();
	});

	it("asks the backend for the converted mask of a case it reads from the mirror", async () => {
		stubApi({ labServer: 404, mirror: 200 });
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
