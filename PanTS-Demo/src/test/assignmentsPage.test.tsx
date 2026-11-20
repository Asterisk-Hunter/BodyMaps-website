import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import AssignmentsPage from "../routes/AssignmentsPage";
import { type Fake, assignment, makeFake } from "./assignmentsFakeServer";

let fake: Fake;

const open = () =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={["/assignments"]}>
				<Routes>
					<Route path="/assignments" element={<AssignmentsPage />} />
					<Route path="/dashboard" element={<p>dataset page</p>} />
					<Route path="/" element={<p>home page</p>} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

const cards = () => screen.queryAllByTestId("assignment-case");
const statusOfCard = (card: HTMLElement) => within(card).getByTestId("case-status").textContent;

// Cases 55-60: 55 done, 56 flagged, 57 done, 58-60 still to do.
const partway = () => assignment({ done: 2, flagged: 1, todo: 3, marks: { "55": "done", "56": "flagged", "57": "done" } });

beforeEach(() => {
	localStorage.clear();
	fake = makeFake();
	fake.install();
});

describe("the annotator's list of cases", () => {
	it("shows a card for every case with its state written under it", async () => {
		fake.assignments = [partway()];
		open();
		await waitFor(() => expect(cards()).toHaveLength(3)); // opens on what is left to do
		await userEvent.click(screen.getByRole("button", { name: /^All/ }));
		await waitFor(() => expect(cards()).toHaveLength(6));
		expect(cards().map(statusOfCard)).toEqual(["Complete", "Flagged", "Complete", "Pending", "Pending", "Pending"]);
		expect(within(cards()[0]).getByText("Case 55")).toBeInTheDocument();
		expect(within(cards()[0]).getByText("PanTS_00000055")).toBeInTheDocument();
		expect(within(cards()[0]).getByRole("link")).toHaveAttribute("href", "/case/55");
		const task = screen.getByTestId("task-line");
		expect(task).toHaveTextContent("What to annotate");
		expect(task).toHaveTextContent("Veins and arteries");
		expect(task).toHaveTextContent("Cases 55 to 60");
	});

	it("marks the case Continue goes to as Next, and only that one", async () => {
		fake.assignments = [partway()];
		open();
		await waitFor(() => expect(cards()).toHaveLength(3));
		const next = screen.getAllByTestId("next-case");
		expect(next).toHaveLength(1);
		expect(cards()[0]).toContainElement(next[0]); // case 58: the first one still to do
		expect(cards()[0]).toHaveTextContent("Case 58");
	});

	it("shows the note for the assignment in the what-to-annotate card", async () => {
		fake.assignments = [assignment({ note: "Start with the portal phase." })];
		open();
		expect(await screen.findByTestId("task-line")).toHaveTextContent("Start with the portal phase.");
	});

	it("does not mark a Next case when everything is done", async () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ done: 6, todo: 0, marks })];
		open();
		await waitFor(() => expect(cards()).toHaveLength(6));
		expect(screen.queryByTestId("next-case")).not.toBeInTheDocument();
	});

	it("opens on the pending cases when there are any, and on everything when there are none", async () => {
		fake.assignments = [partway()];
		const first = open();
		await waitFor(() => expect(cards()).toHaveLength(3));
		expect(screen.getByRole("button", { name: /^Pending/ })).toHaveAttribute("aria-pressed", "true");
		first.unmount();
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ done: 6, todo: 0, marks })];
		open();
		await waitFor(() => expect(cards()).toHaveLength(6));
		expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
	});

	it("filters to pending, complete or flagged cases and says how many of each there are", async () => {
		fake.assignments = [partway()];
		open();
		await waitFor(() => expect(cards()).toHaveLength(3));
		expect(screen.getByRole("button", { name: /^All/ })).toHaveTextContent("6");
		expect(screen.getByRole("button", { name: /^Pending/ })).toHaveTextContent("3");
		expect(screen.getByRole("button", { name: /^Complete/ })).toHaveTextContent("2");
		expect(screen.getByRole("button", { name: /^Flagged/ })).toHaveTextContent("1");

		await userEvent.click(screen.getByRole("button", { name: /^Pending/ }));
		expect(cards().map(statusOfCard)).toEqual(["Pending", "Pending", "Pending"]);
		expect(cards().map((c) => within(c).getByRole("link").getAttribute("href"))).toEqual(["/case/58", "/case/59", "/case/60"]);
		expect(screen.getByRole("button", { name: /^Pending/ })).toHaveAttribute("aria-pressed", "true");

		await userEvent.click(screen.getByRole("button", { name: /^Complete/ }));
		expect(cards().map(statusOfCard)).toEqual(["Complete", "Complete"]);
		await userEvent.click(screen.getByRole("button", { name: /^Flagged/ }));
		expect(cards().map(statusOfCard)).toEqual(["Flagged"]);
		await userEvent.click(screen.getByRole("button", { name: /^All/ }));
		expect(cards()).toHaveLength(6);
	});

	it("summarises progress and continues at the next case still to do", async () => {
		fake.assignments = [partway()];
		open();
		expect(await screen.findByTestId("summary")).toHaveTextContent("2 of 6 complete");
		expect(screen.getByRole("progressbar", { name: "Overall progress" })).toHaveAttribute("aria-valuenow", "2");
		expect(screen.getByRole("link", { name: "Continue with case 58" })).toHaveAttribute("href", "/case/58");
	});

	it("offers Start when nothing is marked, and celebrates when everything is", async () => {
		fake.assignments = [assignment()];
		open();
		expect(await screen.findByRole("link", { name: "Start with case 55" })).toBeInTheDocument();
	});

	it("says everything is marked when nothing is left, and the Pending filter explains its empty list", async () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		fake.assignments = [assignment({ done: 6, todo: 0, marks })];
		open();
		expect(await screen.findByText("Everything is marked. Nice work.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /^Pending/ }));
		expect(screen.getByTestId("no-matches")).toHaveTextContent("No pending cases. Everything is marked.");
		await userEvent.click(screen.getByRole("button", { name: /^Flagged/ }));
		expect(screen.getByTestId("no-matches")).toHaveTextContent("No cases are flagged.");
	});

	it("shows the due date and calls an overdue one overdue", async () => {
		fake.assignments = [assignment({ due_at: "2020-01-01T00:00:00Z" })];
		open();
		expect(await screen.findByText(/^Overdue, was due/)).toBeInTheDocument();
	});

	it("handles several assignments: all together with the task on each card, or one at a time", async () => {
		fake.assignments = [
			assignment({ id: "a", task: "Veins", start: 1, end: 3, total: 3, todo: 3 }),
			assignment({ id: "b", task: "Ducts", start: 2, end: 4, total: 3, done: 1, todo: 2, marks: { "3": "done" } }),
		];
		open();
		await waitFor(() => expect(cards()).toHaveLength(5)); // the pending ones: 3 + 2
		expect(within(cards()[0]).getByText("Veins")).toBeInTheDocument();
		expect(screen.getByTestId("summary")).toHaveTextContent("1 of 6 complete");
		await userEvent.click(screen.getByRole("button", { name: /^All/ }));
		expect(cards()).toHaveLength(6);
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Assignment" }), "b");
		expect(cards()).toHaveLength(3);
		expect(screen.getByTestId("task-line")).toHaveTextContent("Ducts");
		expect(screen.getByTestId("task-line")).toHaveTextContent("Cases 2 to 4");
		expect(screen.getByTestId("summary")).toHaveTextContent("1 of 3 complete");
		expect(within(cards()[0]).queryByText("Ducts")).not.toBeInTheDocument();
	});

	it("shows 24 cards at a time and pages through a long list without a pointless Show more", async () => {
		fake.assignments = [assignment({ start: 1, end: 60, total: 60, todo: 60 })];
		open();
		await waitFor(() => expect(cards()).toHaveLength(24));
		await userEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(cards()).toHaveLength(48);
		await userEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(cards()).toHaveLength(60);
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("does not offer Show more when the cases fit exactly on one page", async () => {
		fake.assignments = [assignment({ start: 1, end: 24, total: 24, todo: 24 })];
		open();
		await waitFor(() => expect(cards()).toHaveLength(24));
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("builds only the cards on screen, even for a 50,000-case assignment", async () => {
		fake.assignments = [assignment({ start: 1, end: 50000, total: 50000, todo: 50000 })];
		const t0 = performance.now();
		open();
		await waitFor(() => expect(cards()).toHaveLength(24));
		expect(performance.now() - t0).toBeLessThan(3000);
		await userEvent.click(screen.getByRole("button", { name: /^Complete/ }));
		expect(screen.getByTestId("no-matches")).toBeInTheDocument();
	});

	it("keeps a Pending filter honest across a case list that is mostly complete", async () => {
		const marks = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), "done" as const]));
		fake.assignments = [assignment({ start: 1, end: 230, total: 230, done: 200, todo: 30, marks })];
		open();
		await waitFor(() => expect(cards()).toHaveLength(24));
		await userEvent.click(screen.getByRole("button", { name: /^Pending/ }));
		expect(cards()).toHaveLength(24);
		expect(cards().every((c) => statusOfCard(c) === "Pending")).toBe(true);
		expect(within(cards()[0]).getByRole("link")).toHaveAttribute("href", "/case/201");
		await userEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(cards()).toHaveLength(30);
	});

	it("tells someone with nothing assigned what will happen", async () => {
		open();
		expect(await screen.findByTestId("no-assignments")).toHaveTextContent("Nothing assigned to you yet");
		expect(screen.queryByRole("button", { name: /^Pending/ })).not.toBeInTheDocument();
	});

	it("shows an error with a way to try again", async () => {
		fake.failNext.GET = 0;
		open();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't reach the server");
		fake.assignments = [assignment()];
		await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(cards()).toHaveLength(6));
	});

	it("sends someone who is not an annotator to the dataset page, with no assignment requests", async () => {
		fake = makeFake({ roles: [] });
		fake.install();
		open();
		expect(await screen.findByText("dataset page")).toBeInTheDocument();
		expect(fake.calls).toEqual([]);
	});
});


