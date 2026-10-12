import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";
import {
  RECENT_UPLOADS_KEY, RECENT_UPLOADS_MIGRATED, setRecentUploadsAccount,
} from "../helpers/recentUploads";

vi.mock("../helpers/pendingUploads", () => ({
  loadPendingUploads: vi.fn(async () => []),
  deletePendingUpload: vi.fn(), savePendingUpload: vi.fn(),
  setPendingNextChunk: vi.fn(), setPendingUploaded: vi.fn(),
  chunkSizeOf: vi.fn(),
}));

beforeEach(() => { localStorage.clear(); setRecentUploadsAccount(null); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("resumes an owned legacy run when verification finishes after the workspace mounts", async () => {
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(["owned", "someone-else"].map((sessionId) => ({
    sessionId, label: sessionId, model: "ePAI", status: "Processing", timestamp: Date.now(),
  }))));
  let finishOwnership!: (value: Response) => void;
  const ownership = new Promise<Response>((resolve) => { finishOwnership = resolve; });
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.includes("/api/auth/me")) return json({ user: { id: "a", email: "a@example.com", plan: "pro" } });
    if (url.includes("/api/me/jobs")) return ownership;
    if (url.includes("/api/inference-status/")) return json({ status: "complete" });
    return json({ items: [], total: 0, ids: [] });
  }));
  const view = render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
  // Auth restoration and the plan-aware default both settle asynchronously.
  // Keep the ownership assertions below strict without depending on host load.
  await screen.findByRole("button", { name: /^ePAI$/ }, { timeout: 5000 });
  await waitFor(() => expect(requests.some((url) => url.endsWith("/api/me/jobs"))).toBe(true));
  expect(requests.some((url) => url.includes("/api/inference-status/"))).toBe(false);

  await act(async () => { finishOwnership(json({ user_id: "a", jobs: [{ session_id: "owned" }] })); });
  await waitFor(() => expect(requests.some((url) => url.endsWith("/api/inference-status/owned"))).toBe(true));
  expect(requests.some((url) => url.includes("inference-status/someone-else"))).toBe(false);
  // A repeated or foreign migration notification must not start another poller.
  await act(async () => {
    window.dispatchEvent(new CustomEvent(RECENT_UPLOADS_MIGRATED, { detail: { ownerId: "b", sessionIds: ["someone-else"] } }));
    window.dispatchEvent(new CustomEvent(RECENT_UPLOADS_MIGRATED, { detail: { ownerId: "a", sessionIds: ["owned"] } }));
  });
  expect(requests.filter((url) => url.endsWith("/api/inference-status/owned"))).toHaveLength(1);
  view.unmount();
});
