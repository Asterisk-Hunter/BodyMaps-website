import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../helpers/viewer/segmentationFile", async (importOriginal) => ({
	...(await importOriginal<typeof import("../helpers/viewer/segmentationFile")>()),
	downloadBytes: vi.fn(),
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
		upgradeCtVolume: vi.fn(async () => "hd-ct"),
		upgradeSegmentationVolume: vi.fn(async () => true),
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
		saveSharedSegmentation: vi.fn(async () => ({ labelled_voxels: 12 })),
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
		flipPaneVertical: vi.fn(),
		resetMprOrientation: vi.fn(),
	};
});

vi.mock("../helpers/NiiVueNifti", () => ({
	create3DVolume: vi.fn().mockResolvedValue(undefined),
	moveNiiVueCrosshairToMm: vi.fn(),
	updateVisibilities: vi.fn(),
}));

import { downloadBytes } from "../helpers/viewer/segmentationFile";
import { applyRemoteMeasurement, clearMeasurements, LENGTH_TOOL, renderVisualization, flipPaneHorizontal, flipPaneVertical, getSegmentationExport, saveSegmentation, saveSharedSegmentation, subscribeToSegmentationEdits } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";
import type { EducationResult, QuizPracticeController, SoloChallengeController } from "../education/types";
import type { LiveRoomController } from "../liveRooms/types";

// A dataset scan has one version for everybody, so its Save button writes a file to the person's computer.
async function openAnnotationSave({ saveName = "Save" }: { saveName?: string } = {}) {
	await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
	expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Segment", exact: true }));
	fireEvent.click(await screen.findByRole("button", { name: "Select structure" }));
	fireEvent.click(screen.getByRole("option", { name: /^spleen$/i }));
	fireEvent.click(screen.getByRole("button", { name: "Brush", exact: true }));
	const save = within(screen.getByRole("toolbar")).getByRole("button", { name: saveName, exact: true });
	expect(save).toBeEnabled();
	expect(screen.getAllByRole("button", { name: saveName, exact: true })).toHaveLength(1);
	return save;
}

function quizController(maskUrl: string | null = null): QuizPracticeController {
	return {
		pack: {
			pack_id: "radworld-case-35-v1",
			version: 1,
			case_id: "35",
			title: "Case 35",
			difficulty: "easy",
			provenance: {},
			generator_version: "test",
			validator_version: "test",
			questions: [{ id: "organ", prompt: "Which organ?", choices: [] }],
		},
		questionIndex: 0,
		answers: {},
		result: null,
		maskUrl,
		submitting: false,
		error: null,
		dockOpen: false,
		setDockOpen: vi.fn(),
		selectAnswer: vi.fn(),
		previous: vi.fn(),
		next: vi.fn(),
		reportContent: vi.fn(async () => {}),
	};
}

function soloChallengeController(overrides: Partial<SoloChallengeController> = {}): SoloChallengeController {
	return {
		challenge: {
			challenge_id: "challenge-1", case_id: "35", title: "Find the lesion", eyebrow: "Challenge",
			prompt: "Review the CT", time_limit_seconds: 300, finding_choices: [], requirements: [],
			scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" },
		},
		attempt: {
			attempt_id: "attempt-1", attempt_key: "key", challenge_id: "challenge-1", status: "active",
			started_at: "2026-01-01T00:00:00Z", deadline_at: "2026-01-01T00:05:00Z", delete_at: "2026-01-02T00:00:00Z",
		},
		remainingSeconds: 0, findingChoice: "", impression: "", marker: null, measurement: null,
		setFindingChoice: vi.fn(), setImpression: vi.fn(), setMarker: vi.fn(), setMeasurement: vi.fn(),
		result: null, maskUrl: null, submitting: false, retryingGrade: false, error: null,
		submit: vi.fn(async () => {}), retryGrade: vi.fn(async () => {}), taskDockOpen: false,
		setTaskDockOpen: vi.fn(), clearSession: vi.fn(),
		...overrides,
	};
}

