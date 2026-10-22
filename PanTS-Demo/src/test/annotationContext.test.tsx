import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationContext from "../components/viewer/AnnotationContext";

describe("annotation help control", () => {
	it("shows only the accessible help icon and opens the tour", () => {
		const onToggleTour = vi.fn();
		const { container, rerender } = render(<AnnotationContext tourOpen={false} onToggleTour={onToggleTour} />);
		const button = screen.getByRole("button", { name: "Open annotation tour" });

		expect(button).toBeEnabled();
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(container).not.toHaveTextContent("Tour");
		expect(container).not.toHaveTextContent("Segmentation");
		fireEvent.click(button);
		expect(onToggleTour).toHaveBeenCalledOnce();

		rerender(<AnnotationContext tourOpen onToggleTour={onToggleTour} />);
		expect(screen.getByRole("button", { name: "Open annotation tour" })).toHaveAttribute("aria-expanded", "true");
	});
});
