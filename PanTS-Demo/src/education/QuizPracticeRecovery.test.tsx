import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizPracticeController } from "./types";

vi.mock("../routes/VisualizationPage", () => ({
	default: ({ quizPractice }: { quizPractice: QuizPracticeController }) => (
		<main>
			<span data-testid="quiz-pack">{quizPractice.pack.pack_id}</span>
			<span data-testid="quiz-error">{quizPractice.error}</span>
			<span data-testid="quiz-score">{quizPractice.result ? `${quizPractice.result.score}/${quizPractice.result.max_score}` : "not graded"}</span>
			<button onClick={() => quizPractice.selectAnswer("pancreas")}>Pick pancreas</button>
			<button onClick={quizPractice.next}>Submit quiz</button>
		</main>
	),
}));

import QuizPracticePage from "./QuizPracticePage";

const packId = "radworld-case-35-v1";
const attempt = {
	attempt_id: "quiz-attempt-1",
	attempt_key: "quiz-key",
	pack: {
		pack_id: packId,
		version: 1,
		case_id: "35",
		title: "Case 35 quiz",
		difficulty: "medium" as const,
		provenance: {},
		generator_version: "generator/1",
		validator_version: "validator/1",
		questions: [{
			id: "organ",
			prompt: "Which organ?",
			choices: [{ id: "pancreas", label: "Pancreas" }, { id: "liver", label: "Liver" }],
			viewer_cue: {},
		}],
	},
};
const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const renderPage = () =>
	render(
		<MemoryRouter initialEntries={[`/learn/quiz/${packId}`]}>
			<Routes>
				<Route path="/learn/quiz/:packId" element={<QuizPracticePage />} />
			</Routes>
		</MemoryRouter>,
	);

describe("QuizPracticePage failures", () => {
	const expired = vi.fn();
	beforeEach(() => {
		expired.mockClear();
		window.addEventListener("bodymaps:session-expired", expired);
	});
	afterEach(() => {
		window.removeEventListener("bodymaps:session-expired", expired);
		vi.unstubAllGlobals();
	});

	it("explains a failed load in plain words and offers Try again and the dataset", async () => {
		let posts = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			posts += 1;
			if (posts === 1) throw new TypeError("Failed to fetch");
			return jsonResponse(attempt);
		}));
		renderPage();

		expect(await screen.findByRole("heading", { name: "This quiz can't be opened" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server.");
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.queryByRole("link", { name: /overview/i })).toBeNull();
		expect(screen.queryByRole("banner")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByTestId("quiz-pack")).toHaveTextContent(packId);
	});

	it("does not offer Try again for a quiz that is gone", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Quiz pack is unavailable", code: "invalid_quiz_pack_request" }, 400)));
		renderPage();

		expect(await screen.findByRole("alert")).toHaveTextContent("may have been removed or not approved yet");
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("keeps the attempt and reports the ended sign-in on a 401 for the account", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/submit")) {
				return jsonResponse({ error: "Authentication required", code: "authentication_required" }, 401);
			}
			return jsonResponse(attempt);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: "Pick pancreas" }));
		fireEvent.click(screen.getByRole("button", { name: "Submit quiz" }));
		await waitFor(() => expect(screen.getByTestId("quiz-error")).toHaveTextContent("Your session ended. Sign in to continue."));
		expect(expired).toHaveBeenCalledOnce();
		expect(screen.queryByText(/quiz session expired/)).toBeNull();
		expect(screen.getByTestId("quiz-pack")).toHaveTextContent(packId);
	});

	it("still drops an attempt whose key the server no longer accepts", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/submit")) {
				return jsonResponse({ error: "Invalid quiz attempt key", code: "invalid_quiz_attempt_key" }, 401);
			}
			return jsonResponse(attempt);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: "Pick pancreas" }));
		fireEvent.click(screen.getByRole("button", { name: "Submit quiz" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("This quiz session expired.");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(expired).not.toHaveBeenCalled();
	});
});
