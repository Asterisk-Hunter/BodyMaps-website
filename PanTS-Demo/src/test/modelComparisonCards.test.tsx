import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// "pro" so the plan-aware default effect settles on ePAI; the comparison
// section is still shown until the user actively picks.
const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

describe("Additional info model details", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/auth/me")) return json({ user: USER });
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());
  const renderPage = async () => {
    render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
    await screen.findByRole("button", { name: "ePAI", exact: true }, { timeout: 5000 });
  };

  it("keeps model facts in a compact Additional info dialog instead of a separate comparison section", async () => {
    const user = userEvent.setup(); await renderPage();
    expect(screen.queryByText(/Compare available models/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Additional info/ }));
    const dialog = screen.getByRole("dialog", { name: "ePAI" });
    expect(within(dialog).getByText(/Full abdominal organ segmentation/)).toBeInTheDocument();
    expect(within(dialog).getByText("25 structures in one pass")).toBeInTheDocument();
    expect(within(dialog).getByText("Pancreas gland, duct, and 3 tumor subtypes (PDAC, cyst, PNET)")).toBeInTheDocument();
    expect(within(dialog).getByText("Abdominal")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Additional info/ })).toHaveFocus();
  });

  it("updates the retained facts when the real model picker changes", async () => {
    const user = userEvent.setup(); await renderPage();
    await user.click(screen.getByRole("button", { name: "ePAI", exact: true }));
    await user.click(within(document.getElementById("segmentation-options")!).getByText("Atlas-Net", { exact: true }));
    await user.click(screen.getByRole("button", { name: /Additional info/ }));
    const dialog = screen.getByRole("dialog", { name: "Atlas-Net" });
    expect(within(dialog).getByText("Matches segmentations to a known anatomical atlas")).toBeInTheDocument();
    expect(within(dialog).getByText("25 structures in one pass, with the same coverage based on nnU-Net as ePAI")).toBeInTheDocument();
    expect(within(dialog).queryByText("25 structures in one pass", { exact: true })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close additional info" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
