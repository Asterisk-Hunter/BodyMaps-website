/**
 * A tool's settings flyout eases out when it closes instead of vanishing:
 * the very commit that closes it keeps the panel on screen, marked closing,
 * and it is only hidden (or unmounted) once the fade has had its time. A
 * close that also takes the content away fades a static copy of what was
 * showing, not an empty box or the next tool's controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FlyoutPanel } from "../components/viewer/FlyoutPrimitives";
import LevelTracingFlyout from "../components/segmentation/LevelTracingFlyout";

const realMatchMedia = window.matchMedia;

function setReducedMotion(on: boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: on && /prefers-reduced-motion:\s*reduce/.test(query),
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	window.localStorage.setItem("annotation_onboarded", "true");
	// The ribbon asks the model server which prompt tools it can serve.
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 })));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	window.matchMedia = realMatchMedia;
});

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const panel = () => document.querySelector<HTMLElement>(".atb-pop__panel");

function Harness({ open, keepMounted, children }: { open: boolean; keepMounted: boolean; children: ReactNode }) {
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	return (
		<>
			<button type="button" ref={anchorRef}>Tool</button>
			<FlyoutPanel open={open} anchorRef={anchorRef} panelRef={panelRef} keepMounted={keepMounted}>
				{children}
			</FlyoutPanel>
		</>
	);
}

describe.each([
	{ keepMounted: true, gone: () => expect(panel()).toHaveStyle({ display: "none" }) },
	{ keepMounted: false, gone: () => expect(panel()).toBeNull() },
])("settings flyout closing (keepMounted: $keepMounted)", ({ keepMounted, gone }) => {
	const openThenClose = () => {
		const content = <button type="button">Grow</button>;
		const { rerender } = render(<Harness open={false} keepMounted={keepMounted}>{content}</Harness>);
		rerender(<Harness open keepMounted={keepMounted}>{content}</Harness>);
		expect(panel()).not.toHaveClass("is-closing");
		rerender(<Harness open={false} keepMounted={keepMounted}>{content}</Harness>);
		return panel();
	};

	it("keeps the panel on screen, marked closing, in the commit that closes it", () => {
		const closing = openThenClose();
		expect(closing).toHaveClass("is-closing");
		expect(closing).not.toHaveStyle({ display: "none" });
		expect(closing).toHaveTextContent("Grow");
	});

	it("hides it once the fade has played", () => {
		openThenClose();
		advance(159);
		expect(panel()).toHaveClass("is-closing");
		expect(panel()).not.toHaveStyle({ display: "none" });
		advance(1);
		gone();
	});

	it("hides it at once under reduced motion, with no fade to wait for", () => {
		setReducedMotion(true);
		openThenClose();
		advance(0);
		gone();
	});
});

// Scissors is intentionally absent from the toolbar while its implementation
// is retained; verify the shared settings fade with Level Tracing below.
it("closes Level Tracing settings after a mode is picked", () => {
	const onCloseSettings = vi.fn();
	render(<LevelTracingFlyout operation="fillInside" onOperationChange={vi.fn()} toleranceHu={50} onToleranceChange={vi.fn()} onCloseSettings={onCloseSettings} />);
	fireEvent.click(screen.getByRole("button", { name: "Fill outside" }));
	advance(259);
	expect(onCloseSettings).not.toHaveBeenCalled();
	advance(1);
	expect(onCloseSettings).toHaveBeenCalledTimes(1);
});
