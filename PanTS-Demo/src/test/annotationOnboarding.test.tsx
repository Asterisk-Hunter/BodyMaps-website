import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationOnboarding from "../components/viewer/AnnotationOnboarding";

function renderTour(options: { targetRects?: DOMRect[]; fallbackReason?: "missing" | "offscreen" | null } = {}) {
	const onNext = vi.fn();
	const onBack = vi.fn();
	const onSkip = vi.fn();
	const view = render(
		<AnnotationOnboarding step={0} targetRects={[]} fallbackReason={null} onNext={onNext} onBack={onBack} onSkip={onSkip} {...options} />,
	);
	return { ...view, onNext, onBack, onSkip };
}

describe("AnnotationOnboarding", () => {
	it("shows a non-modal, compact first step and focuses Next", () => {
		renderTour();

		const dialog = screen.getByRole("dialog", { name: "Pick a structure" });
		expect(dialog).not.toHaveAttribute("aria-modal");
		expect(dialog.querySelectorAll(".atb-onb__progress-segment")).toHaveLength(4);
		expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
		expect(document.querySelector(".atb-onb__overlay")).toBeNull();
	});

	it("supports Next, Back, the final Get started action, and Skip tour", () => {
		const { rerender, onNext, onBack, onSkip } = renderTour();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(onNext).toHaveBeenCalledTimes(1);

		rerender(
			<AnnotationOnboarding step={1} targetRects={[]} fallbackReason={null} onNext={onNext} onBack={onBack} onSkip={onSkip} />,
		);
		expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(onBack).toHaveBeenCalledTimes(1);

		rerender(
			<AnnotationOnboarding step={3} targetRects={[]} fallbackReason={null} onNext={onNext} onBack={onBack} onSkip={onSkip} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Get started" }));
		expect(onNext).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
		expect(onSkip).toHaveBeenCalledTimes(1);
	});

	it("lets Escape skip the tour and stops it reaching global shortcuts", () => {
		const { onSkip } = renderTour();
		const globalShortcut = vi.fn();
		window.addEventListener("keydown", globalShortcut);
		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => screen.getByRole("button", { name: "Next" }).dispatchEvent(escape));
		window.removeEventListener("keydown", globalShortcut);

		expect(escape.defaultPrevented).toBe(true);
		expect(onSkip).toHaveBeenCalledTimes(1);
		expect(globalShortcut).not.toHaveBeenCalled();
	});

	it("leaves Escape available for another active viewer control", () => {
		const { onSkip } = renderTour();
		const input = document.createElement("input");
		document.body.append(input);
		input.focus();
		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => input.dispatchEvent(escape));
		expect(escape.defaultPrevented).toBe(false);
		expect(onSkip).not.toHaveBeenCalled();
		input.remove();
	});

	it("does not refocus Next when an anchored control moves", () => {
		const onNext = vi.fn();
		const onSkip = vi.fn();
		const rect = (left: number) => ({
			top: 120,
			left,
			width: 160,
			height: 36,
			bottom: 156,
			right: left + 160,
			x: left,
			y: 120,
			toJSON: () => ({}),
		}) as DOMRect;
		const view = render(
			<>
				<button type="button">Structure picker</button>
				<AnnotationOnboarding step={0} targetRects={[rect(80)]} fallbackReason={null} onNext={onNext} onSkip={onSkip} />
			</>,
		);
		const picker = screen.getByRole("button", { name: "Structure picker" });
		picker.focus();
		view.rerender(
			<>
				<button type="button">Structure picker</button>
				<AnnotationOnboarding step={0} targetRects={[rect(120)]} fallbackReason={null} onNext={onNext} onSkip={onSkip} />
			</>,
		);
		expect(picker).toHaveFocus();
	});

	it("draws a non-interactive highlight around each real target", () => {
		const rect = { left: 36, top: 48, right: 196, bottom: 84, width: 160, height: 36, x: 36, y: 48, toJSON: () => ({}) } as DOMRect;
		renderTour({ targetRects: [rect] });

		const highlight = document.querySelector<HTMLElement>(".atb-onb__highlight");
		expect(highlight?.parentElement).toHaveAttribute("aria-hidden", "true");
		expect(highlight).toHaveStyle({ left: "36px", top: "48px", width: "160px", height: "36px" });
	});

	it("uses honest fallback copy and renders no highlight when the picker is unavailable", () => {
		render(<AnnotationOnboarding step={3} targetRects={[]} fallbackReason="missing" onNext={() => {}} onSkip={() => {}} />);

		expect(screen.getByRole("heading", { name: "Choose a structure with a mask" })).toBeInTheDocument();
		expect(screen.getByText(/create one with AI or Draw, or switch to a structure with an existing mask/i)).toBeInTheDocument();
		expect(document.querySelector(".atb-onb__highlight")).toBeNull();
	});

	it("explains when a real target exists but is still offscreen", () => {
		render(<AnnotationOnboarding step={3} targetRects={[]} fallbackReason="offscreen" onNext={() => {}} onSkip={() => {}} />);

		expect(screen.getByRole("heading", { name: "Find Save in the toolbar" })).toBeInTheDocument();
		expect(screen.getByText(/Save may be offscreen/i)).toBeInTheDocument();
		expect(screen.queryByText(/choose a structure with a mask/i)).toBeNull();
	});
});
