import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ConfirmBar } from "../components/viewer/ConfirmBar";

describe("ConfirmBar", () => {
	it("shows only Apply and Cancel while keeping pointer and Enter actions", () => {
		const onApply = vi.fn();
		const onCancel = vi.fn();
		render(
			<ConfirmBar
				left={20}
				top={20}
				width={80}
				height={60}
				onApply={onApply}
				onCancel={onCancel}
			/>,
		);

		const apply = screen.getByRole("button", { name: "Apply" });
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(screen.getAllByRole("button")).toHaveLength(2);
		expect(screen.queryByText(/80 × 60 vox/)).toBeNull();
		expect(screen.queryByText(/P\/B\/L\/S/)).toBeNull();

		fireEvent.pointerDown(apply);
		fireEvent.pointerDown(cancel);
		fireEvent.keyDown(window, { key: "Enter" });
		expect(onApply).toHaveBeenCalledTimes(2);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("uses the focused button for keyboard activation and ignores typing in inputs", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		const onCancel = vi.fn();
		render(<><input aria-label="Structure name" /><ConfirmBar left={20} top={20} width={80} height={60} onApply={onApply} onCancel={onCancel} /></>);
		screen.getByRole("button", { name: "Cancel" }).focus();
		await user.keyboard("{Enter}");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onApply).not.toHaveBeenCalled();
		screen.getByRole("button", { name: "Apply" }).focus();
		await user.keyboard(" ");
		expect(onApply).toHaveBeenCalledOnce();
		screen.getByRole("textbox", { name: "Structure name" }).focus();
		await user.keyboard("{Enter}");
		expect(onApply).toHaveBeenCalledOnce();
	});
});
