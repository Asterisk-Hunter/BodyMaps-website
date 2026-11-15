import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCancerVerseCountCache } from "../helpers/caseNumbering";
import { AuthProvider } from "../contexts/authContext";
import AssignmentsSettings from "../routes/Settings/AssignmentsSettings";
import { type Fake, assignment, makeFake } from "./assignmentsFakeServer";

let fake: Fake;

const open = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AssignmentsSettings />
			</MemoryRouter>
		</AuthProvider>,
	);

const manager = () => makeFake({ id: "m1", email: "m@x.org", name: "Manager", roles: ["annotation_manager", "annotator"] });

beforeEach(() => {
	localStorage.clear();
	resetCancerVerseCountCache();
});

describe("an annotator's page", () => {
	beforeEach(() => {
		fake = makeFake();
		fake.install();
	});

	it("says so plainly when nothing has been handed out", async () => {
		open();
		expect(await screen.findByTestId("no-assignments")).toHaveTextContent("Nothing has been handed to you yet");
		expect(screen.queryByTestId("hand-out")).not.toBeInTheDocument();
		expect(screen.queryByTestId("everyone")).not.toBeInTheDocument();
	});

	it("shows each assignment with its task, range, note, due date and progress, and a Start button", async () => {
		fake.assignments = [assignment({ note: "Portal phase first", due_at: "2099-01-01T00:00:00Z" })];
		open();
		const card = await screen.findByTestId("my-assignment");
		expect(within(card).getByText("Veins and arteries")).toBeInTheDocument();
		expect(within(card).getByText("Cases 55 to 60")).toBeInTheDocument();
		expect(within(card).getByText("Portal phase first")).toBeInTheDocument();
		expect(within(card).getByText(/^Due /)).toBeInTheDocument();
		expect(within(card).getByText("0 of 6 done")).toBeInTheDocument();
		expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
		expect(within(card).getByRole("link", { name: "Start with case 55" })).toHaveAttribute("href", "/case/55");
	});

	it("continues at the next case still to do, and tells them when everything is marked", async () => {
		fake.assignments = [assignment({ done: 2, flagged: 1, todo: 3, marks: { "55": "done", "56": "flagged", "57": "done" } })];
		open();
		const card = await screen.findByTestId("my-assignment");
		expect(within(card).getByRole("link", { name: "Continue with case 58" })).toHaveAttribute("href", "/case/58");
		expect(within(card).getByText("2 of 6 done, 1 flagged")).toBeInTheDocument();
	});

	it("celebrates a finished assignment instead of offering a link to nowhere", async () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ done: 6, todo: 0, marks })];
		open();
		expect(await screen.findByText(/All 6 cases are marked/)).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /with case/ })).not.toBeInTheDocument();
	});

	it("lists every case as a link coloured by its state, and pages long ranges", async () => {
		fake.assignments = [assignment({ start: 1, end: 450, total: 450, todo: 449, done: 1, marks: { "2": "done" } })];
		open();
		await userEvent.click(await screen.findByRole("button", { name: "Show all cases" }));
		const list = screen.getByRole("list", { name: "Cases in this assignment" });
		expect(within(list).getAllByRole("link")).toHaveLength(200);
		expect(within(list).getByRole("link", { name: "2" })).toHaveClass("asg-chip--done");
		expect(within(list).getByRole("link", { name: "1" })).toHaveClass("asg-chip--todo");
		await userEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(within(list).getAllByRole("link")).toHaveLength(400);
		await userEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(within(list).getAllByRole("link")).toHaveLength(450);
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("only ever shows their own assignments", async () => {
		fake.assignments = [assignment({ id: "mine" }), assignment({ id: "theirs", task: "Lymph nodes", assignee: { id: "u2", name: "Rad Two", email: "r2@x.org" } })];
		open();
		await screen.findByTestId("my-assignment");
		expect(screen.getAllByTestId("my-assignment")).toHaveLength(1);
		expect(screen.queryByText("Lymph nodes")).not.toBeInTheDocument();
	});

	it("shows a retry when the server cannot be reached, and recovers", async () => {
		fake.failNext.GET = 0;
		open();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't reach the server");
		fake.assignments = [assignment()];
		await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(await screen.findByTestId("my-assignment")).toBeInTheDocument();
	});
});

describe("someone who is not an annotator", () => {
	it("is told how to get access and the page makes no assignment calls", async () => {
		fake = makeFake({ roles: [] });
		fake.install();
		open();
		expect(await screen.findByTestId("assignments-none")).toHaveTextContent("Ask an annotation manager");
		expect(fake.calls).toEqual([]);
	});
});

