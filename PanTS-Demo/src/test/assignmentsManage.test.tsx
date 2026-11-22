import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const cardFor = async (name: string) => within(await screen.findByRole("article", { name }));
const rad = (id: string, name: string | null, email: string) => ({ id, name, email });

beforeEach(() => {
	localStorage.clear();
	resetCancerVerseCountCache();
	fake = manager();
	fake.install();
});

describe("the page at a glance", () => {
	it("shows four numbers: team members, cases done, overdue, and people with no cases yet", async () => {
		fake.assignments = [
			assignment({ id: "a", assignee: rad("u1", "Rad One", "r1@x.org"), done: 2, todo: 4 }),
			assignment({ id: "b", start: 100, end: 109, total: 10, done: 5, todo: 5, assignee: rad("u2", "Rad Two", "r2@x.org"), due_at: "2020-01-01T00:00:00Z" }),
		];
		open();
		const tiles = within(await screen.findByTestId("tiles"));
		await waitFor(() => expect(tiles.getByText("7 / 16")).toBeInTheDocument());
		expect(tiles.getByText("team members").previousElementSibling).toHaveTextContent("3");
		expect(tiles.getByText("overdue").previousElementSibling).toHaveTextContent("1");
		expect(tiles.getByText("no cases yet").previousElementSibling).toHaveTextContent("1");
	});

	it("tells someone with nothing handed out yet how to start", async () => {
		open();
		expect(await screen.findByTestId("first-time")).toHaveTextContent("Press + Hand out cases to start");
	});

	it("explains that people must join before they can be assigned", async () => {
		fake.accounts = [];
		open();
		expect(await screen.findByTestId("no-people")).toHaveTextContent("Invite them to a project first");
	});

	it("shows an error with a way to try again", async () => {
		fake.failNext.GET = 0;
		open();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't reach the server");
		fake.assignments = [assignment({ assignee: rad("u1", "Rad One", "r1@x.org") })];
		await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(await cardFor("Rad One")).toBeTruthy();
	});
});

