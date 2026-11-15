import { act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDockOffset } from "../helpers/viewer/useDockOffset";

// The viewer docks panels "just under the toolbar" with position: fixed from the top of the window, so the variable
// must hold where the toolbar ENDS. These tests move the toolbar around (something appears above it, something above it
// resizes) and check the variable follows.

class FakeResizeObserver {
	static all: FakeResizeObserver[] = [];
	targets = new Set<Element>();
	/** True once it is watching nothing (the hook disconnects and re-observes when the layout changes). */
	get disconnected() { return this.targets.size === 0; }
	constructor(private callback: () => void) {
		FakeResizeObserver.all.push(this);
	}
	observe(el: Element) { this.targets.add(el); }
	disconnect() { this.targets.clear(); }
	fire() { this.callback(); }
}

let bottom = 56;
const readVar = () => document.documentElement.style.getPropertyValue("--vp-topbar-h");

function Page({ withBar, resetKey = "a" }: { withBar: boolean; resetKey?: string }) {
	const toolbar = useRef<HTMLDivElement>(null);
	useDockOffset(toolbar, resetKey);
	return (
		<div data-testid="page">
			{withBar && <div data-testid="bar" />}
			<div ref={(el) => {
				toolbar.current = el;
				if (el) el.getBoundingClientRect = () => ({ bottom, height: 56, top: bottom - 56 } as DOMRect);
			}} data-testid="toolbar" />
		</div>
	);
}

beforeEach(() => {
	FakeResizeObserver.all = [];
	bottom = 56;
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	document.documentElement.style.removeProperty("--vp-topbar-h");
});
afterEach(() => vi.unstubAllGlobals());

describe("--vp-topbar-h", () => {
	it("is where the toolbar ends, not its height, when something sits above it", () => {
		bottom = 56 + 62; // a 62px bar above a 56px toolbar
		render(<Page withBar />);
		expect(readVar()).toBe("118px");
	});

	it("is just the toolbar's height when nothing is above it", () => {
		render(<Page withBar={false} />);
		expect(readVar()).toBe("56px");
	});

	it("follows the toolbar when a bar appears above it after the page has loaded", async () => {
		const view = render(<Page withBar={false} />);
		expect(readVar()).toBe("56px");
		bottom = 56 + 62; // the bar arrives later and pushes the toolbar down without changing the toolbar's own size
		view.rerender(<Page withBar />);
		await waitFor(() => expect(readVar()).toBe("118px"));
	});

	it("follows the toolbar when the bar goes away again", async () => {
		const view = render(<Page withBar />);
		bottom = 56;
		view.rerender(<Page withBar={false} />);
		await waitFor(() => expect(readVar()).toBe("56px"));
	});

	it("follows a bar above the toolbar growing taller, for example when it wraps on a narrow screen", () => {
		render(<Page withBar />);
		const watched = FakeResizeObserver.all.find((o) => !o.disconnected)!;
		expect([...watched.targets].some((t) => (t as HTMLElement).dataset.testid === "bar")).toBe(true);
		bottom = 56 + 110;
		act(() => watched.fire());
		expect(readVar()).toBe("166px");
	});

	it("follows the toolbar itself resizing", () => {
		render(<Page withBar={false} />);
		const watched = FakeResizeObserver.all.find((o) => !o.disconnected)!;
		expect([...watched.targets].some((t) => (t as HTMLElement).dataset.testid === "toolbar")).toBe(true);
		bottom = 100;
		act(() => watched.fire());
		expect(readVar()).toBe("100px");
	});

	it("re-measures when the window is resized", () => {
		render(<Page withBar />);
		bottom = 90;
		act(() => { window.dispatchEvent(new Event("resize")); });
		expect(readVar()).toBe("90px");
	});

	it("stops watching when the page goes away", () => {
		const view = render(<Page withBar />);
		view.unmount();
		expect(FakeResizeObserver.all.every((o) => o.disconnected)).toBe(true);
		bottom = 500;
		window.dispatchEvent(new Event("resize"));
		expect(readVar()).not.toBe("500px");
	});

	it("does nothing, and does not fail, when there is no toolbar yet", () => {
		function Empty() {
			const ref = useRef<HTMLDivElement>(null);
			useDockOffset(ref);
			return <p>no toolbar</p>;
		}
		expect(() => render(<Empty />)).not.toThrow();
		expect(readVar()).toBe("");
	});
});
