import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real app, workspace shell, footer and contact page; only the heavy or
// unrelated routes are stubbed. fetch is stubbed too, so nothing reaches the
// form service.
vi.mock("../helpers/curatedCache", () => ({ warmCuratedCache: vi.fn() }));
vi.mock("../helpers/analytics", () => ({ track: vi.fn() }));
vi.mock("../components/AnalyticsRouteTracker", () => ({ default: () => null }));
vi.mock("../routes/UploadPage", () => ({ default: () => <h1>Workspace feature</h1> }));
vi.mock("../routes/Homepage", () => ({ default: () => <h1>Dataset feature</h1> }));
vi.mock("../routes/VisualizationPage", () => ({ default: () => <h1>Viewer feature</h1> }));
import App from "../App";

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const mount = (path: string) => {
  window.history.replaceState({}, "", path);
  return render(<App />);
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.includes("/api/auth/me")) return json({ error: "Authentication required" }, 401);
    if (path.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
    return json({});
  });
});

describe("contact route", () => {
  it("opens for a signed-out visitor inside the workspace shell, without a sign-in wall", async () => {
    mount("/contact");
    const heading = await screen.findByRole("heading", { level: 1, name: "Get in touch." });
    // No forced sign-in card: /contact is public like the Team and legal pages.
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The shell's own landmarks hold the page: its main, its navigation, its footer.
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "workspace-content");
    expect(main).toContainElement(heading);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Team" })).toHaveAttribute("href", "/team");
    const footer = screen.getByRole("contentinfo");
    expect(footer.parentElement).toHaveClass("design-footer");
    const contact = within(footer).getByRole("link", { name: "our contact form" });
    expect(contact).toHaveAttribute("href", "/contact");
    expect(contact).toHaveAttribute("target", "_blank");
    expect(document.title).toBe("Contact | BodyMaps");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("formspree"))).toBe(false);
  });

  it("asks for sign-in only when the visitor chooses to", async () => {
    const user = userEvent.setup();
    mount("/contact");
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in" });
    expect(dialog).toBeInTheDocument();
    // The popup can be dismissed here, unlike the card on a signed-in-only page.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Get in touch." })).toBeInTheDocument();
  });
});