const soloResult: EducationResult = {
	attempt_id: "attempt-1", challenge_id: "challenge-1", status: "provisional",
	submitted_at: "2026-01-01T00:05:00Z", elapsed_seconds: 300,
	objective_points: 0, total_points: null, max_points: 100,
	scores: {
		localization: { points: 0, max_points: 35, distance_mm: null, inside_lesion: false },
		measurement: { points: 0, max_points: 15, measured_mm: null, reference_mm: 30, error_percent: null },
		finding: { points: 0, max_points: 10, selected: "", correct: "focal_pancreatic_lesion" },
	},
	ai_grade: { status: "provisional", model: "test", rubric_version: 1, criteria: null, points: null, max_points: 40, feedback: null },
	ground_truth: {
		correct_finding: "focal_pancreatic_lesion", correct_finding_label: "Lesion", segmentation_label: 1,
		mesh_organ_id: 28, location: "Pancreas", reference_diameter_mm: 30,
		reference_measurement_lps: [], teaching_points: [],
	},
};

function soloViewer(controller: SoloChallengeController) {
	return <MemoryRouter initialEntries={["/live/challenge/challenge-1"]}>
		<VisualizationPage soloChallenge={controller} />
	</MemoryRouter>;
}

function liveRoomController(maskUrl = "blob:mask-1"): LiveRoomController {
	const measurement = {
		id: "measurement-1",
		tool: LENGTH_TOOL,
		points: [[1, 2, 3], [4, 5, 6]],
		polyline: [],
		text: "5 mm",
		label: "Lesion",
		frame_of_reference: "frame-1",
		metadata: {},
	};
	return {
		metadata: {
			room_id: "room-1", case_id: "35", resolution: "low",
			created_at: "2026-08-17T00:00:00Z", expires_at: "2026-08-18T00:00:00Z",
			geometry_hash: "hash", dimensions: [4, 4, 2], latest_seq: 0, mode: "review",
		},
		roomKey: "secret",
		maskUrl,
		participantId: "self",
		name: "Viewer",
		connectionState: "connected",
		participants: [{ participant_id: "self", name: "Viewer", color: "#22d3ee", role: "reviewer" }],
		state: { measurements: { [measurement.id]: measurement }, notes: {}, chat: [] },
		pendingEvents: [],
		acknowledgeEvents: vi.fn(),
		followingId: null,
		error: null,
		undoNotice: null,
		quiz: null,
		quizOwnSubmissions: {},
		quizEligible: false,
		isHost: false,
		collaborationLocked: false,
		sendDurable: vi.fn(async () => true), sendPresence: vi.fn(), sendView: vi.fn(), sendChat: vi.fn(async () => true),
		addNote: vi.fn(async () => true), deleteNote: vi.fn(async () => true), requestUndo: vi.fn(), follow: vi.fn(),
		stopFollowing: vi.fn(), copyShareLink: vi.fn(async () => {}), downloadExport: vi.fn(async () => {}),
		startQuiz: vi.fn(() => false), answerQuiz: vi.fn(() => false), closeQuiz: vi.fn(() => false),
		revealQuiz: vi.fn(() => false), advanceQuiz: vi.fn(() => false),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	viewerVolumeSequence.value = 0;
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		json: async () => ({}),
		text: async () => "",
		headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
});

