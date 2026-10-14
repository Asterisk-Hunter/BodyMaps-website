import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import { loadRecentUploads, recentUploadsStorageKey } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// What the upload page does when the sign-in it works under is not there: still
// being checked on load, lapsed while a run is being followed, or ended while a
// scan handed to Run is still uploading.

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
    savePendingUpload: vi.fn(async (record: PendingUpload) => {
      store.pending = [...store.pending.filter((p) => p.sessionId !== record.sessionId), record];
      return true;
    }),
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
  text: async () => JSON.stringify(body),
  headers: { get: () => "application/json" },
});

const sessionOf = (body: unknown): string => {
  if (body instanceof FormData) return String(body.get("session_id") ?? "");
  if (body instanceof URLSearchParams) return String(body.get("session_id") ?? "");
  return "";
};

type Call = { url: string; sid: string };
let calls: Call[] = [];
/** What GET /api/auth/me answers; a pending promise keeps the check open. */
let me: () => Promise<unknown>;
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;
let statusReply: (sid: string) => unknown;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {
  calls = [];
  store.pending = [];
  me = async () => json({ user: USER });
  statusReply = () => json({ status: "queued", queue_position: 1 });
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);
    calls.push({ url: u, sid });
    if (u.includes("/api/auth/me")) return me();
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
    if (u.includes("/api/inference-status/")) return statusReply(u.split("/").pop()!);
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openGate();
  vi.restoreAllMocks();
});

const PromptProbe = () => {
  const { authPrompt } = useAuth();
  return authPrompt.open ? <p>Sign-in prompt open</p> : null;
};

const Shell = () => (
  <AuthProvider>
    <MemoryRouter>
      <UploadPage />
      <PromptProbe />
    </MemoryRouter>
  </AuthProvider>
);

const settledSignedIn = () => screen.findByRole("button", { name: /^ePAI$/ });
const flush = () => new Promise((r) => setTimeout(r, 60));
const statusOf = (sid: string) => loadRecentUploads("u1").find((u) => u.sessionId === sid)?.status;

describe("the upload page without a working sign-in", () => {
  it("shows no sign-in banner or prompt while the session check is still answering", async () => {
    let answer!: (reply: unknown) => void;
    me = () => new Promise((resolve) => { answer = resolve; });
    const user = userEvent.setup();
    render(<Shell />);
    await flush();

    expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    expect(screen.queryByText("Sign-in prompt open")).not.toBeInTheDocument();
    expect(callsTo("stage-sample")).toHaveLength(0);

    // Once the check says nobody is signed in, both are back.
    answer(json({ user: null }));
    expect(await screen.findByText(/to run inference/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    expect(screen.getByText("Sign-in prompt open")).toBeInTheDocument();
  });

  it("stops following a run and asks for sign-in when a status check finds the sign-in gone", async () => {
    const sid = "sid-followed";
    localStorage.setItem(
      recentUploadsStorageKey("u1"),
      JSON.stringify([{ sessionId: sid, label: "Scan", model: "ePAI", status: "Processing", timestamp: Date.now() }]),
    );
    statusReply = () => json({ error: "Authentication required" }, false, 401);
    render(<Shell />);

    expect(await screen.findByText("Sign-in prompt open")).toBeInTheDocument();
    expect(await screen.findByText(/to run inference/)).toBeInTheDocument();
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);

    // Past the next poll's time nothing has asked again, and the run is left
    // as it was, to be followed once the account signs in again.
    await new Promise((r) => setTimeout(r, 3000));
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
    expect(statusOf(sid)).toBe("Processing");
  }, 10_000);

  it("keeps a scan handed to Run uploading after the next sign-in when the sign-in ends while it uploads", async () => {
    const user = userEvent.setup();
    const view = render(<Shell />);
    await settledSignedIn();
    const input = view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(1));
    const sid = callsTo("/api/upload-inference-chunk")[0].sid;
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(statusOf(sid)).toBe("Processing"));

    // The sign-in ends mid-upload, which stops the transfer.
    window.dispatchEvent(new Event("bodymaps:session-expired"));
    await waitFor(() => expect(store.pending.find((p) => p.sessionId === sid)).toBeDefined());
    const parked = store.pending.find((p) => p.sessionId === sid)!;
    expect(parked.uploadedFilename).toBeUndefined();
    expect(parked.file.size).toBe(CHUNK_SIZE * 2);
    expect(parked.totalChunks).toBe(2);
    expect(statusOf(sid)).toBe("Processing");
    view.unmount();

    // Signing in again carries the upload on under the same session and runs it.
    openGate();
    render(<Shell />);
    await waitFor(() => expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1));
    expect(callsTo("/api/finalize-upload", sid)).toHaveLength(1);
    expect(await screen.findByText("Number 1 in the GPU queue")).toBeInTheDocument();
    expect(statusOf(sid)).toBe("Processing");
  });
});
