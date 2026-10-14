import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EducationResult, SoloChallengeController } from "./types";
import {
	clearSoloChallengeSession,
	readSoloChallengeSession,
	writeSoloChallengeSession,
} from "./soloChallengeSession";

vi.mock("../routes/VisualizationPage", () => ({
	default: ({ soloChallenge }: { soloChallenge: SoloChallengeController }) => (
		<main>
			<span>{soloChallenge.attempt.attempt_id}</span>
			<span>{soloChallenge.maskUrl ?? "reveal hidden"}</span>
			<span data-testid="solo-error">{soloChallenge.error}</span>
			<span data-testid="solo-reveal-error">{soloChallenge.revealError}</span>
			<span data-testid="solo-deadline">{soloChallenge.deadlineMissed ? "deadline missed" : "open"}</span>
			<button onClick={() => void soloChallenge.submit(null)}>Submit attempt</button>
		</main>
	),
}));

import SoloChallengePage from "./SoloChallengePage";
import { SoloChallengeDock } from "./SoloChallengeChrome";

const challengeId = "pancreas-case-35";
const challenge = {
	challenge_id: challengeId,
	case_id: "35",
	title: "Find the abnormal area in the pancreas",
	eyebrow: "BodyMaps Solo Challenge 01",
	prompt: "Review the CT scan.",
	time_limit_seconds: 300,
	finding_choices: [],
	requirements: [],
	scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" as const },
};
const attempt = {
	attempt_id: "attempt-new",
	attempt_key: "key",
	challenge_id: challengeId,
	started_at: "2099-01-01T12:00:00Z",
	deadline_at: "2099-01-01T12:05:00Z",
	delete_at: "2099-01-02T12:00:00Z",
	status: "active" as const,
};
const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sessionEnded = () =>
	jsonResponse({ error: "Authentication required", code: "authentication_required" }, 401);
const renderPage = () =>
	render(
		<MemoryRouter initialEntries={[`/live/challenge/${challengeId}`]}>
			<Routes>
				<Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
			</Routes>
		</MemoryRouter>,
	);
const saveAttempt = (result: EducationResult | null = null) =>
	writeSoloChallengeSession(challengeId, {
		attempt,
		findingChoice: "",
		impression: "",
		marker: null,
		measurement: null,
		result,
	});