describe("solo challenge timeout recovery in the viewer", () => {
	beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
	afterEach(() => vi.useRealTimers());

	it("retries a failed or skipped timeout submit with bounded backoff", async () => {
		const submit = vi.fn(async () => {});
		const view = render(soloViewer(soloChallengeController({ submit })));
		await act(async () => {});
		expect(submit).toHaveBeenCalledExactlyOnceWith(null, true);

		for (const [index, delay] of [3000, 6000, 12000, 24000, 30000].entries()) {
			await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
			expect(submit).toHaveBeenCalledTimes(index + 1);
			await act(async () => { await vi.advanceTimersByTimeAsync(1); });
			expect(submit).toHaveBeenCalledTimes(index + 2);
		}
		await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
		expect(submit).toHaveBeenCalledTimes(6);
		view.unmount();
	});

	it("stops retrying when a result arrives before the next retry", async () => {
		const submit = vi.fn(async () => {});
		const controller = soloChallengeController({ submit });
		const view = render(soloViewer(controller));
		await act(async () => {});
		view.rerender(soloViewer({ ...controller, result: soloResult }));
		await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
		expect(submit).toHaveBeenCalledOnce();
		view.unmount();
	});

	it("uses the latest submit handler after an in-flight manual submission is skipped", async () => {
		const skippedSubmit = vi.fn(async () => {});
		const controller = soloChallengeController({ submit: skippedSubmit, submitting: true });
		const view = render(soloViewer(controller));
		await act(async () => {});
		const nextSubmit = vi.fn(async () => {});
		view.rerender(soloViewer({ ...controller, submit: nextSubmit, submitting: false }));
		await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
		expect(skippedSubmit).toHaveBeenCalledOnce();
		expect(nextSubmit).toHaveBeenCalledExactlyOnceWith(null, true);
		view.unmount();
	});

	it("cancels a scheduled retry when the viewer unmounts", async () => {
		const submit = vi.fn(async () => {});
		const view = render(soloViewer(soloChallengeController({ submit })));
		await act(async () => {});
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		view.unmount();
		await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
		expect(submit).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not schedule a retry when an outstanding submit settles after unmount", async () => {
		let finishSubmit: (() => void) | undefined;
		const submit = vi.fn(() => new Promise<void>((resolve) => { finishSubmit = resolve; }));
		const view = render(soloViewer(soloChallengeController({ submit })));
		await act(async () => {});
		expect(submit).toHaveBeenCalledOnce();
		view.unmount();
		await act(async () => { finishSubmit?.(); });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("viewer smoke test", () => {
	it("restores saved class names and colours into the loaded viewer", async () => {
		const fallback = global.fetch;
		const custom = { 80: { name: "My target", color: [12, 34, 56, 255] } };
		global.fetch = vi.fn(async (input, init) => String(input).includes("/segmentation-metadata/")
			? new Response(JSON.stringify({ custom_structures: custom, revision: "revision-1" }))
			: fallback(input, init));
		render(<AuthProvider><MemoryRouter initialEntries={["/case/1"]}>
			<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
		</MemoryRouter></AuthProvider>);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const call = vi.mocked(renderVisualization).mock.calls.at(-1)!;
		expect(call[7]?.customLabels).toEqual(custom);
		expect(call[3][80]).toEqual(custom[80].color);
	});
	it("keeps undo, redo, and save out of the always-visible viewer toolbar", async () => {
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
	});

	it("offers flip horizontal and flip vertical in the View menu, and no rotate", async () => {
		render(<AuthProvider><MemoryRouter initialEntries={["/case/35"]}>
			<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
		</MemoryRouter></AuthProvider>);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "View options" }));
		expect(screen.getByRole("menuitem", { name: "Flip horizontal" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /rotate/i })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("menuitem", { name: "Flip vertical" }));
		expect(flipPaneVertical).toHaveBeenCalledTimes(1);
		expect(flipPaneHorizontal).not.toHaveBeenCalled();
	});

	it("does not offer an invert toggle in the View menu", async () => {
		render(<AuthProvider><MemoryRouter initialEntries={["/case/35"]}>
			<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
		</MemoryRouter></AuthProvider>);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "View options" }));
		expect(screen.queryByRole("menuitem", { name: /^invert/i })).not.toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Reference lines" })).toBeInTheDocument();
	});

	it("opens AI, live rooms, and shortcuts directly from the viewer toolbar", async () => {
		render(<AuthProvider><MemoryRouter initialEntries={["/case/35"]}>
			<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
		</MemoryRouter></AuthProvider>);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());

		expect(screen.queryByRole("button", { name: "More viewer tools" })).not.toBeInTheDocument();
		const assistant = screen.getByRole("button", { name: "BodyMaps AI" });
		expect(assistant).toBeEnabled();
		expect(assistant).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(assistant);
		expect(assistant).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByLabelText("BodyMaps AI assistant")).toBeInTheDocument();
		fireEvent.click(assistant);
		expect(assistant).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
		expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));
		fireEvent.click(screen.getByRole("button", { name: "Start Live Room" }));
		expect(screen.getByRole("dialog", { name: "Live Rooms" })).toBeInTheDocument();
	});

	it.each([
		{ name: "live review", props: { liveRoom: liveRoomController() }, assistant: true },
		{ name: "live quiz", props: { liveRoom: { ...liveRoomController(), metadata: { ...liveRoomController().metadata, mode: "quiz" as const } } }, assistant: false },
		{ name: "solo challenge", props: { soloChallenge: soloChallengeController() }, assistant: false },
		{ name: "quiz practice", props: { quizPractice: quizController("blob:reveal-mask") }, assistant: true },
	])("preserves direct tool availability in $name", async ({ props, assistant }) => {
		render(<AuthProvider><MemoryRouter><VisualizationPage {...props} /></MemoryRouter></AuthProvider>);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(Boolean(screen.queryByRole("button", { name: "BodyMaps AI" }))).toBe(assistant);
		expect(screen.queryByRole("button", { name: "Start Live Room" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeEnabled();
	});

	it("shows a failed save in the viewer and lets the user retry", async () => {
		vi.mocked(saveSegmentation).mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ labelled_voxels: 10 });
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/session/abc123"]}>
					<Routes><Route path="/session/:sessionId" element={<VisualizationPage />} /></Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		fireEvent.click(await openAnnotationSave());
		expect(await screen.findByText("Save failed")).toBeVisible();
		expect(screen.getByText("Save failed")).toHaveAttribute("title", "Save failed. Your edits are still here.");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("Saved")).toBeVisible();
		expect(saveSegmentation).toHaveBeenCalledTimes(2);
	});

	it("binds a viewer save to the account that opened the session", async () => {
		const fallback = global.fetch;
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/api/auth/me")) {
				return new Response(JSON.stringify({ user: { id: "viewer-owner-1", email: "viewer@example.com" } }));
			}
			return fallback(input, init);
		});
		global.fetch = fetchMock as typeof fetch;

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/session/abc123"]}>
					<Routes><Route path="/session/:sessionId" element={<VisualizationPage />} /></Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		fireEvent.click(await openAnnotationSave());

		await waitFor(() => expect(saveSegmentation).toHaveBeenCalledWith(expect.any(String), "abc123", "full", "viewer-owner-1"));
	});

	describe("Save to JHU server (shared annotation override)", () => {
		type Status = { supported: boolean; exists?: boolean; revision?: string; saved_by?: string | null; can_override: boolean };
		const mountCase = async (status: Status | null, path = "/case/35") => {
			const fallback = global.fetch;
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/auth/me")) return new Response(JSON.stringify({ user: { id: "viewer-owner-1", email: "viewer@example.com" } }));
				if (url.includes("/api/shared-annotation/")) {
					return status ? new Response(JSON.stringify(status)) : new Response("{}", { status: 500 });
				}
				return fallback(input, init);
			});
			global.fetch = fetchMock as typeof fetch;
			render(
				<AuthProvider>
					<MemoryRouter initialEntries={[path]}>
						<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
					</MemoryRouter>
				</AuthProvider>
			);
			await openAnnotationSave({ saveName: "Save to computer" });
			return fetchMock;
		};
		const sharedButton = () => screen.queryByRole("button", { name: "Save to JHU server" });
		let confirmSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
			vi.mocked(getSegmentationExport).mockImplementation(() => ({
				dimensions: [2, 1, 1], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: [0, 1],
			}));
		});
		afterEach(() => {
			confirmSpy.mockRestore();
			vi.mocked(getSegmentationExport).mockImplementation(() => null);
		});

		it.each(["/case/35", "/case/CV_00000001", "/case/BDMAP_00000001"])("is offered to approved annotators on %s, above Save to computer", async (path) => {
			const fetchMock = await mountCase({ supported: true, exists: false, revision: "none", can_override: true }, path);
			const shared = await screen.findByRole("button", { name: "Save to JHU server" });
			expect(shared).toBeEnabled();
			const local = within(screen.getByRole("toolbar")).getByRole("button", { name: "Save to computer", exact: true });
			expect(shared.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(within(screen.getByRole("toolbar")).queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument(); // no account-private Save
			const id = path.split("/").pop()!;
			expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/shared-annotation/${id}`))).toBe(true);
		});

		it("is not offered to an account without permission", async () => {
			const fetchMock = await mountCase({ supported: true, exists: false, revision: "none", can_override: false });
			await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/shared-annotation/35"))).toBe(true));
			expect(sharedButton()).not.toBeInTheDocument(); // normal users never see it
			expect(screen.getByRole("button", { name: "Save to computer", exact: true })).toBeEnabled();
			expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
		});

		it("is not offered when the status cannot be read or the scan has no shared version", async () => {
			await mountCase(null);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(sharedButton()).not.toBeInTheDocument();
		});

		it("is not offered on a scan the server says is unsupported", async () => {
			await mountCase({ supported: false, can_override: true });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(sharedButton()).not.toBeInTheDocument();
		});

		it("asks before replacing what everyone sees, then saves with the owner and resolution", async () => {
			await mountCase({ supported: true, exists: true, revision: "r1", saved_by: "Dr. Lee", can_override: true });
			fireEvent.click(await screen.findByRole("button", { name: "Save to JHU server" }));
			expect(confirmSpy).toHaveBeenCalledTimes(1);
			expect(String(confirmSpy.mock.calls[0][0])).toMatch(/EVERYONE/);
			expect(String(confirmSpy.mock.calls[0][0])).toMatch(/Dr\. Lee/);
			await waitFor(() => expect(saveSharedSegmentation).toHaveBeenCalledWith(expect.any(String), "35", "full", "viewer-owner-1", "r1")); // the revision it was opened at
			expect(await screen.findByText("Saved for everyone")).toBeVisible();
			expect(saveSegmentation).not.toHaveBeenCalled();
		});

		it("does nothing when the annotator cancels the confirmation", async () => {
			confirmSpy.mockReturnValue(false);
			await mountCase({ supported: true, exists: false, revision: "none", can_override: true });
			fireEvent.click(await screen.findByRole("button", { name: "Save to JHU server" }));
			expect(saveSharedSegmentation).not.toHaveBeenCalled();
			expect(screen.queryByText("Saved for everyone")).not.toBeInTheDocument();
		});

		it("shows the server's reason when someone else saved first", async () => {
			vi.mocked(saveSharedSegmentation).mockRejectedValueOnce(new Error("Someone saved a newer shared version since you opened this scan. Reopen it before saving."));
			await mountCase({ supported: true, exists: false, revision: "none", can_override: true });
			fireEvent.click(await screen.findByRole("button", { name: "Save to JHU server" }));
			expect(await screen.findByText(/Someone saved a newer shared version/)).toBeVisible();
			expect(screen.queryByText("Saved for everyone")).not.toBeInTheDocument();
		});

		// The viewer mock never reports edits by itself; keep the page's listeners so a test can make one.
		const captureEditListener = () => {
			const listeners = new Set<(detail?: unknown) => void>();
			vi.mocked(subscribeToSegmentationEdits).mockImplementation((callback: (detail?: unknown) => void) => {
				listeners.add(callback);
				return () => { listeners.delete(callback); };
			});
			return () => act(() => { listeners.forEach((listener) => listener()); });
		};
		const switchStructure = () => {
			fireEvent.click(screen.getByRole("button", { name: /select structure|spleen/i }));
			fireEvent.click(screen.getByRole("option", { name: /^liver$/i }));
		};

		it("keeps an annotator's edit unsaved until they save it for everyone, and never saves a personal copy", async () => {
			const edit = captureEditListener();
			await mountCase({ supported: true, exists: false, revision: "none", can_override: true });
			await screen.findByRole("button", { name: "Save to JHU server" });
			edit();
			expect(await screen.findByText("Unsaved")).toBeVisible();
			switchStructure(); // switching structure auto-saves a normal case; here it must change nothing
			await new Promise((resolve) => setTimeout(resolve, 50));
			fireEvent.click(screen.getByRole("button", { name: /select structure|liver/i }));
			fireEvent.click(screen.getByRole("option", { name: /^spleen$/i }));
			fireEvent.click(screen.getByRole("button", { name: "Brush", exact: true }));
			expect(await screen.findByText("Unsaved")).toBeVisible(); // still unsaved: nothing was saved behind their back
			expect(saveSegmentation).not.toHaveBeenCalled();
			expect(saveSharedSegmentation).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "Save to JHU server" }));
			expect(await screen.findByText("Saved for everyone")).toBeVisible();
			await waitFor(() => expect(screen.queryByText("Unsaved")).not.toBeInTheDocument());
			expect(saveSegmentation).not.toHaveBeenCalled();
			expect(downloadBytes).not.toHaveBeenCalled(); // saving for everyone does not also download a file
		});

		it("keeps the annotator's edit unsaved when the shared save fails", async () => {
			vi.mocked(saveSharedSegmentation).mockRejectedValueOnce(new Error("Offline"));
			const edit = captureEditListener();
			await mountCase({ supported: true, exists: false, revision: "none", can_override: true });
			await screen.findByRole("button", { name: "Save to JHU server" });
			edit();
			fireEvent.click(await screen.findByRole("button", { name: "Save to JHU server" }));
			expect(await screen.findByText("Offline")).toBeVisible();
			expect(screen.getByText("Unsaved")).toBeVisible();
		});

		it("lets a plain reader save to their computer, and never to the server", async () => {
			const edit = captureEditListener();
			const fetchMock = await mountCase({ supported: true, exists: false, revision: "none", can_override: false });
			await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/shared-annotation/35"))).toBe(true));
			edit();
			expect(await screen.findByText("Unsaved")).toBeVisible();
			fireEvent.click(screen.getByRole("button", { name: "Save to computer", exact: true }));
			expect(await screen.findByText("Saved")).toBeVisible();
			expect(downloadBytes).toHaveBeenCalledTimes(1);
			const [bytes, fileName] = vi.mocked(downloadBytes).mock.calls[0];
			expect(fileName).toBe("segmentation_35.nii.gz");
			expect(bytes).toBeInstanceOf(Uint8Array);
			expect(Array.from((bytes as Uint8Array).slice(0, 2))).toEqual([0x1f, 0x8b]); // a gzip file
			expect(saveSegmentation).not.toHaveBeenCalled();
			expect(saveSharedSegmentation).not.toHaveBeenCalled();
		});

		it("shows a failed download and keeps the edit unsaved", async () => {
			vi.mocked(getSegmentationExport).mockImplementation(() => null);
			const edit = captureEditListener();
			await mountCase({ supported: true, exists: false, revision: "none", can_override: false });
			edit();
			fireEvent.click(await screen.findByRole("button", { name: "Save to computer", exact: true }));
			expect(await screen.findByText("Save failed")).toBeVisible();
			expect(downloadBytes).not.toHaveBeenCalled();
		});

		it("an annotator's Save to computer downloads a file and does not replace what everyone sees", async () => {
			const edit = captureEditListener();
			await mountCase({ supported: true, exists: false, revision: "none", can_override: true });
			edit();
			fireEvent.click(await screen.findByRole("button", { name: "Save to computer", exact: true }));
			await waitFor(() => expect(downloadBytes).toHaveBeenCalledTimes(1));
			expect(saveSharedSegmentation).not.toHaveBeenCalled();
		});
	});

	describe("Adjust panel", () => {
		const openAdjust = async () => {
			render(<AuthProvider><MemoryRouter initialEntries={["/case/35"]}>
				<Routes><Route path="/case/:caseId" element={<VisualizationPage />} /></Routes>
			</MemoryRouter></AuthProvider>);
			await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
			fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
			return await screen.findByRole("menu");
		};

		it("has no border slider: the border is a fixed part of the look", async () => {
			const panel = await openAdjust();
			expect(within(panel).queryByLabelText("Mask border opacity")).not.toBeInTheDocument();
			expect(within(panel).queryByText("Border")).not.toBeInTheDocument();
			expect(within(panel).getByLabelText("Mask fill opacity")).toBeInTheDocument();
		});

		it("says Brightness and Contrast in full, with the real numbers beside them", async () => {
			const panel = await openAdjust();
			expect(within(panel).getByText("Brightness")).toBeInTheDocument();
			expect(within(panel).getByText("Contrast")).toBeInTheDocument();
			expect(within(panel).queryByText("Brt")).not.toBeInTheDocument();
			expect(within(panel).queryByText("Con")).not.toBeInTheDocument();
			expect(within(panel).getByText("L 40 HU")).toBeInTheDocument(); // the default soft-tissue window level
			expect(within(panel).getByText("W 400 HU")).toBeInTheDocument(); // and window width
			expect(within(panel).getByTitle(/lower number is a brighter image/i)).toBeInTheDocument();
		});
	});

	it("VisualizationPage mounts for a dataset case without crashing", async () => {
		const { container, unmount } = render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		expect(container.firstChild).toBeTruthy();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const options = vi.mocked(renderVisualization).mock.calls.at(-1)?.[7];
		expect(options?.resourceKey).toContain("get-main-nifti/1.nii.gz");
		expect(options?.signal?.aborted).toBe(false);
		unmount();
		expect(options?.signal?.aborted).toBe(true);
		expect(viewerDispose).toHaveBeenCalledOnce();
	});

	it("aborts an in-flight load and disposes its late result", async () => {
		const staleDispose = vi.fn();
		let resolveLoad!: (value: Awaited<ReturnType<typeof renderVisualization>>) => void;
		vi.mocked(renderVisualization).mockImplementationOnce(() => new Promise((resolve) => {
			resolveLoad = resolve;
		}));

		const { unmount } = render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const options = vi.mocked(renderVisualization).mock.calls.at(-1)?.[7];

		unmount();
		expect(options?.signal?.aborted).toBe(true);
		await act(async () => {
			resolveLoad({
				renderingEngine: {} as never,
				viewportIds: [],
				volumeId: "stale-volume",
				dispose: staleDispose,
			});
		});

		await waitFor(() => expect(staleDispose).toHaveBeenCalledOnce());
	});

	it("rehydrates authoritative live-room measurements after viewer replacement", async () => {
		const initialRoom = liveRoomController();
		const view = (room: LiveRoomController) => (
			<AuthProvider>
				<MemoryRouter>
					<VisualizationPage liveRoom={room} />
				</MemoryRouter>
			</AuthProvider>
		);
		const { rerender } = render(view(initialRoom));

		await waitFor(() => expect(applyRemoteMeasurement).toHaveBeenCalledWith(initialRoom.state.measurements["measurement-1"]));
		const initialRenderCount = vi.mocked(renderVisualization).mock.calls.length;
		const initialHydrationCount = vi.mocked(applyRemoteMeasurement).mock.calls.length;

		const replacementRoom = { ...initialRoom, maskUrl: "blob:mask-2" };
		rerender(view(replacementRoom));

		await waitFor(() => expect(vi.mocked(renderVisualization).mock.calls.length).toBeGreaterThan(initialRenderCount));
		await waitFor(() => expect(vi.mocked(applyRemoteMeasurement).mock.calls.length).toBeGreaterThan(initialHydrationCount));
		expect(applyRemoteMeasurement).toHaveBeenLastCalledWith(replacementRoom.state.measurements["measurement-1"]);
		expect(clearMeasurements).toHaveBeenCalled();
	});

	it("loads quiz-practice CT before reveal mask is available", async () => {
		const controller = quizController();

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/learn/quiz/radworld-case-35-v1"]}>
					<VisualizationPage quizPractice={controller} />
				</MemoryRouter>
			</AuthProvider>
		);

		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(vi.mocked(renderVisualization).mock.calls.at(-1)?.[5]).toBeUndefined();
	});

	it("does not offer or dispatch a catalog save for a quiz reveal mask", async () => {
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/learn/quiz/radworld-case-35-v1?hd=1"]}>
					<VisualizationPage quizPractice={quizController("blob:reveal-mask")} />
				</MemoryRouter>
			</AuthProvider>
		);

		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Save Segmentation" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
		expect(saveSegmentation).not.toHaveBeenCalled();
	});

	it("applies windowing to CT actor after reveal labelmap becomes default", async () => {
		const ctUpdateRange = vi.fn();
		const segmentationUpdateRange = vi.fn();
		const actor = (referencedId: string, updateRange: () => void) => ({
			referencedId,
			actor: {
				getProperty: () => ({
					getRGBTransferFunction: () => ({
						setMappingRange: vi.fn(),
						updateRange,
					}),
				}),
			},
		});
		const segmentationActor = actor("bodymaps-seg-test-g1", segmentationUpdateRange);
		const ctActor = actor("ct-volume", ctUpdateRange);
		const viewport = {
			getActors: () => [segmentationActor, ctActor],
			getDefaultActor: () => segmentationActor,
			render: vi.fn(),
		};
		vi.mocked(renderVisualization).mockResolvedValueOnce({
			renderingEngine: { render: vi.fn(), getViewport: () => viewport },
			viewportIds: ["viewport-1"],
			volumeId: "ct-volume",
			dispose: vi.fn(),
		} as never);

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/learn/quiz/radworld-case-35-v1"]}>
					<VisualizationPage quizPractice={quizController("blob:reveal-mask")} />
				</MemoryRouter>
			</AuthProvider>
		);

		await waitFor(() => expect(ctUpdateRange).toHaveBeenCalled());
		expect(segmentationUpdateRange).not.toHaveBeenCalled();
	});
});
