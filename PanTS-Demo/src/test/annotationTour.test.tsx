import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnnotationTour, {
	ANNOTATION_TOUR_STEPS,
	ANNOTATION_TOUR_SEEN_KEY,
	hasSeenAnnotationTour,
	markAnnotationTourSeen,
} from "../components/viewer/AnnotationTour";

beforeEach(() => {
	window.localStorage.clear();
});

describe("annotation tour flag", () => {
	it("starts unseen, then stays seen once finished", () => {
		expect(hasSeenAnnotationTour()).toBe(false);
		markAnnotationTourSeen();
		expect(window.localStorage.getItem(ANNOTATION_TOUR_SEEN_KEY)).toBe("true");
		expect(hasSeenAnnotationTour()).toBe(true);
	});
});

describe("AnnotationTour", () => {
	it("renders nothing while closed", () => {
		render(<AnnotationTour open={false} onClose={() => {}} />);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("walks the three steps in order and finishes on Get started", () => {
		const onClose = vi.fn();
		render(<AnnotationTour open onClose={onClose} />);

		expect(screen.getByRole("dialog", { name: "Pick a structure" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /next/i }));

		expect(screen.getByRole("dialog", { name: "Create a mask" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /next/i }));

		expect(screen.getByRole("dialog", { name: "Refine the mask" })).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /get started/i }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("goes back a step", () => {
		render(<AnnotationTour open onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /next/i }));
		fireEvent.click(screen.getByRole("button", { name: /back/i }));
		expect(screen.getByRole("dialog", { name: "Pick a structure" })).toBeInTheDocument();
	});

	it("closes on Skip and on Escape", () => {
		const skip = vi.fn();
		const { unmount } = render(<AnnotationTour open onClose={skip} />);
		fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
		expect(skip).toHaveBeenCalledTimes(1);
		unmount();

		const escape = vi.fn();
		render(<AnnotationTour open onClose={escape} />);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(escape).toHaveBeenCalledTimes(1);
	});

	it("puts focus on the primary action", () => {
		render(<AnnotationTour open onClose={() => {}} />);
		expect(screen.getByRole("button", { name: /next/i })).toHaveFocus();
	});

	it("keeps the tour copy to the three requested steps", () => {
		expect(ANNOTATION_TOUR_STEPS.map((step) => step.title)).toEqual([
			"Pick a structure",
			"Create a mask",
			"Refine the mask",
		]);
	});
});
