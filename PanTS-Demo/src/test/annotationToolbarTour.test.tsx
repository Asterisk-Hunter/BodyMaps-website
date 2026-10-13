import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AnnotationToolbar from "../components/viewer/AnnotationToolbar";

beforeEach(() => {
	window.localStorage.clear();
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 })));
});

afterEach(() => vi.unstubAllGlobals());

function renderRibbon(onToolChange = vi.fn(), open = true) {
	return render(
		<AnnotationToolbar
			open={open}
			hasSegments
			hasActiveTarget
			activeTool={null}
			onToolChange={onToolChange}
			diameterMm={5}
			onDiameterChange={vi.fn()}
			scissorsOptions={{ operation: "eraseInside" }}
			onScissorsOptionsChange={vi.fn()}
			scissorsPointCount={0}
			onScissorsCancel={vi.fn()}
			targetKey={1}
			renderFlyout={() => null}
		/>,
	);
}

describe("annotation toolbar tour", () => {
	it("keeps a closed ribbon and its tour out of navigation", () => {
		renderRibbon(vi.fn(), false);
		expect(document.querySelector(".atb-shell")).toHaveAttribute("inert");
		expect(screen.queryByRole("dialog", { name: "Pick a class" })).toBeNull();
	});

	it("offers a first-run tour, remembers dismissal, and returns focus to its trigger", () => {
		const first = renderRibbon();
		expect(screen.getByRole("dialog", { name: "Open the class panel" })).toBeInTheDocument();
		const tourButton = screen.getByRole("button", { name: "Close annotation tour" });
		expect(tourButton).toHaveAttribute("aria-expanded", "true");
		expect(tourButton).not.toHaveAttribute("aria-pressed");
		fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
		expect(window.localStorage.getItem("annotation_onboarded")).toBe("true");
		expect(screen.getByRole("button", { name: "Show annotation tour" })).toHaveFocus();
		first.unmount();
		renderRibbon();
		expect(screen.queryByRole("dialog", { name: "Pick a class" })).toBeNull();
	});

	it("replays all four steps without selecting or running a tool", () => {
		window.localStorage.setItem("annotation_onboarded", "true");
		const onToolChange = vi.fn();
		renderRibbon(onToolChange);
		fireEvent.click(screen.getByRole("button", { name: "Show annotation tour" }));
		for (let step = 1; step <= 3; step++) {
			expect(screen.getByText(`Step ${step} of 4`)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByText("Step 4 of 4")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Get started" }));
		expect(screen.queryByRole("button", { name: "Skip tour" })).toBeNull();
		expect(onToolChange).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Show annotation tour" })).toHaveFocus();
	});

	it("Escape dismisses the tour only while focus is inside its card", async () => {
		const user = userEvent.setup();
		renderRibbon();
		expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Pick a class" })).toBeNull();
		expect(screen.getByRole("button", { name: "Show annotation tour" })).toHaveFocus();
	});
});
