import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { recentUploadsStorageKey, setRecentUploadsAccount } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

const userAccount = { id: "paging-user", email: "paging@example.com", plan: "pro", roles: [] };
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => "application/json" } }) as Response;
beforeEach(() => {
  localStorage.clear(); setRecentUploadsAccount(null);
  localStorage.setItem(recentUploadsStorageKey(userAccount.id), JSON.stringify(["Newest scan", "Second scan", "Third scan"].map((label, index) => ({
    sessionId: `scan-${index}`, label, model: "ePAI", status: "Completed", timestamp: Date.now() - index * 1000,
  }))));
  global.fetch = vi.fn(async (url) => String(url).includes("/api/auth/me") ? json({ user: userAccount }) : json({ items: [], jobs: [] }));
});
const show = () => render(<AuthProvider><MemoryRouter initialEntries={["/upload"]}><Routes>
  <Route path="/upload" element={<UploadPage />} /><Route path="/account/history" element={<h1>Account history</h1>} />
  <Route path="/session/:id" element={<h1>Result viewer</h1>} />
</Routes></MemoryRouter></AuthProvider>);

describe("compact workspace run selection", () => {
  it("renders one recent run at a time while keeping every result reachable", async () => {
    const user = userEvent.setup(); show();
    expect(await screen.findByRole("article", { name: "Run: Newest scan" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByLabelText("Current run")).toHaveValue("scan-0");
    expect(screen.getByRole("button", { name: "Previous run" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next run" }));
    expect(screen.getByRole("article", { name: "Run: Second scan" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("Current run"), "scan-2");
    expect(screen.getByRole("article", { name: "Run: Third scan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next run" })).toBeDisabled();
    await user.click(within(screen.getByRole("region", { name: "Current runs" })).getByRole("button", { name: "View", exact: true }));
    expect(screen.getByRole("heading", { name: "Result viewer" })).toBeInTheDocument();
  });

  it("keeps rename, remove, and History functional for the selected run", async () => {
    const user = userEvent.setup(); show();
    await screen.findByRole("article", { name: "Run: Newest scan" });
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const name = screen.getByRole("textbox", { name: "Run name" });
    await user.clear(name); await user.type(name, "Reviewed scan{Enter}");
    await waitFor(() => expect(screen.getByRole("article", { name: "Run: Reviewed scan" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove", exact: true }));
    expect(screen.getByRole("article", { name: "Run: Second scan" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "History", exact: true }));
    expect(screen.getByRole("heading", { name: "Account history" })).toBeInTheDocument();
  });
});
