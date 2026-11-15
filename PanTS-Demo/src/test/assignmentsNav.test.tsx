import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesignShell from "../components/DesignShell";
import { setRecentUploadsAccount } from "../helpers/recentUploads";
import { type Fake, assignment, makeFake } from "./assignmentsFakeServer";

const auth = vi.hoisted(() => ({ isAuthenticated: true, user: null as null | { id: string; name: string; roles: string[] } }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => auth }));
vi.mock("../components/AuthButton", () => ({ default: () => <button type="button">Account controls</button> }));
vi.mock("../components/WorkspaceTour", () => ({ default: () => null }));
vi.mock("../components/SiteFooter", () => ({ default: () => <footer>Site footer</footer> }));

let fake: Fake;
const mount = (path = "/dashboard") =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes><Route element={<DesignShell />}><Route path="*" element={<p>page</p>} /></Route></Routes>
		</MemoryRouter>,
	);

const as = (roles: string[]) => {
	auth.isAuthenticated = true;
	auth.user = { id: "u1", name: "Rad One", roles };
	fake = makeFake({ roles });
	fake.install();
};

beforeEach(() => {
	localStorage.clear();
	setRecentUploadsAccount("u1");
	auth.user = null;
	auth.isAuthenticated = true;
});

describe("the Assignments tab in the side menu", () => {
	it("is there for an annotator, with how many cases are pending", async () => {
		as(["annotator"]);
		fake.assignments = [assignment({ todo: 4, done: 2 })];
		mount();
		const tab = await screen.findByRole("link", { name: /Assignments/ });
		expect(tab).toHaveAttribute("href", "/assignments");
		await waitFor(() => expect(tab).toHaveTextContent("4"));
		expect(screen.getByLabelText("4 cases pending")).toBeInTheDocument();
	});

	it("shows no count when nothing is pending", async () => {
		as(["annotator"]);
		fake.assignments = [assignment({ todo: 0, done: 6 })];
		mount();
		const tab = await screen.findByRole("link", { name: /Assignments/ });
		await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
		expect(tab.querySelector(".design-nav-badge")).toBeNull();
	});

	it("is there for an annotation manager too, since managers can be given cases", async () => {
		as(["annotation_manager"]);
		mount();
		expect(await screen.findByRole("link", { name: /Assignments/ })).toBeInTheDocument();
	});

	it("is not there for an ordinary account, and nothing is requested for them", async () => {
		as([]);
		mount();
		await screen.findByText("page");
		expect(screen.queryByRole("link", { name: /Assignments/ })).not.toBeInTheDocument();
		expect(fake.calls).toEqual([]);
	});

	it("is not there for an admin who is not an annotator", async () => {
		as(["admin"]);
		mount();
		await screen.findByText("page");
		expect(screen.queryByRole("link", { name: /Assignments/ })).not.toBeInTheDocument();
	});

	it("is not there when signed out", async () => {
		auth.isAuthenticated = false;
		auth.user = null;
		fake = makeFake();
		fake.install();
		mount();
		await screen.findByText("page");
		expect(screen.queryByRole("link", { name: /Assignments/ })).not.toBeInTheDocument();
		expect(fake.calls).toEqual([]);
	});

	it("brings up the one-time notice for newly handed cases, and not again after it is dismissed", async () => {
		as(["annotator"]);
		fake.assignments = [assignment()];
		const first = mount();
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("You have 6 cases to annotate");
		screen.getByRole("button", { name: "Not now" }).click();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		first.unmount();
		mount();
		await screen.findByRole("link", { name: /Assignments/ });
		await new Promise((r) => setTimeout(r, 30));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
