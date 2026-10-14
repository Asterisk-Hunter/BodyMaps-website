import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import PeopleSettings from "../routes/Settings/PeopleSettings";
import { SettingsContext } from "../routes/Settings/context";

// The admin People page, which is where an account can be handed the keys to the
// whole site or closed outright.
//
// These tests are about the gate, not the layout: that nothing is sent until a
// confirmation is answered, that the admin confirmation says what admin actually
// grants, and that deleting somebody needs their address typed out. The old
// version of this page fired a role change on one unguarded click, which is the
// behaviour this is here to stop coming back.

const ME = {
	id: "me",
	email: "admin@example.com",
	name: "Admin",
	plan: "free",
	account_type: null,
	roles: ["admin"],
};

const PEOPLE = [
	{
		id: "u2",
		email: "someone@example.com",
		name: "Some One",
		plan: "free",
		account_type: null,
		created_at: "2026-01-04T00:00:00",
		deletion_requested_at: null as string | null,
		roles: [] as string[],
	},
];

let calls: { method: string; url: string; body?: unknown }[] = [];

const json = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	calls = [];
	localStorage.clear();
	PEOPLE[0].roles = [];
	PEOPLE[0].deletion_requested_at = null;

	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });

		if (u.includes("/api/auth/me")) return json({ user: { ...ME } });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		if (u.includes("/api/admin/people") && method === "GET") {
			return json({ people: PEOPLE, roles: ["admin"], total: 1 });
		}
		if (u.includes("/roles")) return json({ user_id: "u2", roles: ["admin"] });
		if (u.includes("/restore")) return json({ user_id: "u2", deletion_requested_at: null });
		if (method === "DELETE") {
			return json({ user_id: "u2", grace_days: 30, restore_by: "2026-09-19T00:00:00" });
		}
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderPage = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<SettingsContext.Provider
					value={{ busy: false, run: async (fn) => fn(), notify: () => {}, fail: () => {} }}
				>
					<PeopleSettings />
				</SettingsContext.Provider>
			</MemoryRouter>
		</AuthProvider>,
	);

const writes = () => calls.filter((c) => c.method !== "GET");

/** Open a row's Edit menu and pick one of its items. */
const choose = async (user: ReturnType<typeof userEvent.setup>, item: string | RegExp) => {
	await user.click(await screen.findByRole("button", { name: /Edit someone@example.com/ }));
	await user.click(await screen.findByRole("button", { name: item }));
};

describe("the Edit menu", () => {
	it("sends nothing until a confirmation is answered", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Make admin");

		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		expect(writes()).toHaveLength(0);
	});

	it("says what admin actually grants before granting it", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Make admin");
		const dialog = await screen.findByRole("alertdialog");

		expect(dialog).toHaveTextContent(/every account's email address/i);
		expect(dialog).toHaveTextContent(/including yours/i);
	});

	it("grants the role once confirmed", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Make admin");
		await user.click(await screen.findByRole("button", { name: "Make admin" }));

		const sent = writes();
		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe("POST");
		expect(sent[0].url).toContain("/api/admin/people/u2/roles");
		expect(sent[0].body).toEqual({ role: "admin" });
	});

	it("sends nothing when the confirmation is cancelled", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Make admin");
		await user.click(await screen.findByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(writes()).toHaveLength(0);
	});
});

