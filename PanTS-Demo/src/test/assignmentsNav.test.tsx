import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesignShell from "../components/DesignShell";
import { setRecentUploadsAccount } from "../helpers/recentUploads";

const auth = vi.hoisted(() => ({ isAuthenticated: true, user: null as null | { id: string; name: string; roles: string[] } }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => auth }));
vi.mock("../components/AuthButton", () => ({ default: () => <button type="button">Account controls</button> }));
vi.mock("../components/WorkspaceTour", () => ({ default: () => null }));
vi.mock("../components/SiteFooter", () => ({ default: () => <footer>Site footer</footer> }));

const mount = () => render(
	<MemoryRouter initialEntries={["/dashboard"]}>
		<Routes><Route element={<DesignShell />}><Route path="*" element={<p>page</p>} /></Route></Routes>
	</MemoryRouter>,
);

beforeEach(() => {
	localStorage.clear();
	setRecentUploadsAccount("u1");
	auth.user = { id: "u1", name: "Rad One", roles: [] };
	auth.isAuthenticated = true;
});

describe("the Projects tab in the side menu", () => {
	it("shows one project destination for any signed-in account", async () => {
		mount();
		const links = await screen.findAllByRole("link", { name: "Projects" });
		expect(links).toHaveLength(1);
		expect(links[0]).toHaveAttribute("href", "/assignment");
		expect(screen.queryByRole("link", { name: "Worklist" })).not.toBeInTheDocument();
	});

	it("does not show projects when signed out", async () => {
		auth.isAuthenticated = false;
		auth.user = null;
		mount();
		await screen.findByText("page");
		expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument();
	});
});
