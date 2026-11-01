import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

// Exercise the real page's HD dialog, cancellation, and annotation gate while
// replacing the GPU boundary with deferred loaders. The separate viewer helper
// suite exercises actual CT/mask upgrade transactions below that boundary.
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
		upgradeSegmentationVolume: vi.fn(async () => false),
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
		saveSegmentation: vi.fn(async () => ({ labelled_voxels: 10 })),
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

vi.mock("../components/viewer/MeshViewer", () => ({
	fetchMeshManifest: vi.fn(async () => ({ organs: [] })),
	SegmentationMeshViewer: () => null,
}));

import { renderVisualization, upgradeCtVolume, upgradeSegmentationVolume } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function renderViewer() {
	return render(
		<AuthProvider><MemoryRouter initialEntries={["/case/35"]}>
			<Link to="/case/36">Next test case</Link>
			<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
		</MemoryRouter></AuthProvider>
	);
}

async function startAnnotationUpgrade() {
	await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
	await waitFor(() => expect(screen.getByRole("button", { name: "Segment", exact: true })).toBeEnabled());
	expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Segment", exact: true }));
	await screen.findByRole("dialog", { name: "Loading HD resolution" });
}

beforeEach(() => {
	vi.clearAllMocks();
	viewerVolumeSequence.value = 0;
	vi.mocked(upgradeCtVolume).mockReset().mockResolvedValue("hd-ct");
	vi.mocked(upgradeSegmentationVolume).mockReset().mockResolvedValue(true);
	global.fetch = vi.fn(async () => ({
		ok: true, status: 200,
		arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob(),
		json: async () => ({}), text: async () => "",
		headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
});

describe("annotation HD cancellation", () => {
	it.each(["CT", "mask"] as const)("dismisses a stalled %s download immediately and waits for rollback before retry", async (stage) => {
		const stalledCt = deferred<string | null>();
		const stalledMask = deferred<boolean>();
		if (stage === "CT") vi.mocked(upgradeCtVolume).mockReturnValueOnce(stalledCt.promise);
		else vi.mocked(upgradeSegmentationVolume).mockReturnValueOnce(stalledMask.promise);
		renderViewer();
		await startAnnotationUpgrade();
		const stalledLoader = stage === "CT" ? upgradeCtVolume : upgradeSegmentationVolume;
		await waitFor(() => expect(stalledLoader).toHaveBeenCalledOnce());
		const signal = vi.mocked(stalledLoader).mock.calls[0][1];
		expect(signal?.aborted).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Cancel HD loading" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loading HD resolution" })).not.toBeInTheDocument());
		expect(signal?.aborted).toBe(true);
		const segment = screen.getByRole("button", { name: "Segment", exact: true });
		expect(segment).toHaveAttribute("aria-pressed", "false");
		expect(segment).toBeDisabled();
		expect(viewerDispose).not.toHaveBeenCalled();
		expect(renderVisualization).toHaveBeenCalledOnce();
		if (stage === "CT") expect(upgradeSegmentationVolume).not.toHaveBeenCalled();

		// A cancelled loader may finish later. Its result must never unlock painting.
		await act(async () => {
			stalledCt.resolve("cancelled-hd-ct");
			stalledMask.resolve(true);
		});
		await waitFor(() => expect(segment).toBeEnabled());
		expect(segment).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("dialog", { name: "Loading HD resolution" })).not.toBeInTheDocument();

		fireEvent.click(segment);
		await waitFor(() => expect(segment).toHaveAttribute("aria-pressed", "true"));
		expect(upgradeCtVolume).toHaveBeenCalledTimes(2);
		expect(upgradeSegmentationVolume).toHaveBeenCalledTimes(stage === "CT" ? 1 : 2);
		const retrySignal = vi.mocked(upgradeCtVolume).mock.calls[1][1];
		expect(retrySignal).not.toBe(signal);
		expect(retrySignal?.aborted).toBe(false);
	});

	it("cancels with Escape while the mask download is stalled", async () => {
		const mask = deferred<boolean>();
		vi.mocked(upgradeSegmentationVolume).mockReturnValueOnce(mask.promise);
		renderViewer();
		await startAnnotationUpgrade();
		await waitFor(() => expect(upgradeSegmentationVolume).toHaveBeenCalledOnce());
		expect(screen.getByRole("button", { name: "Cancel HD loading" })).toHaveFocus();
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loading HD resolution" })).not.toBeInTheDocument());
		expect(vi.mocked(upgradeSegmentationVolume).mock.calls[0][1]?.aborted).toBe(true);
		await act(async () => { mask.resolve(false); });
		expect(screen.getByRole("button", { name: "Segment", exact: true })).toHaveAttribute("aria-pressed", "false");
	});

	it("does not let a cancelled case clear the next case's active upgrade", async () => {
		const previous = deferred<string | null>();
		const current = deferred<string | null>();
		vi.mocked(upgradeCtVolume).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
		renderViewer();
		await startAnnotationUpgrade();
		await waitFor(() => expect(upgradeCtVolume).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "Cancel HD loading" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loading HD resolution" })).not.toBeInTheDocument());
		fireEvent.click(screen.getByRole("link", { name: "Next test case" }));
		await waitFor(() => expect(renderVisualization).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole("button", { name: "Segment", exact: true })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Segment", exact: true }));
		await screen.findByRole("dialog", { name: "Loading HD resolution" });
		await waitFor(() => expect(upgradeCtVolume).toHaveBeenCalledTimes(2));

		await act(async () => { previous.resolve("stale-case-35-hd"); });
		expect(screen.getByRole("dialog", { name: "Loading HD resolution" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Segment", exact: true })).toHaveAttribute("aria-pressed", "false");
		expect(upgradeSegmentationVolume).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel HD loading" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loading HD resolution" })).not.toBeInTheDocument());
		expect(vi.mocked(upgradeCtVolume).mock.calls[1][1]?.aborted).toBe(true);
		await act(async () => { current.resolve(null); });
	});

	it("aborts a stalled upgrade when the viewer unmounts", async () => {
		const ct = deferred<string | null>();
		vi.mocked(upgradeCtVolume).mockReturnValueOnce(ct.promise);
		const view = renderViewer();
		await startAnnotationUpgrade();
		await waitFor(() => expect(upgradeCtVolume).toHaveBeenCalledOnce());
		const signal = vi.mocked(upgradeCtVolume).mock.calls[0][1];
		view.unmount();
		expect(signal?.aborted).toBe(true);
		await act(async () => { ct.resolve("late-hd"); });
		expect(upgradeSegmentationVolume).not.toHaveBeenCalled();
	});
});
