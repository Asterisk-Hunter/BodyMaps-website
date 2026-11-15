import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import AssignmentBar from "../components/viewer/AssignmentBar";
import { AuthProvider } from "../contexts/authContext";
import { type Fake, assignment, makeFake } from "./assignmentsFakeServer";

let fake: Fake;

function Where() {
	return <div data-testid="where">{useLocation().pathname}</div>;
}

function Viewer({ caseId }: { caseId: string }) {
	return (
		<>
			<Where />
			<AssignmentBar caseId={caseId} />
		</>
	);
}

const open = (start = "/case/57") =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[start]}>
				<Routes>
					<Route path="/case/:caseId" element={<CaseHost />} />
					<Route path="*" element={<Where />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

function CaseHost() {
	const { caseId = "" } = useParams();
	return <Viewer caseId={caseId} />;
}

beforeEach(() => {
	localStorage.clear();
	fake = makeFake();
	fake.install();
});

describe("who sees the bar", () => {
	it("nobody who is not an annotator, and no request is made for them", async () => {
		fake = makeFake({ roles: [] });
		fake.install();
		fake.assignments = [assignment()];
		open();
		await screen.findByTestId("where");
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByTestId("assignment-bar")).not.toBeInTheDocument();
		expect(fake.calls).toEqual([]);
	});

	it("an annotator on a case outside their assignments sees nothing", async () => {
		fake.assignments = [assignment()];
		open("/case/61");
		await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 30));
		expect(screen.queryByTestId("assignment-bar")).not.toBeInTheDocument();
	});

	it("someone else's assignment never shows", async () => {
		fake.assignments = [assignment({ assignee: { id: "u2", name: "Rad Two", email: "r2@x.org" } })];
		open();
		await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 30));
		expect(screen.queryByTestId("assignment-bar")).not.toBeInTheDocument();
	});

	it.each(["57", "PanTS_00000057"])("finds the case from the id %s", async (id) => {
		fake.assignments = [assignment()];
		open(`/case/${id}`);
		expect(await screen.findByTestId("assignment-bar")).toHaveTextContent("Case 57 · your cases 55 to 60");
	});

	it("ignores ids that are not library cases", async () => {
		fake.assignments = [assignment({ start: 1, end: 99999, total: 99999 })];
		open("/case/not-a-case");
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByTestId("assignment-bar")).not.toBeInTheDocument();
	});
});

describe("working through cases", () => {
	it("shows the task, the progress and the state of this case", async () => {
		fake.assignments = [assignment({ done: 2, todo: 3, flagged: 1, marks: { "55": "done", "56": "done", "57": "flagged" } })];
		open();
		const bar = await screen.findByTestId("assignment-bar");
		expect(bar).toHaveTextContent("Veins and arteries");
		expect(bar).toHaveTextContent("2 of 6 done");
		expect(screen.getByTestId("assignment-status")).toHaveTextContent("Flagged for a second look");
	});

	it("Done, next case: saves the mark and opens the next case still to do", async () => {
		fake.assignments = [assignment({ marks: { "58": "done" }, done: 1, todo: 5 })];
		open("/case/57");
		await userEvent.click(await screen.findByRole("button", { name: "Done, next case" }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/case/59"));
		expect(fake.calls.find((c) => c.method === "PUT")).toMatchObject({ body: { status: "done" } });
		expect(fake.assignments[0].marks).toMatchObject({ "57": "done", "58": "done" });
		// On the new case the bar already knows 57 is done (it re-reads the server's list).
		expect(await screen.findByTestId("assignment-bar")).toHaveTextContent("Case 59 · your cases 55 to 60");
	});

	it("Flag, next case: marks it flagged and moves on", async () => {
		fake.assignments = [assignment()];
		open("/case/55");
		await userEvent.click(await screen.findByRole("button", { name: "Flag, next case" }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/case/56"));
		expect(fake.assignments[0].marks).toEqual({ "55": "flagged" });
	});

	it("after the last open case it says everything is marked and stays put", async () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ done: 5, todo: 1, marks })];
		open("/case/60");
		await userEvent.click(await screen.findByRole("button", { name: "Done, next case" }));
		expect(await screen.findByRole("status")).toHaveTextContent('All 6 cases in "Veins and arteries" are marked');
		expect(screen.getByTestId("where")).toHaveTextContent("/case/60");
		expect(screen.queryByRole("button", { name: "Done, next case" })).not.toBeInTheDocument();
	});

	it("wraps round to a case skipped earlier", async () => {
		fake.assignments = [assignment({ marks: { "56": "done", "57": "done", "58": "done", "59": "done" }, done: 4, todo: 2 })];
		open("/case/60");
		await userEvent.click(await screen.findByRole("button", { name: "Done, next case" }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/case/55"));
	});

	it("can take a mark back", async () => {
		fake.assignments = [assignment({ marks: { "57": "done" }, done: 1, todo: 5 })];
		open();
		await userEvent.click(await screen.findByRole("button", { name: "Mark as not done" }));
		await waitFor(() => expect(screen.getByTestId("assignment-status")).toHaveTextContent("Not marked yet"));
		expect(fake.assignments[0].marks).toEqual({});
		expect(screen.getByTestId("where")).toHaveTextContent("/case/57");
		expect(screen.queryByRole("button", { name: "Mark as not done" })).not.toBeInTheDocument();
	});

	it("offers to skip ahead without marking", async () => {
		fake.assignments = [assignment()];
		open("/case/57");
		const skip = await screen.findByRole("link", { name: "Skip to case 58" });
		expect(skip).toHaveAttribute("href", "/case/58");
		expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
	});

	it("saves once even if the button is clicked again while it is saving", async () => {
		fake.assignments = [assignment()];
		fake.delayMs = 40;
		open("/case/57");
		const button = await screen.findByRole("button", { name: "Done, next case" });
		await userEvent.dblClick(button);
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/case/58"));
		expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
	});

	it.each([[500, "Couldn't save that. Try again."], [401, "You are signed out. Sign in again to save."], [0, "Couldn't save that. Try again."]])(
		"on a %s the case is not lost: an error shows, nothing moves, and retry works", async (status, message) => {
			fake.assignments = [assignment()];
			open("/case/57");
			const button = await screen.findByRole("button", { name: "Done, next case" });
			fake.failNext.PUT = status;
			await userEvent.click(button);
			expect(await screen.findByRole("alert")).toHaveTextContent(message);
			expect(screen.getByTestId("where")).toHaveTextContent("/case/57");
			expect(fake.assignments[0].marks).toEqual({});
			expect(screen.getByRole("button", { name: "Done, next case" })).toBeEnabled();
			await userEvent.click(screen.getByRole("button", { name: "Done, next case" }));
			await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/case/58"));
			expect(fake.assignments[0].marks).toEqual({ "57": "done" });
		});

	it("lets them choose between assignments that share a case", async () => {
		fake.assignments = [assignment({ id: "a", task: "Veins" }), assignment({ id: "b", task: "Ducts" })];
		open();
		const picker = await screen.findByRole("combobox", { name: "Assignment" });
		await userEvent.selectOptions(picker, "b");
		await userEvent.click(screen.getByRole("button", { name: "Flag, next case" }));
		await waitFor(() => expect(fake.assignments.find((a) => a.id === "b")!.marks).toEqual({ "57": "flagged" }));
		expect(fake.assignments.find((a) => a.id === "a")!.marks).toEqual({});
	});
});