describe("a card for each person", () => {
	it("shows what they have, how far along they are and when it is due", async () => {
		fake.assignments = [assignment({ assignee: rad("u1", "Rad One", "r1@x.org"), done: 2, flagged: 1, todo: 3, due_at: "2099-01-01T00:00:00Z" })];
		open();
		const card = await cardFor("Rad One");
		expect(card.getByText("Veins and arteries")).toBeInTheDocument();
		expect(card.getByText("Cases 55 to 60")).toBeInTheDocument();
		expect(card.getByText("2 of 6 done, 1 flagged")).toBeInTheDocument();
		expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
		expect(card.getByText(/^Due /)).toBeInTheDocument();
		expect(card.getByText("r1@x.org")).toBeInTheDocument();
	});

	it("puts people with cases first and gives the others a dashed card with their own Hand out button", async () => {
		fake.assignments = [assignment({ assignee: rad("u2", "Rad Two", "r2@x.org") })];
		open();
		await cardFor("Rad Two");
		const names = screen.getAllByTestId("person-card").map((c) => c.getAttribute("aria-label"));
		expect(names).toEqual(["Rad Two", "r3@x.org", "Rad One"]);
		const waiting = await cardFor("Rad One");
		expect(waiting.getByText("No cases yet")).toBeInTheDocument();
		expect(waiting.getByRole("button", { name: "+ Hand out cases" })).toBeInTheDocument();
		expect(screen.getByRole("article", { name: "Rad One" })).toHaveClass("asg-pcard--empty");
	});

	it("marks an overdue person with an amber card and says it is overdue", async () => {
		fake.assignments = [assignment({ assignee: rad("u1", "Rad One", "r1@x.org"), due_at: "2020-01-01T00:00:00Z" })];
		open();
		const card = await cardFor("Rad One");
		expect(card.getByText(/^Overdue, was due/)).toBeInTheDocument();
		expect(screen.getByRole("article", { name: "Rad One" })).toHaveClass("asg-pcard--late");
		expect(card.getByRole("progressbar").className).toContain("asg-track--late");
	});

	it("does not call finished work overdue", async () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ assignee: rad("u1", "Rad One", "r1@x.org"), due_at: "2020-01-01T00:00:00Z", done: 6, todo: 0, marks })];
		open();
		await cardFor("Rad One");
		expect(screen.getByRole("article", { name: "Rad One" })).not.toHaveClass("asg-pcard--late");
		expect(within(await screen.findByTestId("tiles")).getByText("overdue").previousElementSibling).toHaveTextContent("0");
	});

	it("shows every assignment a person has on their one card", async () => {
		fake.assignments = [
			assignment({ id: "a", task: "Veins", assignee: rad("u1", "Rad One", "r1@x.org") }),
			assignment({ id: "b", task: "Ducts", start: 100, end: 104, total: 5, todo: 5, assignee: rad("u1", "Rad One", "r1@x.org") }),
		];
		open();
		const card = await cardFor("Rad One");
		expect(card.getAllByTestId("assignment-row")).toHaveLength(2);
		expect(screen.getAllByTestId("person-card")).toHaveLength(3);
	});

	it("still shows someone who has stopped being an annotator but has cases on record", async () => {
		fake.assignments = [assignment({ assignee: rad("gone", "Former Annotator", "former@x.org") })];
		open();
		expect(await cardFor("Former Annotator")).toBeTruthy();
	});

	it("opens the Hand out window with a person already ticked from their own card", async () => {
		open();
		const card = await cardFor("Rad Two");
		await userEvent.click(card.getByRole("button", { name: "+ Hand out cases" }));
		const form = within(await screen.findByTestId("hand-out"));
		expect(await form.findByRole("checkbox", { name: /Rad Two/ })).toBeChecked();
		expect(form.getByRole("checkbox", { name: /Rad One/ })).not.toBeChecked();
	});

	it("asks before removing, says how many marks go with it, and removes on confirmation only", async () => {
		fake.assignments = [assignment({ id: "a", assignee: rad("u1", "Rad One", "r1@x.org"), done: 2, todo: 4, marks: { "55": "done", "56": "done" } })];
		open();
		const card = await cardFor("Rad One");
		await userEvent.click(card.getByRole("button", { name: "Remove" }));
		expect(card.getByText(/and the 2 marks already made/)).toBeInTheDocument();
		await userEvent.click(card.getByRole("button", { name: "Keep" }));
		expect(fake.calls.filter((c) => c.method === "DELETE")).toEqual([]);
		await userEvent.click(card.getByRole("button", { name: "Remove" }));
		await userEvent.click(card.getByRole("button", { name: "Yes, remove" }));
		await waitFor(() => expect(fake.assignments).toEqual([]));
		await waitFor(() => expect(within(screen.getByRole("article", { name: "Rad One" })).getByText("No cases yet")).toBeInTheDocument());
	});

	it("gives an assignment to someone else, and the cards follow", async () => {
		fake.assignments = [assignment({ id: "a", assignee: rad("u1", "Rad One", "r1@x.org") })];
		open();
		const card = await cardFor("Rad One");
		await userEvent.click(card.getByRole("button", { name: "Give to someone else ›" }));
		await userEvent.selectOptions(card.getByRole("combobox"), "u2");
		await waitFor(() => expect(fake.assignments[0].assignee.id).toBe("u2"));
		await waitFor(() => expect(within(screen.getByRole("article", { name: "Rad Two" })).getByText("Cases 55 to 60")).toBeInTheDocument());
	});

	it("shows the server's reason when a change is refused", async () => {
		fake.assignments = [assignment({ id: "a", assignee: rad("u1", "Rad One", "r1@x.org") })];
		open();
		const card = await cardFor("Rad One");
		await userEvent.click(card.getByRole("button", { name: "Remove" }));
		fake.failNext.DELETE = 500;
		await userEvent.click(card.getByRole("button", { name: "Yes, remove" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Server said no.");
		expect(fake.assignments).toHaveLength(1);
	});

	it("leaves out the search and filters with a handful of people, and offers them with many", async () => {
		open();
		await cardFor("Rad One");
		expect(screen.queryByLabelText("Find a person in the cards")).not.toBeInTheDocument();
	});

	it("searches and filters a long list of people", async () => {
		for (let i = 0; i < 7; i++) fake.accounts.push({ id: `x${i}`, name: `Extra Person ${i}`, email: `extra${i}@x.org`, annotator: true, manager: false });
		fake.assignments = [
			assignment({ id: "a", assignee: rad("u1", "Rad One", "r1@x.org"), due_at: "2020-01-01T00:00:00Z" }),
			assignment({ id: "b", start: 1, end: 3, total: 3, done: 3, todo: 0, assignee: rad("u2", "Rad Two", "r2@x.org"), marks: { "1": "done", "2": "done", "3": "done" } }),
		];
		open();
		await cardFor("Rad One");
		const find = screen.getByLabelText("Find a person in the cards");
		await userEvent.type(find, "extra person 3");
		expect(screen.getAllByTestId("person-card").map((c) => c.getAttribute("aria-label"))).toEqual(["Extra Person 3"]);
		await userEvent.clear(find);
		await userEvent.type(find, "zzz");
		expect(screen.getByTestId("no-match")).toBeInTheDocument();
		await userEvent.clear(find);
		const filters = within(screen.getByRole("group", { name: "Show people" }));
		await userEvent.click(filters.getByRole("button", { name: /^Overdue/ }));
		expect(screen.getAllByTestId("person-card").map((c) => c.getAttribute("aria-label"))).toEqual(["Rad One"]);
		await userEvent.click(filters.getByRole("button", { name: /^Done/ }));
		expect(screen.getAllByTestId("person-card").map((c) => c.getAttribute("aria-label"))).toEqual(["Rad Two"]);
		await userEvent.click(filters.getByRole("button", { name: /^No cases yet/ }));
		expect(screen.getAllByTestId("person-card")).toHaveLength(8); // Rad Three (no name) and the seven extras
	});
});

describe("the two windows", () => {
	it("open from their buttons and close with the X, Escape, or a click on the dimmed page", async () => {
		open();
		await cardFor("Rad One");
		const handOut = screen.getByTestId("open-hand-out");
		for (const close of ["x", "escape", "backdrop"] as const) {
			await userEvent.click(handOut);
			const dialog = await screen.findByRole("dialog", { name: "Hand out cases" });
			expect(dialog).toHaveAttribute("aria-modal", "true");
			if (close === "x") await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
			else if (close === "escape") await userEvent.keyboard("{Escape}");
			else await userEvent.pointer([{ keys: "[MouseLeft>]", target: dialog.parentElement as HTMLElement }, { keys: "[/MouseLeft]" }]);
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		}
		expect(screen.queryByTestId("open-annotators")).not.toBeInTheDocument();
	});

	it("do not close when something inside them is clicked", async () => {
		open();
		await cardFor("Rad One");
		await userEvent.click(screen.getByTestId("open-hand-out"));
		const form = within(await screen.findByTestId("hand-out"));
		await userEvent.click(form.getByLabelText("Cases"));
		await userEvent.type(form.getByLabelText("Cases"), "5");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("still close with Escape when focus has fallen out of the window, as when the button you pressed disappears", async () => {
		open();
		await cardFor("Rad One");
		await userEvent.click(screen.getByTestId("open-hand-out"));
		await screen.findByRole("dialog");
		(document.activeElement as HTMLElement).blur(); // focus is now on the page itself
		expect(document.activeElement).toBe(document.body);
		fireEvent.keyDown(document.body, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("bring Tab back into the window when focus has fallen out of it, and keep it from leaving", async () => {
		open();
		await cardFor("Rad One");
		await userEvent.click(screen.getByTestId("open-hand-out"));
		const dialog = await screen.findByRole("dialog", { name: "Hand out cases" });
		(document.activeElement as HTMLElement).blur();
		const outside = screen.getByTestId("open-hand-out");
		outside.focus();
		expect(dialog.contains(document.activeElement)).toBe(false);
		// jsdom has no layout, so give the controls a box the way a browser would
		for (const el of dialog.querySelectorAll<HTMLElement>("button, input, summary")) Object.defineProperty(el, "offsetParent", { get: () => document.body });
		fireEvent.keyDown(document.body, { key: "Tab" });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("put the cursor in the first box, hand focus back to the button that opened them, and free the page behind", async () => {
		open();
		await cardFor("Rad One");
		const button = screen.getByTestId("open-hand-out");
		button.focus();
		await userEvent.click(button);
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(within(dialog).getByLabelText("Cases")).toHaveFocus());
		expect(document.body.style.overflow).toBe("hidden");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(button).toHaveFocus();
		expect(document.body.style.overflow).not.toBe("hidden");
	});
});

describe("handing out cases from the window", () => {
	const openForm = async () => {
		await screen.findAllByTestId("person-card");
		await userEvent.click(screen.getByTestId("open-hand-out"));
		return within(await screen.findByTestId("hand-out"));
	};

	const fill = async (cases: string, task: string) => {
		const form = await openForm();
		await userEvent.type(form.getByLabelText("Cases"), cases);
		await userEvent.type(form.getByLabelText("What to annotate"), task);
		return form;
	};

	it("explains what is missing before anything is sent", async () => {
		open();
		const form = await openForm();
		const submit = form.getByRole("button", { name: "Hand out cases" });
		expect(submit).toBeDisabled();
		await userEvent.type(form.getByLabelText("Cases"), "95 to 55");
		expect(form.getByText(/Write the cases as two numbers/)).toBeInTheDocument();
		await userEvent.clear(form.getByLabelText("Cases"));
		await userEvent.type(form.getByLabelText("Cases"), "55 to 95");
		expect(form.getByText(/Say what to annotate/)).toBeInTheDocument();
		await userEvent.type(form.getByLabelText("What to annotate"), "Veins");
		expect(form.getByText(/Choose at least one person/)).toBeInTheDocument();
		expect(submit).toBeDisabled();
		expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);
	});

	it("walks through three numbered steps with obvious boxes and a hint under each", async () => {
		open();
		const form = await openForm();
		const cases = form.getByLabelText("Cases");
		expect(cases).toHaveAttribute("placeholder", "Type the cases, like 55 to 95");
		expect(cases).toHaveAccessibleDescription(/The first and last case number/);
		expect(form.getByLabelText("What to annotate")).toHaveAttribute("placeholder", expect.stringContaining("Veins and arteries"));
		expect(form.getByText("Tick one person. Tick several to split the cases evenly between them.")).toBeInTheDocument();
		expect(form.getByText("Fill in steps 1 to 3 to continue.")).toBeInTheDocument();
		await userEvent.type(cases, "55 to 95");
		expect(await form.findByText(/That is 41 cases/)).toBeInTheDocument();
	});

	it("hands a range to one person, closes the window, says so, and shows it on their card", async () => {
		open();
		const form = await fill("55 to 95", "Veins and arteries");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		expect(await screen.findByTestId("split-preview")).toHaveTextContent("Rad One gets cases 55 to 95.");
		await userEvent.click(form.getByRole("button", { name: "Hand out cases" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(await screen.findByText("Handed out 1 assignment.")).toBeInTheDocument();
		expect(fake.calls.find((c) => c.method === "POST")!.body).toMatchObject({ assignee_id: "u1", start: 55, end: 95, task: "Veins and arteries" });
		const card = await cardFor("Rad One");
		await waitFor(() => expect(card.getByText("Cases 55 to 95")).toBeInTheDocument());
		expect(within(await screen.findByTestId("tiles")).getByText("0 / 41")).toBeInTheDocument();
	});

	it("splits a range evenly between several people and previews it first", async () => {
		open();
		const form = await fill("1 to 10", "Ducts");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad Two/ }));
		await userEvent.click(await form.findByRole("checkbox", { name: /r3@x.org/ }));
		expect(form.getByText("3 selected")).toBeInTheDocument();
		const preview = await screen.findByTestId("split-preview");
		expect(preview).toHaveTextContent("Rad One: 1 to 4 (4 cases)");
		expect(preview).toHaveTextContent("Rad Two: 5 to 7 (3 cases)");
		expect(preview).toHaveTextContent("r3@x.org: 8 to 10 (3 cases)");
		await userEvent.click(form.getByRole("button", { name: "Hand out to 3 people" }));
		expect(await screen.findByText("Handed out 3 assignments.")).toBeInTheDocument();
		expect(fake.calls.filter((c) => c.method === "POST").map((c) => [c.body!.assignee_id, c.body!.start, c.body!.end])).toEqual([["u1", 1, 4], ["u2", 5, 7], ["u3", 8, 10]]);
	});

	it("will not give more people than cases", async () => {
		open();
		const form = await fill("1 to 2", "Ducts");
		for (const name of [/Rad One/, /Rad Two/, /r3@x.org/]) await userEvent.click(await form.findByRole("checkbox", { name }));
		expect(form.getByText(/That is 2 cases for 3 people/)).toBeInTheDocument();
		expect(form.getByRole("button", { name: /Hand out/ })).toBeDisabled();
	});

	it("refuses cases past the end of the library, naming the last one, and accepts the last one", async () => {
		fake.library = { cancerverse: 24422, abdomenatlas: 9262 };
		open();
		const form = await fill("43000 to 50000", "Veins");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		await waitFor(() => expect(form.getByText("The library has cases 1 to 43585. Choose cases up to 43585.")).toBeInTheDocument());
		expect(form.getByRole("button", { name: "Hand out cases" })).toBeDisabled();
		await userEvent.clear(form.getByLabelText("Cases"));
		await userEvent.type(form.getByLabelText("Cases"), "43000 to 43585");
		expect(form.getByRole("button", { name: "Hand out cases" })).toBeEnabled();
	});

	it("says how many scans the library has under the Cases box", async () => {
		fake.library = { cancerverse: 24422, abdomenatlas: 9262 };
		open();
		const form = await openForm();
		expect(await form.findByTestId("library-size")).toHaveTextContent("The library has 43,585 scans: cases 1 to 43,585.");
	});

	it("shows which dataset each part of a range falls in, and reads commas in thousands", async () => {
		fake.library = { cancerverse: 24422, abdomenatlas: 9262 };
		open();
		const form = await openForm();
		await form.findByTestId("library-size");
		await userEvent.type(form.getByLabelText("Cases"), "20,000-42,000");
		const shares = await form.findByTestId("dataset-shares");
		expect(shares).toHaveTextContent("CancerVerse: cases 20,000 to 34,323 (14,324 cases, CV_00010099 to CV_00024422)");
		expect(shares).toHaveTextContent("AbdomenAtlas: cases 34,324 to 42,000 (7,677 cases, BDMAP_00000001 to BDMAP_00007677)");
		expect(shares).not.toHaveTextContent("PanTS");
		expect(form.getByText(/That is 22,001 cases/)).toBeInTheDocument();
		await userEvent.clear(form.getByLabelText("Cases"));
		await userEvent.type(form.getByLabelText("Cases"), "55 to 95");
		expect(await form.findByTestId("dataset-shares")).toHaveTextContent("PanTS: cases 55 to 95 (41 cases)");
	});

	it("does not block a range when the library size cannot be read", async () => {
		open();
		const form = await fill("5 to 60000", "Veins");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		expect(form.getByRole("button", { name: "Hand out cases" })).toBeEnabled();
	});

	it("leaves the search box out with few people, and searches a long list", async () => {
		open();
		const few = await openForm();
		await few.findByRole("checkbox", { name: /Rad One/ });
		expect(few.queryByLabelText("Find a person")).not.toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		for (let i = 0; i < 6; i++) fake.accounts.push({ id: `x${i}`, name: `Extra Person ${i}`, email: `extra${i}@x.org`, annotator: true, manager: false });
		const view = render(<AuthProvider><MemoryRouter><ManagePanel /></MemoryRouter></AuthProvider>);
		const form = within(view.container);
		await form.findAllByTestId("person-card");
		await userEvent.click(within(view.container).getByTestId("open-hand-out"));
		const dialog = within(await screen.findAllByTestId("hand-out").then((all) => all[all.length - 1]));
		await userEvent.type(dialog.getByLabelText("Find a person"), "two");
		await dialog.findByRole("checkbox", { name: /Rad Two/ });
		expect(dialog.queryByRole("checkbox", { name: /Rad One/ })).not.toBeInTheDocument();
		await userEvent.clear(dialog.getByLabelText("Find a person"));
		await userEvent.type(dialog.getByLabelText("Find a person"), "zzz");
		expect(dialog.getByText("No one matches.")).toBeInTheDocument();
	});

	it("offers tasks used before as one-tap choices", async () => {
		fake.assignments = [assignment({ task: "Pancreatic duct", assignee: rad("u1", "Rad One", "r1@x.org") }), assignment({ id: "b", task: "Veins", assignee: rad("u2", "Rad Two", "r2@x.org") })];
		open();
		const form = await openForm();
		const group = within(await form.findByRole("group", { name: "Used before" }));
		await userEvent.click(group.getByRole("button", { name: "Veins" }));
		expect(form.getByLabelText("What to annotate")).toHaveValue("Veins");
		expect(group.getByRole("button", { name: "Veins" })).toHaveClass("asg-chip--on");
		expect(group.getByRole("button", { name: "Pancreatic duct" })).not.toHaveClass("asg-chip--on");
	});

	it("keeps the due date and the note one tap away, not in the way", async () => {
		open();
		const form = await openForm();
		const more = form.getByText("Add a due date or a note (optional)").closest("details") as HTMLDetailsElement;
		expect(more.open).toBe(false);
		await userEvent.click(form.getByText("Add a due date or a note (optional)"));
		expect(more.open).toBe(true);
		expect(form.getByLabelText("Due (optional)")).toBeVisible();
	});

	it("warns about an overlap, hands nothing out until confirmed, and then does", async () => {
		fake.assignments = [assignment({ id: "x1", assignee: rad("u2", "Rad Two", "r2@x.org"), start: 90, end: 100 })];
		open();
		const form = await fill("55 to 95", "veins and arteries");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		await userEvent.click(form.getByRole("button", { name: "Hand out cases" }));
		const warning = await screen.findByTestId("overlap-warning");
		expect(warning).toHaveTextContent("Rad Two has 90 to 100 (shared: 90 to 95)");
		expect(screen.getByRole("dialog")).toBeInTheDocument(); // still open: nothing was handed out yet
		expect(fake.assignments).toHaveLength(1);
		expect(within(warning).queryByRole("button", { name: "Hand out anyway" })).not.toBeInTheDocument();
		expect(fake.assignments).toHaveLength(1);
		expect(fake.calls.filter((c) => c.method === "POST").map((c) => c.body!.force)).toEqual([undefined]);
	});

	it("keeps the rest of a split when one block overlaps, and finishes them after confirmation without repeating any", async () => {
		fake.assignments = [assignment({ id: "x1", assignee: rad("u3", null, "r3@x.org"), start: 5, end: 6, task: "Ducts" })];
		open();
		const form = await fill("1 to 6", "Ducts");
		for (const name of [/Rad One/, /Rad Two/, /r3@x.org/]) await userEvent.click(await form.findByRole("checkbox", { name }));
		await userEvent.click(form.getByRole("button", { name: "Hand out to 3 people" }));
		const warning = await screen.findByTestId("overlap-warning");
		expect(fake.assignments.map((a) => a.id)).toHaveLength(3);
		expect(fake.assignments.map((a) => [a.assignee.id, a.start, a.end])).toEqual(expect.arrayContaining([["u1", 1, 2], ["u2", 3, 4]]));
		expect(screen.getByRole("button", { name: "Continue 1 remaining" })).toBeInTheDocument();
		fake.assignments = fake.assignments.filter((a) => a.id !== "x1");
		await userEvent.click(screen.getByRole("button", { name: "Continue 1 remaining" }));
		await waitFor(() => expect(fake.assignments).toHaveLength(3));
		expect(fake.assignments.map((a) => [a.assignee.id, a.start, a.end])).toEqual(expect.arrayContaining([["u1", 1, 2], ["u2", 3, 4], ["u3", 5, 6]]));
	});

	it("shows the server's reason when a hand-out is refused, and leaves the window open and filled in", async () => {
		fake.failNext.POST = 500;
		open();
		const form = await fill("55 to 60", "Veins");
		await userEvent.click(await form.findByRole("checkbox", { name: /Rad One/ }));
		await userEvent.click(form.getByRole("button", { name: "Hand out cases" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Rad One: Server said no.");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(form.getByLabelText("Cases")).toHaveValue("55 to 60");
		expect(form.getByRole("button", { name: "Continue 1 remaining" })).toBeEnabled();
	});
});

describe("team membership", () => {
	it("does not expose a separate site-wide role editor", async () => {
		open();
		await cardFor("Rad One");
		expect(screen.queryByTestId("open-annotators")).not.toBeInTheDocument();
		expect(screen.queryByText(/Make annotator/)).not.toBeInTheDocument();
	});
});
