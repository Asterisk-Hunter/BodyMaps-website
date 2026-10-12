import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesignShell from "../components/DesignShell";
vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ isAuthenticated: true }) }));

vi.mock("../components/AuthButton", () => ({ default: () => <button type="button">Account</button> }));
vi.mock("../components/WorkspaceTour", () => ({ default: () => null }));
vi.mock("../components/SiteFooter", () => ({ default: () => null }));
beforeEach(() => { localStorage.clear(); });

describe("mobile workspace route focus", () => {
  it("moves focus into the destination page when navigation closes the drawer", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={["/dashboard"]}>
      <Routes><Route element={<DesignShell />}>
        <Route path="/dashboard" element={<h1>CT library</h1>} />
        <Route path="/team" element={<h1>Meet our team</h1>} />
      </Route></Routes>
    </MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("link", { name: "Team" }));

    expect(screen.getByRole("heading", { name: "Meet our team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("main")).toHaveFocus();
  });
});
