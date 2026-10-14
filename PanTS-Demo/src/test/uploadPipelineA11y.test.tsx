import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";
import { setRecentUploadsAccount } from "../helpers/recentUploads";

// Screen reader and keyboard details of the upload page's pipeline row and admin coupon
// form. None of them changes what a mouse user sees or does.

const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "free" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let couponResponse: ReturnType<typeof json> | null = null;

beforeEach(() => {
  couponResponse = null;
  localStorage.clear();
  setRecentUploadsAccount(null);
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/auth/redeem-admin-coupon")) {
      // A browser drops focus from a control that becomes disabled; jsdom keeps it,
      // so do what the browser does while the code is being checked.
      (document.activeElement as HTMLElement | null)?.blur();
      return couponResponse ?? json({ error: "That coupon is not valid." }, false, 403);
    }
    if (u.includes("/api/me/usage")) {
      return json({
        plan: "free",
        limits: { daily_scans: 1 },
        scans: { used: 0, limit: 3, in_flight: 0, resets_at: null },
        ai_messages: { used: 0, limit: 10, resets_at: null },
      });
    }
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/upload"]}>
        <Routes>
          <Route path="/upload" element={<UploadPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );

const settled = () =>
  waitFor(() => expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument());

const openModelMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: /LesionSegmenter/ }));
  return document.getElementById("segmentation-options") as HTMLElement;
};

const modelRow = (menu: HTMLElement, name: string) =>
  Array.from(menu.querySelectorAll<HTMLElement>(':scope > [role="button"]')).find(
    (row) => row.querySelector(".model-dropdown-item-name")?.textContent === name,
  )!;

describe("admin coupon form", () => {
  it("says whether the coupon form is open and which form the toggle opens", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    const toggle = screen.getByRole("button", { name: /Have an admin access coupon/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const form = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(form?.tagName).toBe("FORM");
    expect(form).toContainElement(screen.getByLabelText("Access coupon"));
  });

  it("puts focus back in the input when a code typed and sent with Enter is refused", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByRole("button", { name: /Have an admin access coupon/i }));
    await user.type(screen.getByLabelText("Access coupon"), "wrong-code{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("That coupon is not valid.");
    await waitFor(() => expect(screen.getByLabelText("Access coupon")).toHaveFocus());
  });

  it("leaves focus where it was when a refused code was sent with the mouse", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByRole("button", { name: /Have an admin access coupon/i }));
    await user.type(screen.getByLabelText("Access coupon"), "wrong-code");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That coupon is not valid.");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps focus in the open model menu when a code sent with Enter is granted", async () => {
    couponResponse = json({ ok: true, access: "admin_coupon", user: { ...USER, plan: "enterprise" } });
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByRole("button", { name: /Have an admin access coupon/i }));
    await user.type(screen.getByLabelText("Access coupon"), "valid-admin-code{Enter}");

    expect(await screen.findByText("Sponsored access enabled. All models are now available.")).toBeInTheDocument();
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("role")).toBe("button");
      expect(active.closest("#segmentation-options")).not.toBeNull();
    });
    expect(screen.queryByText("Donate")).not.toBeInTheDocument();
  });
});

describe("pipeline row", () => {
  it("hides the step numbers from screen readers and says the stage pickers open menus", async () => {
    renderUpload();
    await settled();
    const badges = document.querySelectorAll(".pipeline-badge");
    expect(badges).toHaveLength(3);
    badges.forEach((badge) => expect(badge).toHaveAttribute("aria-hidden", "true"));
    for (const stage of ["Preprocessing", "Postprocessing"]) {
      expect(screen.getByRole("button", { name: `${stage}: None (skip)` })).toHaveAttribute("aria-haspopup", "menu");
    }
  });

  it("marks the chosen model row as the current one", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    const menu = await openModelMenu(user);
    expect(modelRow(menu, "LesionSegmenter")).toHaveAttribute("aria-current", "true");
    for (const name of ["None", "ePAI"]) {
      const row = modelRow(menu, name);
      if (row) expect(row).not.toHaveAttribute("aria-current");
    }
    expect(menu.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it.each([["Enter", "{Enter}"], ["Space", " "], ["ArrowRight", "{ArrowRight}"]])("moves from the LesionSegmenter row into its lesions with %s", async (_label, key) => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    const menu = await openModelMenu(user);
    const row = modelRow(menu, "LesionSegmenter");
    row.focus();
    await user.keyboard(key);

    const checked = within(row).getByRole("menuitemradio", { name: "Pancreatic lesion" });
    expect(checked).toHaveAttribute("aria-checked", "true");
    expect(checked).toHaveFocus();
    // Moving in picks nothing and keeps the menu open.
    expect(document.getElementById("segmentation-options")).toBeInTheDocument();
  });
});