describe("a manager's page", () => {
	beforeEach(() => {
		fake = manager();
		fake.install();
	});

	const fill = async (cases: string, task: string) => {
		const form = await screen.findByTestId("hand-out");
		await userEvent.type(within(form).getByLabelText("Cases"), cases);
		await userEvent.type(within(form).getByLabelText("What to annotate"), task);
		return form;
	};

	it("refuses cases past the end of the library, naming the last one, and accepts the last one", async () => {
		fake.library = { cancerverse: 24422, abdomenatlas: 9262 };
		open();
		const form = await fill("43000 to 50000", "Veins");
		await userEvent.click(await within(form).findByRole("checkbox", { name: /Rad One/ }));
		await waitFor(() => expect(within(form).getByText("The library has cases 1 to 43585. Choose cases up to 43585.")).toBeInTheDocument());
		expect(within(form).getByRole("button", { name: "Hand out cases" })).toBeDisabled();
		await userEvent.clear(within(form).getByLabelText("Cases"));
		await userEvent.type(within(form).getByLabelText("Cases"), "43000 to 43585");
		expect(within(form).getByRole("button", { name: "Hand out cases" })).toBeEnabled();
	});

	it("does not block a range when the library size cannot be read", async () => {
		open();
		const form = await fill("5 to 60000", "Veins");
		await userEvent.click(await within(form).findByRole("checkbox", { name: /Rad One/ }));
		expect(within(form).getByRole("button", { name: "Hand out cases" })).toBeEnabled();
	});

	it("explains what is missing before anything is sent", async () => {
		open();
		const form = await screen.findByTestId("hand-out");
		const submit = within(form).getByRole("button", { name: "Hand out cases" });
		expect(submit).toBeDisabled();
		await userEvent.type(within(form).getByLabelText("Cases"), "95 to 55");
		expect(within(form).getByText(/Write the cases as two numbers/)).toBeInTheDocument();
		await userEvent.clear(within(form).getByLabelText("Cases"));
		await userEvent.type(within(form).getByLabelText("Cases"), "55 to 95");
		expect(within(form).getByText(/Say what to annotate/)).toBeInTheDocument();
		await userEvent.type(within(form).getByLabelText("What to annotate"), "Veins");
		expect(within(form).getByText(/Choose at least one person/)).toBeInTheDocument();
		expect(submit).toBeDisabled();
		expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);
	});

	it("hands a range to one person and then shows it under Everyone's progress", async () => {
		open();
		const form = await fill("55 to 95", "Veins and arteries");
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad One") }));
		expect(await screen.findByTestId("split-preview")).toHaveTextContent("Rad One gets cases 55 to 95.");
		await userEvent.click(within(form).getByRole("button", { name: "Hand out cases" }));
		expect(await screen.findByText("Handed out 1 assignment.")).toBeInTheDocument();
		const post = fake.calls.find((c) => c.method === "POST")!;
		expect(post.body).toMatchObject({ assignee_id: "u1", start: 55, end: 95, task: "Veins and arteries" });
		const row = await screen.findByTestId("assignment-row");
		expect(within(row).getByText("Cases 55 to 95")).toBeInTheDocument();
		// The form is ready for the next hand-out, with the task kept for convenience.
		expect(within(form).getByLabelText("Cases")).toHaveValue("");
		expect(within(form).getByLabelText("Cases")).toBeEnabled();
	});

	it("splits a range evenly between several people and previews it first", async () => {
		open();
		const form = await fill("1 to 10", "Ducts");
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad One") }));
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad Two") }));
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("r3@x.org") }));
		const preview = await screen.findByTestId("split-preview");
		expect(preview).toHaveTextContent("Rad One: 1 to 4 (4 cases)");
		expect(preview).toHaveTextContent("Rad Two: 5 to 7 (3 cases)");
		expect(preview).toHaveTextContent("r3@x.org: 8 to 10 (3 cases)");
		await userEvent.click(within(form).getByRole("button", { name: "Hand out to 3 people" }));
		expect(await screen.findByText("Handed out 3 assignments.")).toBeInTheDocument();
		const posts = fake.calls.filter((c) => c.method === "POST").map((c) => [c.body!.assignee_id, c.body!.start, c.body!.end]);
		expect(posts).toEqual([["u1", 1, 4], ["u2", 5, 7], ["u3", 8, 10]]);
	});

	it("will not give more people than cases", async () => {
		open();
		const form = await fill("1 to 2", "Ducts");
		for (const name of ["Rad One", "Rad Two", "r3@x.org"]) await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp(name) }));
		expect(within(form).getByText(/That is 2 cases for 3 people/)).toBeInTheDocument();
		expect(within(form).getByRole("button", { name: /Hand out/ })).toBeDisabled();
	});

	it("filters the people list", async () => {
		open();
		const form = await screen.findByTestId("hand-out");
		await within(form).findByRole("checkbox", { name: /Rad One/ });
		await userEvent.type(within(form).getByLabelText("Find a person"), "two");
		await within(form).findByRole("checkbox", { name: /Rad Two/ });
		expect(within(form).queryByRole("checkbox", { name: /Rad One/ })).not.toBeInTheDocument();
		await userEvent.clear(within(form).getByLabelText("Find a person"));
		await userEvent.type(within(form).getByLabelText("Find a person"), "zzz");
		expect(within(form).getByText("No one matches.")).toBeInTheDocument();
	});

	it("warns about an overlap, hands nothing out until confirmed, and then does", async () => {
		fake.assignments = [assignment({ id: "x1", assignee: { id: "u2", name: "Rad Two", email: "r2@x.org" }, start: 90, end: 100 })];
		open();
		const form = await fill("55 to 95", "veins and arteries");
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad One") }));
		await userEvent.click(within(form).getByRole("button", { name: "Hand out cases" }));
		const warning = await screen.findByTestId("overlap-warning");
		expect(warning).toHaveTextContent("Rad Two has 90 to 100 (shared: 90 to 95)");
		expect(fake.assignments).toHaveLength(1);
		await userEvent.click(within(warning).getByRole("button", { name: "Hand out anyway" }));
		expect(await screen.findByText("Handed out 1 assignment.")).toBeInTheDocument();
		expect(fake.assignments).toHaveLength(2);
		expect(fake.calls.filter((c) => c.method === "POST").map((c) => c.body!.force)).toEqual([false, true]);
	});

	it("keeps the rest of a split when one block overlaps, and finishes them after confirmation without repeating any", async () => {
		fake.assignments = [assignment({ id: "x1", assignee: { id: "u3", name: null, email: "r3@x.org" }, start: 5, end: 6, task: "Ducts" })];
		open();
		const form = await fill("1 to 6", "Ducts");
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad One") }));
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad Two") }));
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("r3@x.org") }));
		await userEvent.click(within(form).getByRole("button", { name: "Hand out to 3 people" }));
		const warning = await screen.findByTestId("overlap-warning");
		expect(fake.assignments.map((a) => a.id)).toHaveLength(3); // x1 plus the two blocks before the clash
		await userEvent.click(within(warning).getByRole("button", { name: "Hand out anyway" }));
		await waitFor(() => expect(fake.assignments).toHaveLength(4));
		const ranges = fake.assignments.map((a) => [a.assignee.id, a.start, a.end]);
		expect(ranges).toEqual(expect.arrayContaining([["u1", 1, 2], ["u2", 3, 4], ["u3", 5, 6]]));
	});

	it("shows the server's reason when a hand-out is refused, and leaves the form filled in", async () => {
		fake.failNext.POST = 500;
		open();
		const form = await fill("55 to 60", "Veins");
		await userEvent.click(await within(form).findByRole("checkbox", { name: new RegExp("Rad One") }));
		await userEvent.click(within(form).getByRole("button", { name: "Hand out cases" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Rad One: Server said no.");
		expect(within(form).getByLabelText("Cases")).toHaveValue("55 to 60");
		expect(within(form).getByRole("button", { name: "Hand out cases" })).toBeEnabled();
	});

	it("shows everyone's progress grouped by person, with totals", async () => {
		fake.assignments = [
			assignment({ id: "a", start: 1, end: 10, total: 10, done: 4, flagged: 1, todo: 5 }),
			assignment({ id: "b", task: "Lesions", start: 20, end: 29, total: 10, done: 10, todo: 0, assignee: { id: "u2", name: "Rad Two", email: "r2@x.org" } }),
		];
		open();
		const all = await screen.findByTestId("everyone");
		expect(all).toHaveTextContent("2 people, 2 assignments, 14 of 20 cases done, 1 flagged.");
		expect(within(all).getByRole("region", { name: "Rad One" })).toHaveTextContent("Cases 1 to 10");
		expect(within(all).getByRole("region", { name: "Rad Two" })).toHaveTextContent("10 of 10 done");
	});

	it("asks before removing, says how many marks go with it, and removes on confirmation only", async () => {
		fake.assignments = [assignment({ id: "a", done: 2, todo: 4, marks: { "55": "done", "56": "done" } })];
		open();
		const row = await screen.findByTestId("assignment-row");
		await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
		expect(row).toHaveTextContent("and the 2 marks already made");
		await userEvent.click(within(row).getByRole("button", { name: "Keep" }));
		expect(fake.calls.filter((c) => c.method === "DELETE")).toEqual([]);
		await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
		await userEvent.click(within(row).getByRole("button", { name: "Yes, remove" }));
		await waitFor(() => expect(screen.getByText("Nothing has been handed out yet.")).toBeInTheDocument());
		expect(fake.assignments).toEqual([]);
	});

	it("gives an assignment to someone else", async () => {
		fake.assignments = [assignment({ id: "a" })];
		open();
		const row = await screen.findByTestId("assignment-row");
		await userEvent.click(within(row).getByRole("button", { name: "Give to someone else" }));
		await userEvent.selectOptions(within(row).getByRole("combobox"), "u2");
		await waitFor(() => expect(fake.assignments[0].assignee.id).toBe("u2"));
		expect(await screen.findByRole("region", { name: "Rad Two" })).toBeInTheDocument();
	});
});