describe("SoloChallengePage failures", () => {
	beforeEach(() => sessionStorage.clear());
	afterEach(() => vi.unstubAllGlobals());

	it("keeps the start card after a failed start, shows why and lets the learner try again", async () => {
		let starts = 0;
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/attempts") && init?.method === "POST") {
				starts += 1;
				return starts === 1
					? jsonResponse({ error: "Too many quiz attempts created; try again later" }, 429)
					: jsonResponse(attempt);
			}
			if (url.endsWith("/result")) return jsonResponse({ error: "Attempt has not been submitted" }, 400);
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Too many quiz attempts created");
		expect(screen.queryByText("Challenge unavailable")).not.toBeInTheDocument();
		expect(document.querySelector(".edu-loading")).toBeNull();
		expect(screen.getByRole("link", { name: "Return to case 35" })).toHaveAttribute("href", "/case/35");

		const retry = screen.getByRole("button", { name: /Try again/ });
		await waitFor(() => expect(retry).toBeEnabled());
		fireEvent.click(retry);
		expect(await screen.findByText("attempt-new")).toBeInTheDocument();
	});

	it("says plainly when the server cannot run the challenge, and offers only the way back", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/attempts") && init?.method === "POST") {
				return jsonResponse({ error: "Case 35 ground-truth segmentation is unavailable", code: "challenge_unavailable" }, 409);
			}
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This challenge can't be started here because its answer data isn't installed on this server.",
		);
		expect(screen.queryByText(/ground-truth segmentation/)).toBeNull();
		expect(screen.queryByRole("button", { name: /Try again|Start solo challenge/ })).toBeNull();
		expect(screen.getByRole("link", { name: "Return to case 35" })).toHaveAttribute("href", "/case/35");
	});

	it("keeps the start button when the dataset storage is only down for now", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/attempts") && init?.method === "POST") {
				return jsonResponse({
					error: "The dataset storage is temporarily unavailable. Please try again in a minute.",
					code: "dataset_storage_unavailable",
				}, 503);
			}
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
		expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
	});

	it("says in words when the server cannot be reached", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/attempts") && init?.method === "POST") throw new TypeError("Failed to fetch");
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not reach the server. Check your connection and try again.",
		);
	});

	it("offers a retry without a spinner when the server cannot be reached to load the challenge", async () => {
		let loads = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			loads += 1;
			if (loads === 1) throw new TypeError("Failed to fetch");
			return jsonResponse(challenge);
		}));
		renderPage();

		expect(await screen.findByRole("heading", { name: "This challenge isn't available" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("couldn't reach the server");
		expect(document.querySelector(".edu-loading")).toBeNull();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.queryByRole("banner")).toBeNull();
		expect(screen.queryByRole("contentinfo")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: /Start solo challenge/ })).toBeInTheDocument();
	});

	it("says in words, apart from the grading error, when the reveal is unavailable after a restored result", async () => {
		saveAttempt({ attempt_id: attempt.attempt_id, challenge_id: challengeId, status: "graded" } as unknown as EducationResult);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/reveal-segmentation.nii.gz")) return jsonResponse({ error: "Reveal unavailable" }, 404);
			return jsonResponse(challenge);
		}));
		renderPage();

		await waitFor(() => {
			expect(screen.getByTestId("solo-reveal-error")).toHaveTextContent(
				"The answer overlay is not available for this challenge. Your score and review are still available.",
			);
		});
		expect(screen.getByTestId("solo-error")).toHaveTextContent("");
	});
});

describe("SoloChallengePage when the sign-in ends", () => {
	const expired = vi.fn();
	beforeEach(() => {
		sessionStorage.clear();
		expired.mockClear();
		window.addEventListener("bodymaps:session-expired", expired);
	});
	afterEach(() => {
		window.removeEventListener("bodymaps:session-expired", expired);
		vi.unstubAllGlobals();
	});

	it("keeps the saved attempt on a 401 for the account, unlike one for the attempt", async () => {
		saveAttempt();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/result")) return jsonResponse({ error: "Attempt has not been submitted" }, 400);
			if (url.endsWith("/submit")) return sessionEnded();
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: "Submit attempt" }));
		await waitFor(() => expect(screen.getByTestId("solo-error")).toHaveTextContent("Your session ended. Sign in to continue."));
		expect(expired).toHaveBeenCalledOnce();
		expect(screen.getByTestId("solo-deadline")).toHaveTextContent("open");
		expect(readSoloChallengeSession(challengeId)?.attempt.attempt_id).toBe(attempt.attempt_id);
	});

	it("still treats a refused attempt key as an expired attempt", async () => {
		saveAttempt();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/result")) return jsonResponse({ error: "Attempt has not been submitted" }, 400);
			if (url.endsWith("/submit")) return jsonResponse({ error: "Invalid attempt key", code: "invalid_attempt_key" }, 401);
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: "Submit attempt" }));
		await waitFor(() => expect(screen.getByTestId("solo-deadline")).toHaveTextContent("deadline missed"));
		expect(screen.getByTestId("solo-error")).toHaveTextContent("This attempt has expired");
		expect(expired).not.toHaveBeenCalled();
	});

	it("does not discard the saved attempt when the restore lookup finds the sign-in ended", async () => {
		saveAttempt();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/result")) return sessionEnded();
			return jsonResponse(challenge);
		}));
		renderPage();

		expect(await screen.findByText(attempt.attempt_id)).toBeInTheDocument();
		await waitFor(() => expect(expired).toHaveBeenCalledOnce());
		expect(readSoloChallengeSession(challengeId)?.attempt.attempt_id).toBe(attempt.attempt_id);
		expect(screen.getByText(attempt.attempt_id)).toBeInTheDocument();
	});

	it("reports the ended sign-in instead of calling the answer overlay unavailable", async () => {
		saveAttempt({ attempt_id: attempt.attempt_id, challenge_id: challengeId, status: "graded" } as unknown as EducationResult);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/reveal-segmentation.nii.gz")) return sessionEnded();
			return jsonResponse(challenge);
		}));
		renderPage();

		await waitFor(() => expect(expired).toHaveBeenCalledOnce());
		expect(screen.getByTestId("solo-reveal-error")).toHaveTextContent("");
	});
});

