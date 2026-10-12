import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HistorySettings from "../routes/Settings/HistorySettings";
import { loadRecentUploads, persistRecentUploads, setRecentUploadsAccount, type RecentUpload } from "../helpers/recentUploads";

const Location = () => <output aria-label="Viewer route">{useLocation().pathname}</output>;
const mount = (path = "/account/history") => render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/account/history" element={<HistorySettings />} />
  <Route path="/session/:id" element={<Location />} />
  <Route path="/reconstruction/:id" element={<Location />} />
</Routes></MemoryRouter>);
const scan = (id: string, patch: Partial<RecentUpload> = {}): RecentUpload => ({
  sessionId: id, label: id, model: "ePAI", status: "Completed", timestamp: Date.now(), ...patch,
});
beforeEach(() => { localStorage.clear(); setRecentUploadsAccount("owner-a"); });
afterEach(() => setRecentUploadsAccount(null));

describe("History sidebar destinations", () => {
  it("opens every completed scan in an archived mixed-status batch", async () => {
    const user = userEvent.setup();
    const batch = { batchId: "batch-a", batchLabel: "Archived batch", timestamp: Date.now() - 172800000 };
    persistRecentUploads([
      scan("failed-first", { ...batch, status: "Failed" }),
      scan("completed-second", batch),
      scan("reconstruction-third", { ...batch, isReconstruction: true }),
    ]);
    mount("/account/history?batch=batch-a");
    const details = screen.getByRole("region", { name: "Archived batch scans" });
    expect(within(details).queryByRole("button", { name: "View failed-first" })).not.toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "View completed-second" })).toBeInTheDocument();
    await user.click(within(details).getByRole("button", { name: "View reconstruction-third" }));
    expect(screen.getByLabelText("Viewer route")).toHaveTextContent("/reconstruction/reconstruction-third");
    expect(loadRecentUploads().find((entry) => entry.sessionId === "reconstruction-third")?.viewed).toBe(true);
  });

  it("includes a selected recent batch without marking its scans as viewed", () => {
    persistRecentUploads([scan("recent-result", { batchId: "recent-batch", batchLabel: "Recent batch" })]);
    mount("/account/history?batch=recent-batch");
    expect(screen.getByRole("region", { name: "Recent batch scans" })).toBeInTheDocument();
    expect(loadRecentUploads()[0].viewed).toBeUndefined();
  });

  it("shows a selected recent failed run and removes it without a stale deep link", async () => {
    const user = userEvent.setup();
    persistRecentUploads([scan("recent-failure", { status: "Failed" })]);
    mount("/account/history?session=recent-failure");
    expect(screen.getByText("recent-failure")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  });

  it("reports missing or other-account run identifiers without exposing their history", () => {
    persistRecentUploads([scan("other-scan", { batchId: "other-batch", batchLabel: "Private batch" })], "owner-b");
    mount("/account/history?batch=other-batch");
    expect(screen.getByRole("status")).toHaveTextContent("no longer available");
    expect(screen.queryByText("Private batch")).not.toBeInTheDocument();
  });
});
