/**
 * A tool's settings flyout eases out when it closes instead of vanishing:
 * the very commit that closes it keeps the panel on screen, marked closing,
 * and it is only hidden (or unmounted) once the fade has had its time. A
 * close that also takes the content away fades a static copy of what was
 * showing, not an empty box or the next tool's controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FlyoutPanel } from "../components/viewer/FlyoutPrimitives";
import AnnotationToolbar, { type PrimaryEditTool } from "../components/viewer/AnnotationToolbar";
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

// Holds the active tool like VisualizationPage does.
function StatefulRibbon() {
	const [tool, setTool] = useState<PrimaryEditTool>(null);
	return (
		<AnnotationToolbar
			open
			hasSegments
			hasActiveTarget
			activeTool={tool}
			onToolChange={setTool}
			diameterMm={5}
			onDiameterChange={vi.fn()}
			scissorsOptions={{ operation: "eraseInside" }}
			onScissorsOptionsChange={vi.fn()}
			scissorsPointCount={0}
			onScissorsCancel={vi.fn()}
			targetKey={1}
			renderFlyout={(active, _onApplied, onCloseSettings) => active === "levelTracing" ? (
				<LevelTracingFlyout
					operation="fillInside"
					onOperationChange={vi.fn()}
					toleranceHu={50}
					onToleranceChange={vi.fn()}
					onCloseSettings={onCloseSettings}
				/>
			) : (
				<>
					<button type="button" id="grow-option">Grow</button>
					<button type="button">Shrink</button>
				</>
			)}
			onUndo={vi.fn()}
			onRedo={vi.fn()}
			onSave={vi.fn()}
			canUndo
			canRedo
			isSaving={false}
			hasTargetSegmentation
			structures={[{ id: 1, label: "Liver" }]}
			activeStructureId={1}
			onSelectStructure={vi.fn()}
		/>
	);
}

describe("settings flyout closing with its tool", () => {
	const pickMode = (tool: string, settings: string, mode: string, beat: number) => {
		render(<StatefulRibbon />);
		fireEvent.click(screen.getByRole("button", { name: tool }));
		fireEvent.click(screen.getByRole("button", { name: settings }));
		fireEvent.click(screen.getByRole("button", { name: mode }));
		advance(beat - 40);
		fireEvent.click(screen.getByRole("button", { name: "Brush" }));
		fireEvent.mouseDown(screen.getByRole("button", { name: "Brush settings" }));
		fireEvent.click(screen.getByRole("button", { name: "Brush settings" }));
		advance(beat + 40);
		expect(panel()).not.toHaveClass("is-closing");
		expect(panel()).toHaveTextContent("Brush Size");
	};

	it("does not let a delayed Scissors mode pick close Brush settings", () => {
		pickMode("Scissors", "Scissors settings", "Erase outside", 320);
	});

});

// Mode choices stay visible briefly, then close their own settings.
describe.each([
	["Scissors", "Erase outside", 320],
])("%s mode pick's delayed close", (tool, mode, beat) => {
	const openAndPick = () => {
		render(<StatefulRibbon />);
		fireEvent.click(screen.getByRole("button", { name: tool }));
		fireEvent.click(screen.getByRole("button", { name: `${tool} settings` }));
		fireEvent.click(screen.getByRole("button", { name: mode }));
	};

	it("closes only after the selected mode has been visible for its beat", () => {
		openAndPick();
		advance(beat - 1);
		expect(panel()).not.toHaveClass("is-closing");
		advance(1);
		expect(panel()).toHaveClass("is-closing");
	});

	it("restarts the beat after a second mode pick", () => {
		openAndPick();
		advance(beat - 100);
		fireEvent.click(screen.getByRole("button", { name: mode }));
		advance(100);
		expect(panel()).not.toHaveClass("is-closing");
		advance(beat - 100);
		expect(panel()).toHaveClass("is-closing");
	});
});

it("closes Level Tracing settings after a mode is picked", () => {
	const onCloseSettings = vi.fn();
	render(<LevelTracingFlyout operation="fillInside" onOperationChange={vi.fn()} toleranceHu={50} onToleranceChange={vi.fn()} onCloseSettings={onCloseSettings} />);
	fireEvent.click(screen.getByRole("button", { name: "Fill outside" }));
	advance(259);
	expect(onCloseSettings).not.toHaveBeenCalled();
	advance(1);
	expect(onCloseSettings).toHaveBeenCalledTimes(1);
});