describe("deleting an account", () => {
	it("stays disabled until the account's email is typed", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Delete account");
		const dialog = await screen.findByRole("alertdialog");
		const confirm = within(dialog).getByRole("button", { name: "Delete account" });

		// aria-disabled rather than disabled, so it keeps keyboard focus.
		expect(confirm).toHaveAttribute("aria-disabled", "true");

		// Close, but not close enough.
		await user.type(within(dialog).getByRole("textbox"), "someone@example.co");
		expect(confirm).toHaveAttribute("aria-disabled", "true");
		// Pressing it, or Enter in the field, still sends nothing.
		await user.click(confirm);
		await user.type(within(dialog).getByRole("textbox"), "{Enter}");
		expect(writes()).toHaveLength(0);

		await user.type(within(dialog).getByRole("textbox"), "m");
		expect(confirm).not.toHaveAttribute("aria-disabled");
	});

	it("says the deletion can be undone, because it can", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Delete account");
		expect(await screen.findByRole("alertdialog")).toHaveTextContent(/restored for 30 days/i);
	});

	it("sends the delete once armed", async () => {
		const user = userEvent.setup();
		renderPage();

		await choose(user, "Delete account");
		const dialog = await screen.findByRole("alertdialog");
		await user.type(within(dialog).getByRole("textbox"), "someone@example.com");
		await user.click(within(dialog).getByRole("button", { name: "Delete account" }));

		const sent = writes();
		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe("DELETE");
		expect(sent[0].url).toMatch(/\/api\/admin\/people\/u2$/);
	});

	it("offers Restore instead of Delete for a scheduled account", async () => {
		PEOPLE[0].deletion_requested_at = new Date().toISOString();
		const user = userEvent.setup();
		renderPage();

		expect(await screen.findByText(/Scheduled for deletion/)).toBeInTheDocument();

		await user.click(await screen.findByRole("button", { name: /Edit someone@example.com/ }));
		expect(screen.queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Restore account" })).toBeInTheDocument();
	});
});

describe("focus around the confirmation", () => {
	it("moves into the panel when an action is picked, and back to Edit on Cancel", async () => {
		const user = userEvent.setup();
		renderPage();
		await choose(user, "Make admin");

		const dialog = await screen.findByRole("alertdialog");
		expect(document.activeElement).toBe(dialog);

		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(screen.getByRole("button", { name: /Edit someone@example.com/ }));
	});

	it("gives focus back to Edit on Escape, from the menu and from the panel", async () => {
		const user = userEvent.setup();
		renderPage();
		const edit = await screen.findByRole("button", { name: /Edit someone@example.com/ });

		await user.click(edit);
		screen.getByRole("button", { name: "Make admin" }).focus();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("group", { name: /Actions for/ })).toBeNull();
		expect(document.activeElement).toBe(edit);

		await choose(user, "Delete account");
		expect(document.activeElement).toBe(screen.getByLabelText(/Type someone@example.com to confirm/));
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(document.activeElement).toBe(edit);
	});

	it("gives focus back to Edit once a change has gone through", async () => {
		const user = userEvent.setup();
		renderPage();
		await choose(user, "Make admin");
		await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));

		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: /Edit someone@example.com/ }))
		);
	});
});

describe("your own row", () => {
	it("offers neither removing your own role nor deleting your own account", async () => {
		const own = { ...PEOPLE[0], id: "me", email: "admin@example.com", roles: ["admin"] };
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
			String(url).includes("/api/admin/people") && (init?.method ?? "GET") === "GET"
				? json({ people: [PEOPLE[0], own], roles: ["admin"], total: 2 })
				: answer(url, init)) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: /Edit admin@example.com/ }));
		const menu = screen.getByRole("group", { name: /Actions for admin@example.com/ });
		expect(within(menu).queryByRole("button")).toBeNull();
		expect(menu).toHaveTextContent("To delete your own account, use Privacy.");

		// Everyone else's row is unchanged.
		await user.click(screen.getByRole("button", { name: /Edit someone@example.com/ }));
		const other = screen.getByRole("group", { name: /Actions for someone@example.com/ });
		expect(within(other).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
		expect(within(other).getByRole("button", { name: "Delete account" })).toBeInTheDocument();
	});
});

