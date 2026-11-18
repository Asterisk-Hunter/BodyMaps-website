import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import PeopleSettings from "../routes/Settings/PeopleSettings";
import AnnotatorCodes from "../routes/Settings/AnnotatorCodes";
import { SettingsContext } from "../routes/Settings/context";

// Project owners create codes in the assignment flow; redemption stays in Team access.

let ME = { id: "me", email: "admin@example.com", name: "Admin", plan: "free", account_type: null, roles: ["admin", "annotator"] };
const PERSON = {
	id: "u2", email: "radiologist@example.com", name: "Rad", plan: "free", account_type: null,
	created_at: "2026-01-04T00:00:00", deletion_requested_at: null as string | null, roles: [] as string[],
};

type Invite = { id: string; status: "open" | "redeemed" | "expired"; created_at: string; expires_at: string | null; redeemed_at: string | null; redeemed_by: string | null };
let calls: { method: string; url: string; body?: unknown }[] = [];
let invites: Invite[] = [];
let createStatus = 201;

const json = (body: unknown, ok = true, status = 200) => ({
	ok, status, json: async () => body, text: async () => "", headers: { get: () => "application/json" },
});

beforeEach(() => {
	ME = { ...ME, roles: ["admin", "annotator"] };
	calls = [];
	invites = [];
	createStatus = 201;
	PERSON.roles = [];
	localStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (u.includes("/api/auth/me")) return json({ user: { ...ME } });
		if (u.includes("/api/auth/oauth/providers")) return json({});
		if (u.includes("/api/admin/annotator-invites")) {
			if (method === "POST") {
				if (createStatus !== 201) return json({ error: "nope" }, false, createStatus);
				const permanent = (JSON.parse(String(init?.body)) as { permanent?: boolean }).permanent === true;
				const expires = permanent ? null : "2026-11-07T20:00:00";
				invites = [{ id: "i1", status: "open", created_at: "2026-11-06T20:00:00", expires_at: expires, redeemed_at: null, redeemed_by: null }, ...invites];
				return json({ id: "i1", code: "ABCD-EFGH-JKMN", expires_at: expires ? `${expires}Z` : null, permanent }, true, 201);
			}
			if (method === "DELETE") {
				invites = invites.map((invite) => ({ ...invite, status: "expired" as const }));
				return json({ revoked: true });
			}
			return json({ invites });
		}
		if (u.includes("/api/admin/people") && method === "GET") return json({ people: [PERSON], roles: ["admin", "annotator"], total: 1 });
		if (u.includes("/roles")) return json({ user_id: "u2", roles: ["annotator"] });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderPage = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<SettingsContext.Provider value={{ busy: false, run: async (fn) => fn(), notify: () => {}, fail: () => {} }}>
					<PeopleSettings />
				</SettingsContext.Provider>
			</MemoryRouter>
		</AuthProvider>,
	);

const renderCodes = () => render(<AnnotatorCodes projectId="project-1" />);

describe("who sees the code panel", () => {
	it("keeps invite creation out of the general People settings page", async () => {
		renderPage();
		await screen.findByRole("heading", { name: "People" });
		expect(screen.queryByTestId("annotator-codes")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.includes("/annotator-invites"))).toBe(false);
	});

	it("is hidden from an admin who is not one, and no code request is made", async () => {
		ME = { ...ME, roles: ["admin"] };
		renderPage();
		await screen.findByRole("button", { name: /Edit radiologist@example.com/ });
		expect(screen.queryByTestId("annotator-codes")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.includes("/annotator-invites"))).toBe(false);
	});
});