describe("the manager's view of the page", () => {
	const asManager = (roles = ["annotation_manager"]) => {
		fake = makeFake({ id: "m1", email: "m@x.org", name: "Manager", roles });
		fake.accounts.push({ id: "m1", name: "Manager", email: "m@x.org", annotator: roles.includes("annotator"), manager: true });
		fake.install();
	};

	it("opens on the manager's cards, with a switch to their own cases, for an annotation manager", async () => {
		asManager();
		open();
		expect(await screen.findByTestId("manage-panel")).toBeInTheDocument();
		expect(screen.getByTestId("open-hand-out")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Annotators" })).toBeInTheDocument();
		expect(screen.getByTestId("tiles")).toBeInTheDocument();
		expect(await screen.findAllByTestId("person-card")).toHaveLength(4); // the three annotators and the manager, who can be given cases too
		expect(screen.getByRole("button", { name: "Manage" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByTestId("assignment-case")).not.toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // the windows are closed until asked for
	});

	it("switches to the manager's own cases, and back", async () => {
		asManager();
		fake.assignments = [assignment({ assignee: { id: "m1", name: "Manager", email: "m@x.org" } })];
		open();
		await screen.findByTestId("manage-panel");
		const mine = screen.getByRole("button", { name: /^My cases/ });
		await waitFor(() => expect(mine).toHaveTextContent("6")); // cases still pending
		await userEvent.click(mine);
		await waitFor(() => expect(cards()).toHaveLength(6));
		expect(screen.queryByTestId("manage-panel")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Manage" }));
		expect(await screen.findByTestId("manage-panel")).toBeInTheDocument();
	});

	it("shows an annotator only their own cases: no switch, no manager tools, no manager requests", async () => {
		fake.assignments = [assignment()];
		open();
		await waitFor(() => expect(cards()).toHaveLength(6));
		expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
		expect(screen.queryByTestId("manage-panel")).not.toBeInTheDocument();
		expect(screen.queryByText("Hand out cases")).not.toBeInTheDocument();
		expect(fake.calls.map((c) => c.url).filter((u) => /\/assignments(\/people|\/accounts|\/annotators)?$/.test(u.split("?")[0]) && !u.endsWith("/mine"))).toEqual([]);
	});

	it("can be reached by a manager with nothing assigned to them", async () => {
		asManager();
		open();
		expect(await screen.findByTestId("manage-panel")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /^My cases/ }));
		expect(await screen.findByTestId("no-assignments")).toBeInTheDocument();
	});
});