describe("loading the list", () => {
	const answerList = (respond: (q: string) => Promise<unknown> | unknown) => {
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/admin/people") && (init?.method ?? "GET") === "GET") {
				calls.push({ method: "GET", url: u });
				return respond(new URL(u, "http://x").searchParams.get("q") ?? "");
			}
			return answer(url, init);
		}) as unknown as typeof fetch;
	};

	it("reads the joined date as UTC, the zone the server sends", async () => {
		renderPage();
		const joined = new Date(Date.UTC(2026, 0, 4))
			.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
		expect(await screen.findByText(new RegExp(joined.replace(/[.,]/g, "\\$&")))).toBeInTheDocument();
	});

	it("says the session ended and offers sign-in on a 401, not a retry", async () => {
		answerList(() => json({ error: "Sign in required" }, false, 401));
		renderPage();

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("Your session has ended.");
		expect(within(banner).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
		expect(within(banner).queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("says an admin account is needed on a 403, with nothing to press", async () => {
		answerList(() => json({ error: "Forbidden" }, false, 403));
		renderPage();

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("You need an admin account to see this.");
		expect(within(banner).queryByRole("button")).toBeNull();
	});

	it("offers Try again on any other failure, and loads the list when pressed", async () => {
		let fail = true;
		answerList(() => (fail ? json({ error: "boom" }, false, 500) : json({ people: PEOPLE, roles: ["admin"], total: 1 })));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const user = userEvent.setup();
		renderPage();

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("Couldn't load accounts. Try again.");
		expect(banner).not.toHaveTextContent("boom");
		fail = false;
		await user.click(within(banner).getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: /Edit someone@example.com/ })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ignores an older search that answers after a newer one", async () => {
		const pending = new Map<string, (body: unknown) => void>();
		answerList((q) => new Promise((resolve) => pending.set(q, resolve)));
		const user = userEvent.setup();
		renderPage();
		const search = await screen.findByRole("searchbox", { name: "Search accounts" });

		await waitFor(() => expect(pending.has("")).toBe(true));
		pending.get("")!(json({ people: PEOPLE, roles: ["admin"], total: 1 }));
		await screen.findByRole("button", { name: /Edit someone@example.com/ });

		await user.type(search, "old");
		await waitFor(() => expect(pending.has("old")).toBe(true));
		await user.clear(search);
		await user.type(search, "new");
		await waitFor(() => expect(pending.has("new")).toBe(true));

		const other = { ...PEOPLE[0], id: "u3", email: "stale@example.com" };
		pending.get("new")!(json({ people: [], roles: ["admin"], total: 0 }));
		expect(await screen.findByText('No account matches "new".')).toBeInTheDocument();
		pending.get("old")!(json({ people: [other], roles: ["admin"], total: 1 }));
		await new Promise((r) => setTimeout(r, 20));

		expect(screen.queryByText("stale@example.com")).toBeNull();
		expect(screen.getByText('No account matches "new".')).toBeInTheDocument();
	});
});

describe("a change the server refuses", () => {
	it("opens sign-in and says the session ended on a 401", async () => {
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
			(init?.method ?? "GET") === "POST" && String(url).includes("/roles")
				? json({ error: "Sign in required" }, false, 401)
				: answer(url, init)) as unknown as typeof fetch;
		const failed: string[] = [];
		const user = userEvent.setup();
		render(
			<AuthProvider>
				<MemoryRouter>
					<SettingsContext.Provider
						value={{
							busy: false,
							run: async (fn) => { try { await fn(); } catch (e) { failed.push((e as Error).message); } },
							notify: () => {},
							fail: () => {},
						}}
					>
						<PeopleSettings />
					</SettingsContext.Provider>
				</MemoryRouter>
			</AuthProvider>,
		);

		await choose(user, "Make admin");
		await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));

		await waitFor(() => expect(failed).toEqual(["Your session has ended. Sign in again."]));
		// The confirmation stays, so the change can be made again after signing in.
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("says it didn't work, not the browser's text, when the request never lands", async () => {
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "POST") throw new TypeError("Failed to fetch");
			return answer(url, init);
		}) as unknown as typeof fetch;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const failed: string[] = [];
		const user = userEvent.setup();
		render(
			<AuthProvider>
				<MemoryRouter>
					<SettingsContext.Provider
						value={{
							busy: false,
							run: async (fn) => { try { await fn(); } catch (e) { failed.push((e as Error).message); } },
							notify: () => {},
							fail: () => {},
						}}
					>
						<PeopleSettings />
					</SettingsContext.Provider>
				</MemoryRouter>
			</AuthProvider>,
		);

		await choose(user, "Make admin");
		await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));
		await waitFor(() => expect(failed).toEqual(["That didn't work. Try again."]));
	});
});