describe("temporary editing codes", () => {
	it("creates one email-bound code per unique roster address for the selected project", async () => {
		const user = userEvent.setup();
		renderCodes();
		const panel = await screen.findByTestId("annotator-codes");
		await user.click(within(panel).getByText("Create codes for a roster"));
		await user.type(within(panel).getByLabelText("Email addresses"), "one@example.org, TWO@example.org, one@example.org");
		await user.click(within(panel).getByRole("button", { name: "Create roster codes" }));
		const list = await screen.findByRole("list", { name: "New roster codes" });
		await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
		expect(calls.filter(call => call.method === "POST").map(call => call.body)).toEqual([
			{ hours: 24, project_id: "project-1", email: "one@example.org" },
			{ hours: 24, project_id: "project-1", email: "TWO@example.org" },
		]);
	});
	it("creates a project code for the chosen lifetime and keeps its open code shareable", async () => {
		const user = userEvent.setup();
		renderCodes();
		const panel = await screen.findByTestId("annotator-codes");
		await user.selectOptions(within(panel).getByLabelText("Works for"), "168");
		await user.click(within(panel).getByRole("button", { name: "Create code" }));
		const created = await screen.findByTestId("annotator-code-created");
		expect(created).toHaveTextContent("ABCD-EFGH-JKMN");
		expect(created).toHaveTextContent(/open codes remain available below/i);
		const post = calls.find((call) => call.method === "POST" && call.url.includes("/annotator-invites"));
		expect(post?.body).toEqual({ hours: 168, project_id: "project-1" });
	});

	it("offers Permanent after 7 days and creates a code that never expires", async () => {
		const user = userEvent.setup();
		renderCodes();
		const panel = await screen.findByTestId("annotator-codes");
		const select = within(panel).getByLabelText("Works for") as HTMLSelectElement;
		expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["1 hour", "1 day", "7 days", "Permanent"]);
		await user.selectOptions(select, "permanent");
		await user.click(within(panel).getByRole("button", { name: "Create code" }));
		const created = await screen.findByTestId("annotator-code-created");
		expect(created).toHaveTextContent("ABCD-EFGH-JKMN");
		expect(created).toHaveTextContent(/never expires, but works only once/i);
		expect(calls.find((call) => call.method === "POST" && call.url.includes("/annotator-invites"))?.body).toEqual({ permanent: true, project_id: "project-1" });
		expect(await screen.findByRole("list", { name: "Recent codes" })).toHaveTextContent("Open, never expires");
	});

	it("defaults to one day", async () => {
		const user = userEvent.setup();
		renderCodes();
		await user.click(await screen.findByRole("button", { name: "Create code" }));
		await screen.findByTestId("annotator-code-created");
		expect(calls.find((call) => call.method === "POST")?.body).toEqual({ hours: 24, project_id: "project-1" });
	});

	it("lists open, used and expired codes and lets an open one be withdrawn", async () => {
		invites = [
			{ id: "i1", status: "open", created_at: "2026-11-06T20:00:00", expires_at: "2026-11-07T20:00:00", redeemed_at: null, redeemed_by: null },
			{ id: "i2", status: "redeemed", created_at: "2026-11-05T20:00:00", expires_at: "2026-11-06T20:00:00", redeemed_at: "2026-11-05T21:00:00", redeemed_by: "dr.lee@example.com" },
			{ id: "i3", status: "expired", created_at: "2026-11-01T20:00:00", expires_at: "2026-11-02T20:00:00", redeemed_at: null, redeemed_by: null },
		];
		const user = userEvent.setup();
		renderCodes();
		const list = await screen.findByRole("list", { name: "Recent codes" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(3);
		expect(list).toHaveTextContent("Used by dr.lee@example.com");
		expect(within(list).getAllByRole("button", { name: "Withdraw" })).toHaveLength(1); // only the open one
		await user.click(within(list).getByRole("button", { name: "Withdraw" }));
		const confirm = await screen.findByRole("alertdialog", { name: "Withdraw project invite code" });
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
		await user.click(within(confirm).getByRole("button", { name: "Withdraw code" }));
		await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/annotator-invites/i1"))).toBe(true));
	});

	it("says so when a code could not be made, and shows no code", async () => {
		createStatus = 500;
		const user = userEvent.setup();
		renderCodes();
		await user.click(await screen.findByRole("button", { name: "Create code" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create a code");
		expect(screen.queryByTestId("annotator-code-created")).not.toBeInTheDocument();
	});
});

describe("granting editing access from an account", () => {
	it("offers Make annotator and says what it grants (not what admin grants)", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(await screen.findByRole("button", { name: /Edit radiologist@example.com/ }));
		await user.click(await screen.findByRole("button", { name: "Make annotator" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/edit scans for everyone/i);
		expect(dialog).toHaveTextContent(/can't manage accounts or give this access to anyone else/i);
		expect(dialog).not.toHaveTextContent(/email address/i);
		expect(calls.filter((call) => call.url.includes("/roles"))).toHaveLength(0); // nothing sent before confirming
		await user.click(within(dialog).getByRole("button", { name: "Make annotator" }));
		await waitFor(() => expect(calls.find((call) => call.url.includes("/api/admin/people/u2/roles"))?.body).toEqual({ role: "annotator" }));
	});

	it("says what removing it does", async () => {
		PERSON.roles = ["annotator"];
		const user = userEvent.setup();
		renderPage();
		await user.click(await screen.findByRole("button", { name: /Edit radiologist@example.com/ }));
		await user.click(await screen.findByRole("button", { name: "Remove annotator" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/no longer save changes/i);
		expect(dialog).not.toHaveTextContent(/usage dashboard/i);
	});
});
