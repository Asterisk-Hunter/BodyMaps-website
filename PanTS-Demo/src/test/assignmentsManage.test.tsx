import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCancerVerseCountCache } from "../helpers/caseNumbering";
import { AuthProvider } from "../contexts/authContext";
import ManagePanel from "../routes/AssignmentsPage/ManagePanel";
import { type Fake, assignment, makeFake } from "./assignmentsFakeServer";

let fake: Fake;

const open = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<ManagePanel />
			</MemoryRouter>
		</AuthProvider>,
	);

const manager = () => makeFake({ id: "m1", email: "m@x.org", name: "Manager", roles: ["annotation_manager", "annotator"] });

beforeEach(() => {
	localStorage.clear();
	resetCancerVerseCountCache();
});

describe("the manager's tools", () => {
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

	it("filters the people list when there are many, and leaves the search box out when there are few", async () => {
		open();
		const few = await screen.findByTestId("hand-out");
		await within(few).findByRole("checkbox", { name: /Rad One/ });
		expect(within(few).queryByLabelText("Find a person")).not.toBeInTheDocument(); // three people: no search box to puzzle over
	});

	it("searches a long list of people", async () => {
		for (let i = 0; i < 6; i++) fake.accounts.push({ id: `x${i}`, name: `Extra Person ${i}`, email: `extra${i}@x.org`, annotator: true, manager: false });
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

	it("walks through three numbered steps with obvious boxes and a hint under each", async () => {
		open();
		const form = within(await screen.findByTestId("hand-out"));
		const cases = form.getByLabelText("Cases");
		expect(cases).toHaveAttribute("placeholder", "Type the cases, like 55 to 95");
		expect(cases).toHaveAccessibleDescription(/The first and last case number/);
		expect(form.getByLabelText("What to annotate")).toHaveAttribute("placeholder", expect.stringContaining("Veins and arteries"));
		expect(form.getByText("Tick one person. Tick several to split the cases evenly between them.")).toBeInTheDocument();
		expect(form.getByText("Fill in steps 1 to 3 to continue.")).toBeInTheDocument(); // the disabled button says why
		await userEvent.type(cases, "55 to 95");
		expect(await form.findByText(/That is 41 cases/)).toBeInTheDocument();
	});

	it("offers tasks used before as one-tap choices", async () => {
		fake.assignments = [assignment({ task: "Pancreatic duct" }), assignment({ id: "b", task: "Veins" })];
		open();
		const form = within(await screen.findByTestId("hand-out"));
		const group = within(await form.findByRole("group", { name: "Used before" }));
		await userEvent.click(group.getByRole("button", { name: "Veins" }));
		expect(form.getByLabelText("What to annotate")).toHaveValue("Veins");
		expect(group.getByRole("button", { name: "Veins" })).toHaveClass("asg-chip--on");
		expect(group.getByRole("button", { name: "Pancreatic duct" })).not.toHaveClass("asg-chip--on");
	});

	it("keeps the due date and the note one tap away, not in the way", async () => {
		open();
		const form = within(await screen.findByTestId("hand-out"));
		const more = form.getByText("Add a due date or a note (optional)").closest("details") as HTMLDetailsElement;
		expect(more.open).toBe(false);
		await userEvent.click(form.getByText("Add a due date or a note (optional)"));
		expect(more.open).toBe(true);
		expect(form.getByLabelText("Due (optional)")).toBeVisible();
	});

	it("says how many people are selected", async () => {
		open();
		const form = within(await screen.findByTestId("hand-out"));
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad Two/ }));
		expect(form.getByText("2 selected")).toBeInTheDocument();
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


describe("choosing who is an annotator", () => {
	beforeEach(() => {
		fake = manager();
		fake.install();
	});

	const panel = async () => within(await screen.findByTestId("annotators"));

	it("lists the current annotators, tagging the ones who are also managers", async () => {
		fake.accounts.push({ id: "m1", name: "Manager", email: "m@x.org", annotator: true, manager: true });
		fake.accounts.push({ id: "m2", name: "Only A Manager", email: "m2@x.org", annotator: false, manager: true });
		open();
		const list = within(await screen.findByRole("list", { name: "Annotators" }));
		expect(list.getAllByRole("listitem")).toHaveLength(4); // the three annotators and the manager who is also one
		expect(list.getByText("Manager", { selector: ".asg-tag" })).toBeInTheDocument();
		expect(list.queryByText("Only A Manager")).not.toBeInTheDocument(); // holds only the manager role
		expect(screen.getByText("Annotators (4)")).toBeInTheDocument();
	});

	it("asks for at least three letters before searching, and sends nothing until then", async () => {
		open();
		const p = await panel();
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "ma");
		expect(p.getByText("Type at least 3 letters.")).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 400));
		expect(fake.calls.some((c) => c.url.includes("/assignments/accounts"))).toBe(false);
	});

	it("finds a person by part of a name or email and makes them an annotator", async () => {
		open();
		const p = await panel();
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "maria");
		const results = within(await p.findByRole("list", { name: "Matching accounts" }));
		expect(results.getByText("Maria Newcomer")).toBeInTheDocument();
		expect(results.getByText("maria@clinic.org")).toBeInTheDocument();
		await userEvent.click(results.getByRole("button", { name: "Make annotator" }));
		expect(await screen.findByText("Maria Newcomer is now an annotator and can be handed cases.")).toBeInTheDocument();
		expect(fake.calls.find((c) => c.method === "POST" && c.url.includes("/annotators"))?.body).toEqual({ user_id: "u4" });
		// she now shows as an annotator in the search result, in the list, and can be chosen when handing out cases
		expect(results.getByText("Annotator")).toBeInTheDocument();
		expect(results.queryByRole("button", { name: "Make annotator" })).not.toBeInTheDocument();
		expect(await screen.findByText("Annotators (4)")).toBeInTheDocument();
		expect(await within(screen.getByTestId("hand-out")).findByRole("checkbox", { name: /Maria Newcomer/ })).toBeInTheDocument();
	});

	it("says so when nobody matches, and that they need to sign up first", async () => {
		open();
		const p = await panel();
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "nobody-here");
		expect(await p.findByTestId("no-accounts")).toHaveTextContent("They need to sign up on the website first");
	});

	it("shows what an account already is: no button for an annotator", async () => {
		open();
		const p = await panel();
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "r2@x");
		const results = within(await p.findByRole("list", { name: "Matching accounts" }));
		expect(results.getByText("Annotator")).toBeInTheDocument();
		expect(results.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the server's message when making an annotator fails, and lets them try again", async () => {
		open();
		const p = await panel();
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "pat@");
		const results = within(await p.findByRole("list", { name: "Matching accounts" }));
		fake.failNext.POST = 500;
		await userEvent.click(results.getByRole("button", { name: "Make annotator" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Server said no.");
		await userEvent.click(results.getByRole("button", { name: "Make annotator" }));
		expect(await screen.findByText("Pat Plain is now an annotator and can be handed cases.")).toBeInTheDocument();
	});

	it("asks before removing an annotator, says what happens to their cases, and removes on confirmation only", async () => {
		fake.assignments = [assignment({ assignee: { id: "u2", name: "Rad Two", email: "r2@x.org" }, done: 2, todo: 4 })];
		open();
		const list = within(await screen.findByRole("list", { name: "Annotators" }));
		const row = within(list.getByText("Rad Two").closest("li") as HTMLElement);
		await userEvent.click(row.getByRole("button", { name: "Remove" }));
		expect(await screen.findByText(/4 cases are still to do and stay with them/)).toBeInTheDocument();
		expect(screen.getByText(/Their finished marks are kept/)).toBeInTheDocument();
		await userEvent.click(row.getByRole("button", { name: "Keep" }));
		expect(fake.calls.some((c) => c.method === "DELETE" && c.url.includes("/annotators"))).toBe(false);
		await userEvent.click(row.getByRole("button", { name: "Remove" }));
		await userEvent.click(row.getByRole("button", { name: "Yes, remove" }));
		expect(await screen.findByText("Rad Two is no longer an annotator. Their finished marks are kept.")).toBeInTheDocument();
		expect(fake.accounts.find((a) => a.id === "u2")?.annotator).toBe(false);
		expect(await screen.findByText("Annotators (2)")).toBeInTheDocument();
	});

	it("shows an error, not a crash, when the search cannot reach the server", async () => {
		open();
		const p = await panel();
		fake.failNext.GET = 0;
		await userEvent.type(p.getByLabelText("Find a person to make an annotator"), "maria");
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server");
	});

	it("does not show stale results after the search is cleared", async () => {
		open();
		const p = await panel();
		const box = p.getByLabelText("Find a person to make an annotator");
		await userEvent.type(box, "maria");
		await p.findByRole("list", { name: "Matching accounts" });
		await userEvent.clear(box);
		expect(p.queryByRole("list", { name: "Matching accounts" })).not.toBeInTheDocument();
	});
});
