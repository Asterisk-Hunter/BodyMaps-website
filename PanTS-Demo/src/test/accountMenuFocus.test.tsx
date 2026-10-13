// The account control's focus and session handling: where keyboard focus goes
// when signing in or out swaps one control for the other, the menu closing when
// the session ends under it, Escape in the menu staying out of the phone
// drawer around it, and an avatar initial that is a whole character.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthButton from "../components/AuthButton";
import AuthModal from "../components/AuthModal";
import DesignShell from "../components/DesignShell";
import { AuthProvider } from "../contexts/authContext";
import { nameInitial } from "../liveRooms/composerHelpers";

vi.mock("../components/WorkspaceTour", () => ({ default: () => null }));
vi.mock("../components/SiteFooter", () => ({ default: () => <footer>Site footer</footer> }));

const USER = { id: "u1", email: "researcher@example.com", name: "Researcher", roles: [] as string[] };
const json = (body: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => body, text: async () => "", headers: { get: () => "application/json" } }) as unknown as Response;

let signedIn = true;
let apiUser: typeof USER = USER;
beforeEach(() => {
	localStorage.clear();
	signedIn = true;
	apiUser = USER;
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return signedIn ? json({ user: apiUser }) : json({ user: null }, 401);
		if (u.includes("/api/auth/login")) {
			signedIn = true;
			return json({ user: apiUser });
		}
		if (u.includes("/api/auth/logout")) {
			signedIn = false;
			return json({ ok: true });
		}
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({});
	}) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const mountSidebar = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AuthButton variant="sidebar" />
				<AuthModal />
			</MemoryRouter>
		</AuthProvider>,
	);

describe("account control focus hand-offs", () => {
	it("puts focus on the account trigger after signing in from the popup", async () => {
		signedIn = false;
		const user = userEvent.setup();
		mountSidebar();
		await user.click(await screen.findByRole("button", { name: "Sign in" }));
		await user.click(await screen.findByRole("button", { name: "Continue with email" }));
		await user.type(screen.getByLabelText(/^Email$/i), USER.email);
		await user.type(screen.getByLabelText(/^Password$/i), "hunter2hunter2");
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		// The dialog disappears during commit; the focus hand-off follows in an effect.
		await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus());
	});

	it("puts focus on the Sign in button after signing out from the menu", async () => {
		const user = userEvent.setup();
		mountSidebar();
		await user.click(await screen.findByRole("button", { name: "Settings" }));
		await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

		const signIn = await screen.findByRole("button", { name: "Sign in" });
		await waitFor(() => expect(signIn).toHaveFocus());
	});
});

describe("account menu and the session", () => {
	it("closes when the session ends while it is open, so the next sign-in does not reopen it", async () => {
		const user = userEvent.setup();
		mountSidebar();
		await user.click(await screen.findByRole("button", { name: "Settings" }));
		expect(screen.getByRole("menu")).toBeInTheDocument();

		signedIn = false;
		act(() => window.dispatchEvent(new Event("bodymaps:session-expired")));
		expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();

		// Signed in again in another tab.
		signedIn = true;
		await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "signed-in" })));
		expect(await screen.findByRole("button", { name: "Settings" })).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("shows a whole first character as the avatar initial", async () => {
		expect(nameInitial("\u{1D49C}da")).toBe("\u{1D49C}");
		expect(nameInitial("ada")).toBe("A");
		expect(nameInitial("")).toBe("?");

		apiUser = { ...USER, name: "\u{1D49C}da Lovelace" };
		const user = userEvent.setup();
		mountSidebar();
		await user.click(await screen.findByRole("button", { name: "Settings" }));
		expect(within(screen.getByRole("menu")).getByText("\u{1D49C}")).toBeInTheDocument();
	});
});

describe("account menu inside the phone drawer", () => {
	it("closes only the menu on Escape, then the drawer on the next Escape", async () => {
		const user = userEvent.setup();
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/team"]}>
					<Routes>
						<Route element={<DesignShell />}>
							<Route path="*" element={<p>Team page</p>} />
						</Route>
					</Routes>
				</MemoryRouter>
			</AuthProvider>,
		);
		const opener = screen.getByRole("button", { name: "Open navigation" });
		await user.click(opener);
		expect(opener).toHaveAttribute("aria-expanded", "true");

		const trigger = await screen.findByRole("button", { name: "Settings" });
		await user.click(trigger);
		expect(screen.getByRole("menu")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(opener).toHaveAttribute("aria-expanded", "true");
		expect(trigger).toHaveFocus();

		await user.keyboard("{Escape}");
		expect(opener).toHaveAttribute("aria-expanded", "false");
		expect(opener).toHaveFocus();
	});
});
