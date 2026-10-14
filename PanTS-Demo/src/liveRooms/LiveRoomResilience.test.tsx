import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_ENDED_TEXT } from "../education/sessionEnded";
import { LiveRoomDock } from "./LiveRoomChrome";
import LiveRoomCreateDialog from "./LiveRoomCreateDialog";
import type { LiveQuizState, LiveRoomController } from "./types";
import { ROOM_FULL_ERROR, rejoinHint } from "./useLiveRoom";

function controller(overrides: Partial<LiveRoomController> = {}): LiveRoomController {
	return {
		metadata: {
			room_id: "room-1", case_id: "35", resolution: "low",
			created_at: "2026-07-12T00:00:00Z", expires_at: "2026-07-13T00:00:00Z",
			geometry_hash: "hash", dimensions: [4, 4, 2], latest_seq: 0,
			mode: "review",
		},
		roomKey: "secret",
		maskUrl: "blob:mask",
		participantId: "self",
		name: "Ronit",
		connectionState: "connected",
		participants: [
			{ participant_id: "self", name: "Ronit", color: "#22d3ee", role: "reviewer" },
			{ participant_id: "peer", name: "Maya", color: "#f59e0b", role: "reviewer", plane: "axial" },
		],
		state: { measurements: {}, notes: {}, chat: [] },
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
		sendDurable: vi.fn(), sendPresence: vi.fn(), sendView: vi.fn(), sendChat: vi.fn(),
		addNote: vi.fn(), deleteNote: vi.fn(), requestUndo: vi.fn(), follow: vi.fn(),
		stopFollowing: vi.fn(), copyShareLink: vi.fn(), downloadExport: vi.fn(),
		startQuiz: vi.fn(), answerQuiz: vi.fn(), closeQuiz: vi.fn(), revealQuiz: vi.fn(), advanceQuiz: vi.fn(),
		...overrides,
	};
}

function quizRoom(quiz: Partial<LiveQuizState>): LiveRoomController {
	return controller({
		metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
		quiz: {
			phase: "question_open", question_index: 0, question_count: 4,
			current_question: { id: "organ", prompt: "Which organ?", choices: [{ id: "pancreas", label: "Pancreas" }, { id: "liver", label: "Liver" }] },
			deadline_at: "2099-01-01T00:00:00Z", remaining_seconds: 30, timer_paused: false,
			response_count: 1, eligible_count: 3, reveal: null, leaderboard: [],
			consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 }, round_completed: false, host_connected: true,
			...quiz,
		},
	});
}

describe("live quiz dock", () => {
	it("keeps the countdown out of the live region and announces answers and phases", () => {
		render(<LiveRoomDock room={quizRoom({})} crosshair={null} activePlane="axial" onClose={vi.fn()} />);

		const timer = screen.getByRole("timer");
		expect(timer.textContent).toMatch(/\d+s$/);
		expect(timer.closest("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent("Question 1 open. 1 of 3 answered.");
		expect(screen.getByRole("status")).not.toHaveTextContent(/\d+s/);
	});

	it("marks the correct answer in the distribution after its count", () => {
		const room = quizRoom({
			phase: "question_revealed",
			reveal: {
				correct_choice_id: "pancreas", distribution: { pancreas: 2, liver: 1 },
				explanation: "The crosshair is within the pancreas.", viewer_cue: {},
			} as unknown as LiveQuizState["reveal"],
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		const rows = within(screen.getByRole("list", { name: "Answer distribution" })).getAllByRole("listitem");
		expect(rows[0]).toHaveTextContent("Pancreas2 Correct answer");
		expect(rows[1]).toHaveTextContent("Liver1");
		expect(rows[1]).not.toHaveTextContent("Correct answer");
	});

	it("pauses answering while the connection is down", () => {
		render(<LiveRoomDock room={{ ...quizRoom({}), connectionState: "reconnecting", quizEligible: true }} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		expect(screen.getByText("Reconnecting. Answers and host controls are paused.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Pancreas/ })).toBeDisabled();
	});
});

describe("stopped connection", () => {
	it("asks for a reload, except when reloading cannot help", () => {
		expect(rejoinHint("This Live Room connection was replaced by another tab.")).toBe(" Reload to rejoin.");
		expect(rejoinHint(ROOM_FULL_ERROR)).toBe("");
		expect(rejoinHint(SESSION_ENDED_TEXT)).toBe("");
	});

	it("tells a reader whose sign-in ended to sign in, not to reload", () => {
		render(<LiveRoomDock room={controller({ connectionState: "error", error: SESSION_ENDED_TEXT })} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		expect(screen.getByText(SESSION_ENDED_TEXT)).toBeInTheDocument();
		expect(screen.queryByText(/Reload to rejoin/)).toBeNull();
	});
});

function LocationProbe() {
	const location = useLocation();
	return <output aria-label="Current route">{location.pathname}</output>;
}

describe("create dialog with site data blocked", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("opens and still creates the room", async () => {
		// Blocked cookies or a sandboxed iframe: even reaching sessionStorage throws.
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		const storage = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(blocked);
		try {
			vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				if (!init?.method) return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
				return Promise.resolve(new Response(JSON.stringify({ room_id: "room-9", case_id: "35", room_key: "k" }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}));
			}));
			render(
				<MemoryRouter initialEntries={["/case/35"]}>
					<LiveRoomCreateDialog caseId="35" open onClose={vi.fn()} />
					<LocationProbe />
				</MemoryRouter>,
			);
			fireEvent.click(screen.getByRole("button", { name: /Collaborative Review/i }));
			expect(screen.getByLabelText("Display name")).toHaveValue("");
			fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reader" } });
			fireEvent.submit(screen.getByLabelText("Display name").closest("form")!);

			await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/live/room-9"));
			expect(screen.queryByRole("alert")).toBeNull();
		} finally {
			storage.mockRestore();
		}
	});
});
