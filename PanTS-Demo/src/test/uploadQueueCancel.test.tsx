import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import { loadRecentUploads, recentUploadsStorageKey, type RecentUpload } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Files upload one at a time, so every scan after the first waits its turn
// ("Waiting to upload"). Cancelling one that is still waiting has to take it
// out of the line: it used to be marked Cancelled and then start uploading
// anyway once the file in front of it was done, and its unsent bytes kept the
// "safe to close" line saying to keep the tab open.

// jsdom has no IndexedDB, so the resumable-upload store is faked.
const store = vi.hoisted(() => ({ pending: [] as PendingUpload[] }));
vi.mock("../helpers/pendingUploads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/pendingUploads")>();
  return {
    ...actual,
    loadPendingUploads: vi.fn(async () => store.pending),
    deletePendingUpload: vi.fn(async (sid: string) => {
      store.pending = store.pending.filter((p) => p.sessionId !== sid);
    }),
    savePendingUpload: vi.fn(async () => true),
    setPendingNextChunk: vi.fn(async () => {}),
    setPendingUploaded: vi.fn(async () => {}),
  };
});

const CHUNK_SIZE = 512 * 1024;
const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const sessionOf = (body: unknown): string => {
  if (body instanceof FormData) return String(body.get("session_id") ?? "");
  if (body instanceof URLSearchParams) return String(body.get("session_id") ?? "");
  return "";
};

type Call = { url: string; sid: string };
let calls: Call[] = [];
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {
  calls = [];
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, sid: sessionOf(init?.body) });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void gate.then(() => resolve(json({ ok: true })));
      });
    }
    if (u.includes("/api/upload-status")) return json({ next_chunk: 0 });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) return json({ message: "Segmentation started" });
    if (u.includes("/api/inference-status/")) return json({ status: "queued", queue_position: 1 });
    if (u.includes("/api/cancel-inference/")) return json({ error: "No job" }, false, 404);
    if (u.includes("/api/discard-upload/")) return json({ status: "discarded" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openGate();
  vi.restoreAllMocks();
});

// Leaving /upload keeps the signed-in session; only the page goes away.
const Shell = ({ onUpload }: { onUpload: boolean }) => (
  <AuthProvider>
    <MemoryRouter>{onUpload ? <UploadPage /> : <p>Somewhere else</p>}</MemoryRouter>
  </AuthProvider>
);

const settledSignedIn = () => screen.findByRole("button", { name: /^ePAI$/ });

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

const statusOf = (sid: string) => loadRecentUploads("u1").find((u) => u.sessionId === sid)?.status;

/** Two runs a signed-in session left half-sent: the first is next on the wire, the second waits behind it. */
const seedTwoResumableRuns = () => {
  const entry = (sessionId: string, label: string, timestamp: number): RecentUpload => ({
    sessionId,
    label,
    model: "ePAI",
    status: "Processing",
    timestamp,
  });
  const now = Date.now();
  localStorage.setItem(
    recentUploadsStorageKey("u1"),
    JSON.stringify([entry("sid-a", "Scan A", now), entry("sid-b", "Scan B", now - 1)]),
  );
  store.pending = ["sid-a", "sid-b"].map((sessionId) => ({
    sessionId,
    file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
    filename: `${sessionId}.nii.gz`,
    model: "ePAI",
    bdmapId: "",
    totalChunks: 2,
    nextChunk: 0,
    chunkSize: CHUNK_SIZE,
  }));
};

/** Shows one run in the workspace and returns its card. */
const showRun = async (sid: string, label: string) => {
  await userEvent.setup().selectOptions(screen.getByLabelText("Current run"), sid);
  return screen.getByRole("article", { name: `Run: ${label}` });
};

describe("cancelling an upload that is waiting for its turn", () => {
  it("takes it out of the line, so it never starts", async () => {
    const user = userEvent.setup();
    seedTwoResumableRuns();
    render(<Shell onUpload />);
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-a")).toHaveLength(1));
    const waiting = await showRun("sid-b", "Scan B");
    expect(within(waiting).getByText("Waiting to upload")).toBeInTheDocument();

    await user.click(within(waiting).getByRole("button", { name: "Cancel" }));
    expect(statusOf("sid-b")).toBe("Cancelled");

    // The file in front finishes and is dispatched; the line moves on.
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-a")).toHaveLength(1));
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/finalize-upload", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", "sid-b")).toHaveLength(0);
    expect(statusOf("sid-b")).toBe("Cancelled");
    expect(statusOf("sid-a")).toBe("Processing");

    // Its unsent bytes no longer count: nothing is left to keep the tab open for.
    const running = await showRun("sid-a", "Scan A");
    expect(await within(running).findByText("safe to close", {}, { timeout: 2500 })).toBeInTheDocument();
  });

  it("also works from a page mounted after the one that queued it", async () => {
    const user = userEvent.setup();
    seedTwoResumableRuns();
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-a")).toHaveLength(1));

    // The waiting upload is on the earlier page's line; the returned page can
    // still cancel it.
    view.rerender(<Shell onUpload={false} />);
    view.rerender(<Shell onUpload />);
    await settledSignedIn();
    const waiting = await showRun("sid-b", "Scan B");
    await user.click(within(waiting).getByRole("button", { name: "Cancel" }));

    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-a")).toHaveLength(1));
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", "sid-b")).toHaveLength(0);
    expect(statusOf("sid-b")).toBe("Cancelled");
  });
});
