import { act, fireEvent, render, screen } from "@testing-library/react";
import { IconSparkles, IconUsers } from "@tabler/icons-react";
import { describe, expect, it, vi } from "vitest";
import ViewerMoreMenu, { type ViewerMoreAction } from "../components/viewer/ViewerMoreMenu";

function actions(overrides: Partial<ViewerMoreAction>[] = []): ViewerMoreAction[] {
	const base: ViewerMoreAction[] = [
		{ id: "assistant", label: "AI assistant", icon: <IconSparkles size={16} />, onSelect: vi.fn(), active: true },
		{ id: "live-room", label: "Live room", icon: <IconUsers size={16} />, onSelect: vi.fn() },
		{ id: "shortcuts", label: "Keyboard shortcuts", icon: <span>⌘</span>, onSelect: vi.fn(), disabled: true },
	];
	return base.map((action, index) => ({ ...action, ...overrides[index] }));
}

describe("ViewerMoreMenu", () => {
	it("opens an accessible dialog with active and disabled action states", () => {
		render(<ViewerMoreMenu actions={actions()} />);
		const trigger = screen.getByRole("button", { name: "More viewer tools" });
		fireEvent.click(trigger);

		expect(screen.getByRole("dialog", { name: "More viewer tools" })).toBeInTheDocument();
		const assistantAction = screen.getByRole("button", { name: "AI assistant" });
		expect(assistantAction).toHaveAttribute("aria-pressed", "true");
		expect(assistantAction).toHaveFocus();
		expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeDisabled();
	});

	it("closes before running an action and does not restore focus to the trigger", () => {
		const onSelect = vi.fn(() => {
			expect(screen.queryByRole("dialog", { name: "More viewer tools" })).not.toBeInTheDocument();
		});
		render(<ViewerMoreMenu actions={actions([{ onSelect }])} />);
		const trigger = screen.getByRole("button", { name: "More viewer tools" });
		fireEvent.click(trigger);
		fireEvent.click(screen.getByRole("button", { name: "AI assistant" }));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(trigger).not.toHaveFocus();
	});

	it("closes on outside pointer input and Escape, restoring focus only for Escape", () => {
		render(<ViewerMoreMenu actions={actions()} />);
		const trigger = screen.getByRole("button", { name: "More viewer tools" });
		fireEvent.click(trigger);
		fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("dialog", { name: "More viewer tools" })).not.toBeInTheDocument();

		fireEvent.click(trigger);
		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => document.dispatchEvent(escape));
		expect(escape.defaultPrevented).toBe(true);
		expect(screen.queryByRole("dialog", { name: "More viewer tools" })).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