describe("the AI tutor when the sign-in ends", () => {
	const expired = vi.fn();
	beforeEach(() => {
		expired.mockClear();
		window.addEventListener("bodymaps:session-expired", expired);
	});
	afterEach(() => {
		window.removeEventListener("bodymaps:session-expired", expired);
		vi.unstubAllGlobals();
	});

	const result = {
		attempt_id: attempt.attempt_id, challenge_id: challengeId, status: "graded",
		submitted_at: "2099-01-01T12:03:00Z", elapsed_seconds: 180,
		objective_points: 60, total_points: 96, max_points: 100,
		scores: {
			localization: { points: 35, max_points: 35, distance_mm: 0, inside_lesion: true },
			measurement: { points: 15, max_points: 15, measured_mm: 31, reference_mm: 30, error_percent: 3.3 },
			finding: { points: 10, max_points: 10, selected: "focal_pancreatic_lesion", correct: "focal_pancreatic_lesion" },
		},
		ai_grade: { status: "graded", model: "qwen", rubric_version: 1, criteria: { finding: 10, location: 9, evidence: 8, impression: 9 }, points: 36, max_points: 40, feedback: "Calibrated." },
		ground_truth: { correct_finding: "focal_pancreatic_lesion", correct_finding_label: "Abnormal area in the pancreas", segmentation_label: 1, mesh_organ_id: 28, location: "pancreatic head", reference_diameter_mm: 30, reference_measurement_lps: [], teaching_points: [] },
	} as unknown as EducationResult;
	const ask = async (answer: () => Response) => {
		vi.stubGlobal("fetch", vi.fn(async () => answer()));
		const controller = { challenge, attempt, result, taskDockOpen: true, setTaskDockOpen: vi.fn() } as unknown as SoloChallengeController;
		render(<SoloChallengeDock controller={controller} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />);
		fireEvent.change(screen.getByPlaceholderText("Ask why the measurement or impression was scored this way…"), { target: { value: "Why?" } });
		fireEvent.click(screen.getByRole("button", { name: "Send question to AI tutor" }));
		await screen.findByText(/Could not reach the tutor/);
	};

	it("reports the ended sign-in when a question meets it", async () => {
		await ask(sessionEnded);
		expect(expired).toHaveBeenCalledOnce();
	});

	it("does not report it for a tutor that is only unavailable", async () => {
		await ask(() => jsonResponse({ error: "Tutor unavailable" }, 503));
		expect(expired).not.toHaveBeenCalled();
	});
});

describe("solo challenge session storage", () => {
	it("reads nothing, and never throws, when site data is blocked", () => {
		// Cookies off or a sandboxed iframe: even reaching sessionStorage throws.
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		const storage = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(blocked);
		try {
			expect(readSoloChallengeSession(challengeId)).toBeNull();
			expect(() => writeSoloChallengeSession(challengeId, {
				attempt, findingChoice: "", impression: "", marker: null, measurement: null, result: null,
			})).not.toThrow();
			expect(() => clearSoloChallengeSession(challengeId)).not.toThrow();
		} finally {
			storage.mockRestore();
		}
	});
});
