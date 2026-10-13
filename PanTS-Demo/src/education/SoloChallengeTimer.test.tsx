import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SoloChallengeDock, SoloChallengeHeader } from "./SoloChallengeChrome";
import type { EducationChallenge, SoloChallengeController } from "./types";

const challenge: EducationChallenge = {
	challenge_id: "pancreas-case-35",
	case_id: "35",
	title: "Find the abnormal area in the pancreas",
	eyebrow: "BodyMaps Solo Challenge 01",
	prompt: "Review the scan.",
	time_limit_seconds: 300,
	finding_choices: [
		{ id: "no_focal_lesion", label: "No focal pancreatic lesion" },
		{ id: "focal_pancreatic_lesion", label: "Focal pancreatic lesion" },
	],
	requirements: [],
	scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" },
};

function controller(overrides: Partial<SoloChallengeController> = {}): SoloChallengeController {
	return {
		challenge,
		attempt: {
			attempt_id: "attempt-1", attempt_key: "key", challenge_id: challenge.challenge_id,
			started_at: "2026-07-31T12:00:00Z", deadline_at: "2026-07-31T12:05:00Z",
			delete_at: "2026-08-01T12:00:00Z", status: "active",
		},
		remainingSeconds: 240,
		findingChoice: "focal_pancreatic_lesion",
		setFindingChoice: vi.fn(),
		impression: "Focal pancreatic lesion with a measurable axial diameter.",
		setImpression: vi.fn(),
		marker: [-5, -5, 2],
		setMarker: vi.fn(),
		measurement: null,
		setMeasurement: vi.fn(),
		result: null,
		submitting: false,
		retryingGrade: false,
		error: null,
		submit: vi.fn(),
		retryGrade: vi.fn(),
		taskDockOpen: true,
		setTaskDockOpen: vi.fn(),
		clearSession: vi.fn(),
		...overrides,
	};
}

describe("Solo Challenge timer", () => {
	// The ticking clock sits in no live region; a separate status line speaks
	// only at one minute left and at time up, so its text changes rarely.
	it("keeps the clock out of every live region", () => {
		render(<SoloChallengeHeader controller={controller({ remainingSeconds: 240 })} />);
		const timer = screen.getByRole("timer");
		expect(timer).toHaveTextContent("04:00");
		expect(timer.closest("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(/^$/);
	});

	it("announces the last minute once and then time up", () => {
		const { rerender } = render(<SoloChallengeHeader controller={controller({ remainingSeconds: 61 })} />);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent(/^$/);

		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 60 })} />);
		expect(status).toHaveTextContent("One minute remaining.");
		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 59 })} />);
		expect(status).toHaveTextContent("One minute remaining.");
		expect(screen.getByRole("timer")).toHaveTextContent("00:59");

		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 0 })} />);
		expect(status).toHaveTextContent("Time is up.");
	});

	it("keeps Submit disabled for an incomplete form until time runs out, then lets it through", () => {
		const incomplete = { findingChoice: "focal_pancreatic_lesion", marker: null, impression: "" };
		const dock = (remainingSeconds: number) => (
			<SoloChallengeDock controller={controller({ ...incomplete, remainingSeconds })} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />
		);
		const { rerender } = render(dock(30));
		expect(screen.getByRole("button", { name: /Submit interpretation/i })).toBeDisabled();
		rerender(dock(0));
		expect(screen.getByRole("button", { name: /Submit interpretation/i })).toBeEnabled();
	});
});
