/**
 * Dead ends on the quiz and live-room routes say what went wrong in plain words
 * and offer a way back.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";

// Both pages hand off to the WebGL viewer on success; never reached here.
vi.mock("../routes/VisualizationPage", () => ({ default: () => <div>viewer</div> }));

import QuizPracticePage from "../education/QuizPracticePage";
import LiveRoomPage from "../liveRooms/LiveRoomPage";

const renderRoute = (path: string, pattern: string, element: ReactNode) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path={pattern} element={element} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

afterEach(() => vi.unstubAllGlobals());

describe("quiz practice error state", () => {
	it("explains a missing pack once, in plain words, with a way back to the dataset", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/quiz-packs/")
					? new Response(JSON.stringify({ error: "Quiz pack is unavailable" }), { status: 404 })
					: new Response("{}", { status: 200 })
			)
		);
		renderRoute("/learn/quiz/does-not-exist", "/learn/quiz/:packId", <QuizPracticePage />);

		expect(await screen.findByRole("heading", { level: 1, name: "This quiz can't be opened" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/may have been removed/);
		expect(screen.queryByText(/Quiz pack is unavailable/)).toBeNull();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
	});

	it("passes through a message that says something useful, like a rate limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "Too many quiz attempts created; try again later" }), { status: 429 })
			)
		);
		renderRoute("/learn/quiz/p1", "/learn/quiz/:packId", <QuizPracticePage />);
		expect(await screen.findByText("Too many quiz attempts created; try again later.")).toBeInTheDocument();
	});
});

describe("live room error state", () => {
	it("tells a link without its key to check the part after the #, with a way back", () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
		renderRoute("/live/does-not-exist", "/live/:roomId", <LiveRoomPage />);

		expect(screen.getByRole("heading", { level: 1, name: "Room unavailable" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Room link is missing its secret key.");
		expect(screen.getByRole("alert")).toHaveTextContent(/whole link/);
		expect(screen.getByRole("link", { name: "Return to dashboard" })).toHaveAttribute("href", "/dashboard");
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	/** Opens a room link that carries its key, joins it, and lets the snapshot fail. */
	const joinFailingRoom = async (status: number, body: Record<string, unknown>, heading = "Room unavailable") => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("/api/live-rooms/")
				? new Response(JSON.stringify(body), { status })
				: new Response("{}", { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);
		window.history.pushState({}, "", "/live/r1#secret");
		const user = userEvent.setup();
		renderRoute("/live/r1", "/live/:roomId", <LiveRoomPage />);
		await user.type(screen.getByLabelText("Display name"), "Ada");
		await user.click(screen.getByRole("button", { name: "Join room" }));
		await screen.findByRole("heading", { level: 1, name: heading });
		return fetchMock;
	};
	const snapshotRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
		fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/live-rooms/r1/snapshot")).length;

	const expired = vi.fn();
	beforeEach(() => {
		expired.mockClear();
		window.addEventListener("bodymaps:session-expired", expired);
	});
	afterEach(() => {
		window.removeEventListener("bodymaps:session-expired", expired);
		window.history.pushState({}, "", "/");
		sessionStorage.clear();
	});

	it("says a room the server doesn't know may have expired, or the link is incomplete", async () => {
		await joinFailingRoom(404, { error: "Room not found", code: "room_not_found" });
		expect(screen.getByRole("alert")).toHaveTextContent(
			"This room may have expired (rooms are deleted 24 hours after they are created) or the link may be incomplete. Check that you have the whole link, including the part after the #."
		);
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("reads a refused room key as an incomplete link", async () => {
		await joinFailingRoom(401, { error: "Invalid room key", code: "invalid_room_key" });
		expect(screen.getByRole("alert")).toHaveTextContent(/link may be incomplete/);
		expect(expired).not.toHaveBeenCalled();
	});

	it("tells an expired room to ask the host for a new one", async () => {
		await joinFailingRoom(410, { error: "Room expired", code: "room_expired" }, "Live Room expired");
		expect(screen.getByRole("alert")).toHaveTextContent("Room data is deleted 24 hours after the room is created. Ask the host to start a new room.");
	});

	it("doesn't blame the link, or show a raw status, when the server is down, and tries again", async () => {
		const fetchMock = await joinFailingRoom(503, {});
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("We couldn't load this room. Try again in a moment.");
		expect(alert).not.toHaveTextContent(/whole link/);
		expect(alert).not.toHaveTextContent(/503/);
		expect(snapshotRequests(fetchMock)).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(snapshotRequests(fetchMock)).toBe(2));
		expect(await screen.findByRole("heading", { level: 1, name: "Room unavailable" })).toBeInTheDocument();
	});

	it("reports an ended sign-in instead of blaming the link", async () => {
		await joinFailingRoom(401, { error: "Authentication required", code: "authentication_required" });
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Your session ended. Sign in to continue.");
		expect(alert).not.toHaveTextContent(/whole link/);
		expect(expired).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("goes back to the room's case when this tab knows it", async () => {
		sessionStorage.setItem("bodymaps.live-room.r1.case-id", "35");
		await joinFailingRoom(404, { error: "Room not found", code: "room_not_found" });
		expect(screen.getByRole("link", { name: "Return to case 35" })).toHaveAttribute("href", "/case/35");
	});

	it("never throws when the browser blocks site data", () => {
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		const storage = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(blocked);
		try {
			vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
			render(
				<MemoryRouter initialEntries={["/live/r1"]}>
					<Routes>
						<Route path="/live/:roomId" element={<LiveRoomPage />} />
					</Routes>
				</MemoryRouter>
			);
			expect(screen.getByRole("alert")).toHaveTextContent("Room link is missing its secret key.");
			expect(screen.getByRole("link", { name: "Return to dashboard" })).toBeInTheDocument();
		} finally {
			storage.mockRestore();
		}
	});
});

describe("message page surface", () => {
	it("lifts the dark page ground while it shows, and puts it back on the way out", async () => {
		const { default: MessagePage } = await import("../components/MessagePage");
		const { DARK_ROUTE_CLASS } = await import("../helpers/routeSurface");
		window.history.pushState({}, "", "/learn/quiz/p1");
		document.documentElement.classList.add(DARK_ROUTE_CLASS);

		const { unmount } = render(
			<AuthProvider>
				<MemoryRouter>
					<MessagePage title="This quiz can't be opened" actions={[{ label: "Browse the dataset", to: "/dashboard" }]} />
				</MemoryRouter>
			</AuthProvider>
		);
		expect(document.documentElement.classList.contains(DARK_ROUTE_CLASS)).toBe(false);

		unmount();
		expect(document.documentElement.classList.contains(DARK_ROUTE_CLASS)).toBe(true);
		document.documentElement.classList.remove(DARK_ROUTE_CLASS);
		window.history.pushState({}, "", "/");
	});
});
