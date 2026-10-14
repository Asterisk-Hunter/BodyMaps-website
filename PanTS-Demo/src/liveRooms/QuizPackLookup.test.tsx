import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import LiveRoomCreateDialog from "./LiveRoomCreateDialog";

function LocationProbe() {
	const location = useLocation();
	return <output aria-label="Current route">{location.pathname}</output>;
}

function renderDialog(caseId: string) {
	return render(
		<MemoryRouter initialEntries={[`/case/${caseId}`]}>
			<LiveRoomCreateDialog caseId={caseId} open onClose={vi.fn()} />
			<LocationProbe />
		</MemoryRouter>,
	);
}

// Answers the case's pack lookup from `packs` (case id -> pack id) and every other GET with no playlists.
function stubCatalog(packs: Record<string, string>) {
	const fetchMock = vi.fn((input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname.endsWith("/api/education/quiz-packs")) {
			const caseId = url.searchParams.get("case_id") || "";
			const packId = packs[caseId];
			return Promise.resolve(new Response(JSON.stringify({ pack: packId ? { pack_id: packId, case_id: caseId, title: "Quiz", difficulty: "hard" } : null }), { status: 200 }));
		}
		return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

// Lets the lookup's reply, its JSON and the state update that follows all land.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const lookups = (fetchMock: ReturnType<typeof vi.fn>) =>
	fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/api/education/quiz-packs"));

describe("Solo VQA Practice card", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("opens the reviewed case 35 pack on case 35 without a lookup", () => {
		const fetchMock = stubCatalog({ "35": "radworld-case-35-v1" });
		renderDialog("35");
		fireEvent.click(screen.getByRole("button", { name: /Solo VQA Practice/i }));
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/radworld-case-35-v1");
		expect(lookups(fetchMock)).toEqual([]);
	});

	it("opens the pack the catalog has for any other case", async () => {
		const fetchMock = stubCatalog({ "35": "radworld-case-35-v1", "3849": "pants-case-00003849-v2" });
		renderDialog("3849");
		await waitFor(() => expect(lookups(fetchMock)).toEqual([expect.stringContaining("/api/education/quiz-packs?case_id=3849")]));
		await settle();
		const card = screen.getByRole("button", { name: /Solo VQA Practice/i });
		expect(card).toBeEnabled();
		fireEvent.click(card);
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/pants-case-00003849-v2");
	});

	it("stays enabled and opens the default pack when no pack covers the case", async () => {
		const fetchMock = stubCatalog({ "35": "radworld-case-35-v1" });
		renderDialog("34");
		await waitFor(() => expect(lookups(fetchMock)).toHaveLength(1));
		await settle();
		const card = screen.getByRole("button", { name: /Solo VQA Practice/i });
		expect(card).toBeEnabled();
		expect(card).toHaveTextContent("Untimed linked-question pack with answer review.");
		fireEvent.click(card);
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/radworld-case-35-v1");
	});

	it("stays enabled while the lookup runs and when it fails", async () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
		renderDialog("34");
		const card = screen.getByRole("button", { name: /Solo VQA Practice/i });
		expect(card).toBeEnabled();
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		await settle();
		expect(card).toBeEnabled();
		fireEvent.click(card);
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/radworld-case-35-v1");
	});

	it("still finds the case's pack when live rooms are switched off", async () => {
		vi.stubEnv("VITE_LIVE_ROOMS_ENABLED", "false");
		const fetchMock = stubCatalog({ "3849": "pants-case-00003849-v2" });
		renderDialog("3849");
		await waitFor(() => expect(lookups(fetchMock)).toHaveLength(1));
		await settle();
		fireEvent.click(screen.getByRole("button", { name: /Solo VQA Practice/i }));
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/pants-case-00003849-v2");
		// Only the solo lookup: nothing that belongs to live rooms is requested.
		expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => !url.includes("/api/education/quiz-packs?"))).toEqual([]);
	});
});
