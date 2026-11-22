import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AssignmentNotice from "../components/AssignmentNotice";
import type { Assignment } from "../helpers/assignments";
import { assignment } from "./assignmentsFakeServer";

const Where = () => <output aria-label="route">{useLocation().pathname}</output>;

function Host({ assignments, canWelcome = true, userId = "u1" }: { assignments: Assignment[] | null; canWelcome?: boolean; userId?: string }) {
	return (
		<>
			<Where />
			<AssignmentNotice userId={userId} assignments={assignments} canWelcome={canWelcome} />
		</>
	);
}

const mount = (assignments: Assignment[] | null, path = "/dashboard", extra: { canWelcome?: boolean; userId?: string } = {}) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes><Route path="*" element={<Host assignments={assignments} {...extra} />} /></Routes>
		</MemoryRouter>,
	);

beforeEach(() => localStorage.clear());

describe("the notice when cases are handed to someone", () => {
	it("tells them what they were given, and opens the Assignments page", async () => {
		mount([assignment({ note: "Portal phase first", due_at: "2099-03-01T00:00:00Z" })]);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("You have 6 cases to annotate");
		expect(dialog).toHaveTextContent("Veins and arteries");
		expect(dialog).toHaveTextContent("Cases 55 to 60, 6 to do");
		expect(dialog).toHaveTextContent("Portal phase first");
		expect(screen.getByRole("button", { name: "Open my projects" })).toHaveFocus();
		await userEvent.click(screen.getByRole("button", { name: "Open my projects" }));
		expect(screen.getByLabelText("route")).toHaveTextContent("/assignment");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("appears once: dismissing it (any way) means it does not come back on the next visit", async () => {
		const list = [assignment()];
		const first = mount(list);
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		first.unmount();
		mount(list);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("closes with Escape and remembers that too", async () => {
		const list = [assignment()];
		const first = mount(list);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		first.unmount();
		mount(list);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("comes back for a new hand-out, listing only what is new", async () => {
		const old = assignment({ id: "old", task: "Veins" });
		const first = mount([old]);
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		first.unmount();
		mount([old, assignment({ id: "new", task: "Ducts", start: 100, end: 104, total: 5, todo: 5 })]);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("You have 5 cases to annotate");
		expect(dialog).toHaveTextContent("Ducts");
		expect(dialog).not.toHaveTextContent("Veins");
	});

	it("is remembered per account, not per browser", async () => {
		const list = [assignment()];
		const first = mount(list, "/dashboard", { userId: "u1" });
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		first.unmount();
		mount(list, "/dashboard", { userId: "u2" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("does not interrupt on the Assignments page, and does not show for finished work or while loading", () => {
		mount([assignment()], "/assignment");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		mount([assignment({ id: "done", todo: 0, done: 6 })]);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		mount(null);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("says someone is now an annotator when they have no cases yet, once, and only if welcoming is allowed", async () => {
		const first = mount([]);
		expect(screen.getByRole("dialog")).toHaveTextContent("You are now an annotator");
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		first.unmount();
		mount([]);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		localStorage.clear();
		mount([], "/dashboard", { canWelcome: false });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("still works when the browser will not store anything", async () => {
		const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
		mount([assignment()]);
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		set.mockRestore();
		get.mockRestore();
	});

	it("handles damaged stored data", () => {
		localStorage.setItem("bodymaps.assignments.seen.u1", "{not json");
		mount([assignment()]);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
