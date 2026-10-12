// The account control in the nav bar. What it puts on screen is the whole
// point of it: the name once the account has one, the email until then — an
// address is what we have to fall back on, not what anyone wants to see.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthButton from "../components/AuthButton";
import { AuthProvider } from "../contexts/authContext";

const USER = {
	id: "u1",
	email: "test.user@example.com",
	name: null as string | null,
	plan: "free",
};

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	USER.name = null;
	localStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const renderButton = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AuthButton />
			</MemoryRouter>
		</AuthProvider>
	);

describe("the signed-in account control", () => {
	it("shows the name once one is set", async () => {
		USER.name = "Ada Lovelace";
		renderButton();

		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		// The email is still in the dropdown, but the dropdown is closed.
		expect(screen.queryByText("test.user@example.com")).not.toBeInTheDocument();
	});

	it("falls back to the email until there is one", async () => {
		renderButton();

		expect(await screen.findByText("test.user@example.com")).toBeInTheDocument();
	});
});


const Location = () => <output aria-label="Current path">{useLocation().pathname}</output>;
const renderSidebar = (onWalkthrough = vi.fn(), { collapsed = false, scale = 1 } = {}) => render(
    <div className="design-shell" style={{ zoom: scale }}><AuthProvider><MemoryRouter initialEntries={["/dashboard"]}>
        <aside className="design-sidebar"><AuthButton variant="sidebar" collapsed={collapsed} onWalkthrough={onWalkthrough} /></aside><Location />
    </MemoryRouter></AuthProvider></div>
);

describe("sidebar account actions", () => {
    it("opens profile settings and supports keyboard menu navigation", async () => {
        const user = userEvent.setup();
        renderSidebar();
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        expect(screen.getByRole("menuitem", { name: /Profile/ })).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitem", { name: /Walkthrough/ })).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
        await user.click(screen.getByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: /Profile/ }));
        expect(screen.getByLabelText("Current path")).toHaveTextContent("/account");
    });

    it("replays the actual walkthrough callback and closes the menu", async () => {
        const user = userEvent.setup(), walkthrough = vi.fn();
        renderSidebar(walkthrough);
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: /Walkthrough/ }));
        expect(walkthrough).toHaveBeenCalledOnce();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("keeps account identity inside the compact popup without a duplicate sidebar profile row", async () => {
        const user = userEvent.setup();
        USER.name = "Ada Lovelace";
        renderSidebar();
        const trigger = await screen.findByRole("button", { name: "Settings" });
        expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
        expect(screen.queryByText("View your profile")).not.toBeInTheDocument();
        await user.click(trigger);
        expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
        expect(screen.getByText(USER.email)).toBeInTheDocument();
        expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    });

    it.each([false, true])("preserves the shell scale and viewport anchor in the sidebar portal (collapsed=%s)", async (collapsed) => {
        const user = userEvent.setup();
        renderSidebar(vi.fn(), { collapsed, scale: .75 });
        const trigger = await screen.findByRole("button", { name: "Settings" });
        // jsdom does not resolve CSS zoom; model the browser's computed value.
        const computedStyle = window.getComputedStyle;
        vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
            const result = computedStyle(element, pseudo);
            if (element.matches(".design-shell")) Object.defineProperty(result, "zoom", { value: ".75" });
            return result;
        });
        vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 24, right: 204, top: 650, bottom: 680, width: 180, height: 30, x: 24, y: 650, toJSON: () => ({}) });
        await user.click(trigger);
        const menu = screen.getByRole("menu");
        expect(menu.closest(".design-shell")).toBeNull();
        expect(menu.style.zoom).toBe("0.75");
        expect(Number.parseFloat(menu.style.width) * .75).toBe(192);
        expect(Number.parseFloat(menu.style.left) * .75).toBe(collapsed ? 216 : 24);
        expect(Number.parseFloat(menu.style.bottom) * .75).toBeCloseTo(window.innerHeight - (collapsed ? 680 : 650) + (collapsed ? 0 : 8));
        await user.keyboard("{Escape}");
        expect(trigger).toHaveFocus();
    });

    it.each(["observer", "transitionend", "scroll", "resize"])("follows a collapsing sidebar when opened during its animation (%s)", async (event) => {
        let resizeObserved = () => {};
        vi.stubGlobal("ResizeObserver", class {
            constructor(callback: ResizeObserverCallback) { resizeObserved = () => callback([], this as unknown as ResizeObserver); }
            observe() {}
            disconnect() {}
        });
        const user = userEvent.setup();
        renderSidebar(vi.fn(), { collapsed: true });
        const trigger = await screen.findByRole("button", { name: "Settings" });
        const measure = vi.spyOn(trigger, "getBoundingClientRect");
        measure.mockReturnValue(new DOMRect(24, 650, 174, 30));
        await user.click(trigger);
        const menu = screen.getByRole("menu");
        expect(menu.style.left).toBe("210px");

        measure.mockReturnValue(new DOMRect(24, 650, 34, 30));
        if (event === "observer") act(resizeObserved);
        else if (event === "transitionend") fireEvent.transitionEnd(trigger.closest(".design-sidebar")!);
        else if (event === "scroll") fireEvent.scroll(window);
        else fireEvent.resize(window);
        await waitFor(() => expect(menu.style.left).toBe("70px"));
        expect(screen.getByRole("menu")).toBe(menu);
        expect(screen.getByRole("menuitem", { name: /Profile/ })).toHaveFocus();
    });

    it("keeps the popup available for retry when session revocation fails", async () => {
        const user = userEvent.setup();
        const originalFetch = global.fetch;
        global.fetch = vi.fn(async (url, init) => String(url).includes("/api/auth/logout")
            ? { ...json({ error: "unavailable" }), ok: false, status: 503 }
            : originalFetch(url, init)) as typeof fetch;
        renderSidebar();
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't sign out. Check your connection and try again.");
        expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeEnabled();
        expect(screen.getByLabelText("Current path")).toHaveTextContent("/dashboard");
    });

    it("revokes the backend session from the sign-out control", async () => {
        const user = userEvent.setup();
        renderSidebar();
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).includes("/api/auth/logout") && init?.method === "POST")).toBe(true));
        expect(screen.getByLabelText("Current path")).toHaveTextContent("/");
        expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });
});
