import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import StructurePicker, { type StructurePickerProps } from "../components/viewer/StructurePicker";

function renderPicker(overrides: Partial<StructurePickerProps> = {}) {
	const props: StructurePickerProps = {
		structures: [
			{ id: 1, label: "Liver" },
			{ id: 2, label: "Spleen" },
			{ id: 3, label: "Left kidney" },
		],
		colors: { 1: "#e36f61", 2: "#65b59c", 3: "#82a8df" },
		activeStructureId: null,
		onSelectStructure: vi.fn(),
		...overrides,
	};
	return { ...render(<StructurePicker {...props} />), props };
}

describe("StructurePicker", () => {
	it("opens while empty, filters the unified list, and selects a result", async () => {
		const user = userEvent.setup();
		const { props } = renderPicker();
		await user.click(screen.getByRole("button", { name: "Select structure" }));
		const search = screen.getByRole("textbox", { name: "Search structures" });
		expect(search).toHaveFocus();
		await user.type(search, "kid");
		expect(screen.getByRole("button", { name: /left kidney/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^liver$/i })).toBeNull();
		await user.click(screen.getByRole("button", { name: /left kidney/i }));
		expect(props.onSelectStructure).toHaveBeenCalledWith(3);
		expect(screen.queryByRole("dialog", { name: "Choose a structure" })).toBeNull();
	});

	it("closes on Escape and outside pointer input", async () => {
		const user = userEvent.setup();
		const props: StructurePickerProps = {
			structures: [{ id: 1, label: "Liver" }, { id: 2, label: "Spleen" }],
			colors: {},
			activeStructureId: null,
			onSelectStructure: vi.fn(),
		};
		render(<><StructurePicker {...props} /><button type="button">Outside target</button></>);
		const trigger = screen.getByRole("button", { name: "Select structure" });
		await user.click(trigger);
		const search = screen.getByRole("textbox", { name: "Search structures" });
		await user.type(search, "kid");
		const parentShortcut = vi.fn();
		document.addEventListener("keydown", parentShortcut);
		await user.keyboard("{Escape}");
		document.removeEventListener("keydown", parentShortcut);
		expect(screen.queryByRole("dialog", { name: "Choose a structure" })).toBeNull();
		expect(trigger).toHaveFocus();
		expect(parentShortcut).not.toHaveBeenCalled();
		await user.click(trigger);
		expect((screen.getByRole("textbox", { name: "Search structures" }) as HTMLInputElement).value).toBe("");
		await user.type(screen.getByRole("textbox", { name: "Search structures" }), "spleen");
		await user.click(screen.getByRole("button", { name: "Outside target" }));
		expect(screen.queryByRole("dialog", { name: "Choose a structure" })).toBeNull();
		expect(screen.getByRole("button", { name: "Outside target" })).toHaveFocus();
	});

	it("uses ArrowDown, ArrowUp, and Enter from search to choose a result", async () => {
		const user = userEvent.setup();
		const onSelectStructure = vi.fn();
		renderPicker({ onSelectStructure });
		await user.click(screen.getByRole("button", { name: "Select structure" }));
		const search = screen.getByRole("textbox", { name: "Search structures" });
		await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
		expect(onSelectStructure).toHaveBeenCalledWith(1);
		expect(screen.queryByRole("dialog", { name: "Choose a structure" })).toBeNull();
	});

	it("clears the active structure when its selected row is chosen again", async () => {
		const user = userEvent.setup();
		const onSelectStructure = vi.fn();
		renderPicker({ activeStructureId: 1, onSelectStructure });
		await user.click(screen.getByRole("button", { name: /change structure, liver/i }));
		await user.click(screen.getByRole("button", { name: /^liver$/i }));
		expect(onSelectStructure).toHaveBeenCalledWith(null);
	});

	it("closes and disables the trigger when editing becomes unavailable", async () => {
		const user = userEvent.setup();
		const { rerender, props } = renderPicker();
		await user.click(screen.getByRole("button", { name: "Select structure" }));
		rerender(<StructurePicker {...props} disabled />);
		expect(screen.queryByRole("dialog", { name: "Choose a structure" })).toBeNull();
		expect(screen.getByRole("button", { name: "Select structure" })).toBeDisabled();
	});

	it("resets search and create state when toggled closed and reopened", async () => {
		const user = userEvent.setup();
		const onCreateStructure = vi.fn(() => ({ id: 9, label: "Aorta" }));
		renderPicker({ onCreateStructure });
		const trigger = screen.getByRole("button", { name: "Select structure" });
		await user.click(trigger);
		await user.type(screen.getByRole("textbox", { name: "Search structures" }), "kidney");
		await user.click(trigger);
		await user.click(trigger);
		expect((screen.getByRole("textbox", { name: "Search structures" }) as HTMLInputElement).value).toBe("");
		await user.click(screen.getByRole("button", { name: /create structure/i }));
		await user.type(screen.getByLabelText("New structure"), "Draft");
		await user.keyboard("{Escape}");
		await user.click(trigger);
		expect(screen.queryByLabelText("New structure")).toBeNull();
		expect((screen.getByRole("textbox", { name: "Search structures" }) as HTMLInputElement).value).toBe("");
	});

	it("validates a new name, then creates and selects the trimmed structure", async () => {
		const user = userEvent.setup();
		const onCreateStructure = vi.fn(() => ({ id: 9, label: "Aorta" }));
		const onSelectStructure = vi.fn();
		renderPicker({ onCreateStructure, onSelectStructure });
		await user.click(screen.getByRole("button", { name: "Select structure" }));
		await user.click(screen.getByRole("button", { name: /create structure/i }));
		await user.click(screen.getByRole("button", { name: "Create structure" }));
		expect(screen.getByRole("alert").textContent).toMatch(/enter a structure name/i);
		const name = screen.getByLabelText("New structure");
		await user.type(name, "  liver ");
		await user.click(screen.getByRole("button", { name: "Create structure" }));
		expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
		await user.clear(name);
		await user.type(name, "  Aorta  ");
		await user.click(screen.getByRole("button", { name: "Create structure" }));
		expect(onCreateStructure).toHaveBeenCalledWith("Aorta", "#38bdf8");
		expect(onSelectStructure).toHaveBeenCalledWith(9);
	});

	it("keeps management scoped to supplied custom structure ids and exposes isolate", async () => {
		const user = userEvent.setup();
		const onRenameStructure = vi.fn(() => true);
		const onColorChange = vi.fn();
		const onDeleteStructure = vi.fn();
		const onShowOnlyTargetMaskChange = vi.fn();
		const onToggleVisibility = vi.fn();
		const { rerender, props } = renderPicker({
			activeStructureId: 1,
			onRenameStructure,
			onColorChange,
			onDeleteStructure,
			managedStructureIds: [9],
			onShowOnlyTargetMaskChange,
			onToggleVisibility,
			visibility: { 9: false },
		});
		await user.click(screen.getByRole("button", { name: /change structure, liver/i }));
		expect(screen.queryByRole("button", { name: /manage structure/i })).toBeNull();
		await user.click(screen.getByRole("checkbox", { name: /isolate structure/i }));
		expect(onShowOnlyTargetMaskChange).toHaveBeenCalledWith(true);
		await user.keyboard("{Escape}");
		rerender(<StructurePicker {...props} activeStructureId={9} structures={[...props.structures, { id: 9, label: "Custom" }]} />);
		await user.click(screen.getByRole("button", { name: /change structure, custom/i }));
		await user.click(screen.getByRole("button", { name: /manage structure/i }));
		const showStructure = screen.getByRole("checkbox", { name: "Show structure" });
		expect(showStructure).not.toBeChecked();
		await user.click(showStructure);
		expect(onToggleVisibility).toHaveBeenCalledWith(9);
		const rename = screen.getByRole("textbox", { name: "Rename structure" });
		await user.clear(rename);
		await user.type(rename, "Renamed vessel");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onRenameStructure).toHaveBeenCalledWith(9, "Renamed vessel");
		const color = screen.getByLabelText("Structure color");
		fireEvent.change(color, { target: { value: "#ff8800" } });
		expect(onColorChange).toHaveBeenCalledWith(9, "#ff8800");
		await user.click(screen.getByRole("button", { name: /delete structure/i }));
		expect(screen.getByText("Delete this structure?")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(screen.getByRole("button", { name: /delete structure/i }));
		await user.click(screen.getByRole("button", { name: "Delete", exact: true }));
		expect(onDeleteStructure).toHaveBeenCalledWith(9);
		expect(props.onSelectStructure).toHaveBeenCalledWith(null);
	});
});
