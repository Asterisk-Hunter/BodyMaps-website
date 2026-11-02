import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutSheet } from "../components/viewer/ViewerHelp";
import { SHORTCUT_GROUPS } from "../helpers/viewer/shortcuts";

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

	it("closes on Escape, on ?, on the ✕, and on a backdrop click", () => {
		const onClose = vi.fn();
		render(<ShortcutSheet open onClose={onClose} />);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: "?" });
		expect(onClose).toHaveBeenCalledTimes(2);

		fireEvent.click(screen.getByRole("button", { name: /close shortcuts/i }));
		expect(onClose).toHaveBeenCalledTimes(3);

		const scrim = screen.getByLabelText("Keyboard shortcuts").parentElement!;
		fireEvent.mouseDown(scrim);
		expect(onClose).toHaveBeenCalledTimes(4);
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

	it("keeps brush resizing out of the undo group and with the editing shortcuts", () => {
		const undo = SHORTCUT_GROUPS.find((group) => group.title === "Undo");
		const editing = SHORTCUT_GROUPS.find((group) => group.title.startsWith("Editing"));
		expect(undo?.items.some((item) => item.desc.includes("brush"))).toBe(false);
		expect(editing?.items.some((item) => item.desc.includes("brush"))).toBe(true);
	});
});
