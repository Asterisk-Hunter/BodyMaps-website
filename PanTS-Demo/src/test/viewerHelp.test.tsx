import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasSeenViewerTips,
	markViewerTipsSeen,
	ShortcutSheet,
	VIEWER_TIPS,
	VIEWER_TIPS_SEEN_KEY,
	ViewerTips,
} from "../components/viewer/ViewerHelp";
import { SHORTCUT_GROUPS } from "../helpers/viewer/shortcuts";

beforeEach(() => {
	window.localStorage.clear();
});

describe("viewer tips flag", () => {
	it("starts unseen, then stays seen once dismissed", () => {
		expect(hasSeenViewerTips()).toBe(false);
		markViewerTipsSeen();
		expect(window.localStorage.getItem(VIEWER_TIPS_SEEN_KEY)).toBe("true");
		expect(hasSeenViewerTips()).toBe(true);
	});
});

describe("ViewerTips", () => {
	it("renders nothing while closed", () => {
		render(<ViewerTips open={false} onDismiss={() => {}} onShowShortcuts={() => {}} />);
		expect(screen.queryByLabelText("Getting started")).not.toBeInTheDocument();
	});

	it("lists the tips and dismisses on the confirm button", () => {
		const onDismiss = vi.fn();
		render(<ViewerTips open onDismiss={onDismiss} onShowShortcuts={() => {}} />);
		expect(screen.getByLabelText("Getting started")).toBeInTheDocument();
		for (const tip of VIEWER_TIPS) {
			expect(screen.getByText(tip)).toBeInTheDocument();
		}
		fireEvent.click(screen.getByRole("button", { name: /got it/i }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("dismisses on Escape — the strip is never a dead end", () => {
		const onDismiss = vi.fn();
		render(<ViewerTips open onDismiss={onDismiss} onShowShortcuts={() => {}} />);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("hands off to the shortcut sheet", () => {
		const onShowShortcuts = vi.fn();
		render(<ViewerTips open onDismiss={() => {}} onShowShortcuts={onShowShortcuts} />);
		fireEvent.click(screen.getByRole("button", { name: /all shortcuts/i }));
		expect(onShowShortcuts).toHaveBeenCalledTimes(1);
	});
});

describe("ShortcutSheet", () => {
	it("renders nothing while closed", () => {
		render(<ShortcutSheet open={false} onClose={() => {}} />);
		expect(screen.queryByLabelText("Keyboard shortcuts")).not.toBeInTheDocument();
	});

	it("lists every binding the hook actually has, grouped", () => {
		render(<ShortcutSheet open onClose={() => {}} />);
		expect(screen.getByLabelText("Keyboard shortcuts")).toBeInTheDocument();
		for (const group of SHORTCUT_GROUPS) {
			expect(screen.getByText(group.title)).toBeInTheDocument();
			for (const item of group.items) {
				expect(screen.getByText(item.desc)).toBeInTheDocument();
			}
		}
	});

	it("closes on Escape, on the ✕, and on a backdrop click", () => {
		const onClose = vi.fn();
		render(<ShortcutSheet open onClose={onClose} />);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /close shortcuts/i }));
		expect(onClose).toHaveBeenCalledTimes(2);

		const scrim = screen.getByLabelText("Keyboard shortcuts").parentElement!;
		fireEvent.mouseDown(scrim);
		expect(onClose).toHaveBeenCalledTimes(3);
	});

	it("does not close when the click lands on the sheet itself", () => {
		const onClose = vi.fn();
		render(<ShortcutSheet open onClose={onClose} />);
		fireEvent.mouseDown(screen.getByLabelText("Keyboard shortcuts"));
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("shortcut data", () => {
	it("documents the key that opens the sheet", () => {
		const allKeys = SHORTCUT_GROUPS.flatMap((group) => group.items.flatMap((item) => item.keys));
		expect(allKeys).toContain("?");
	});

	it("gives every row at least one key chip and a description", () => {
		for (const group of SHORTCUT_GROUPS) {
			expect(group.title.length).toBeGreaterThan(0);
			for (const item of group.items) {
				expect(item.keys.length).toBeGreaterThan(0);
				expect(item.keys.every((key) => key.length > 0)).toBe(true);
				expect(item.desc.length).toBeGreaterThan(0);
			}
		}
	});
});
