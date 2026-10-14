import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import { loadRecentUploads, recentUploadsStorageKey } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Leaving /upload unmounts the page but not its uploads: they carry on in the
// old page's closures. Coming back mid-transfer must not start the same session
// a second time (two copies racing to finalize), nor poll for a job that does
// not exist yet (three misses and the card went Failed while the first page was
// still uploading), and the page that is showing is the only one that polls.

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

type Call = { url: string; sid: string; signal?: AbortSignal | null };
let calls: Call[] = [];
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;
/** Sessions the server has a job for; any other one is not_found. */
let dispatched: Set<string>;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {
  calls = [];
  dispatched = new Set();
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);
    calls.push({ url: u, sid, signal: init?.signal });
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
    if (u.includes("/api/run-epai-inference")) {
      dispatched.add(sid);
      return json({ message: "Segmentation started" });
    }
    if (u.includes("/api/inference-status/")) {
      const polled = u.split("/").pop()!;
      return dispatched.has(polled)
        ? json({ status: "queued", queue_position: 1 })
        : json({ status: "not_found" }, false, 404);
    }
    if (u.includes("/api/cancel-inference/")) return json({ status: "cancelled" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  // Let anything a test left waiting finish, then drop the mocks.
  openGate();
  vi.restoreAllMocks();
});

// Leaving /upload keeps the signed-in session (and so the account the uploads
// belong to); only the page goes away.
const Shell = ({ onUpload }: { onUpload: boolean }) => (
  <AuthProvider>
    <MemoryRouter>{onUpload ? <UploadPage /> : <p>Somewhere else</p>}</MemoryRouter>
  </AuthProvider>
);

const settledSignedIn = () => screen.findByRole("button", { name: /^ePAI$/ });

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

const statusOf = (sid: string) => loadRecentUploads("u1").find((u) => u.sessionId === sid)?.status;

/** Picks a two-chunk file, waits for its first chunk to be on the wire (the first
 * one goes alone, the rest follow once it has answered), presses Run. */
const runAPreUpload = async (container: HTMLElement) => {
  const user = userEvent.setup();
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
  await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(1));
  const sid = callsTo("/api/upload-inference-chunk")[0].sid;
  await user.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(statusOf(sid)).toBe("Processing"));
  return sid;
};

describe("leaving /upload mid-transfer and coming back", () => {
  it("does not start a resumable upload a second time, and picks up its outcome", async () => {
    const sid = "sid-resuming";
    localStorage.setItem(
      recentUploadsStorageKey("u1"),
      JSON.stringify([{ sessionId: sid, label: "Scan", model: "ePAI", status: "Processing", timestamp: Date.now() }]),
    );
    store.pending = [{
      sessionId: sid,
      file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
      filename: "a.nii.gz",
      model: "ePAI",
      bdmapId: "",
      totalChunks: 2,
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    }];

    // The page resumes the upload; its first chunk is on the wire.
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(1));

    // Leave and come back while they are still going.
    view.rerender(<Shell onUpload={false} />);
    view.rerender(<Shell onUpload />);
    await settledSignedIn();
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(1);
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);
    expect(screen.getByText("Uploading your scan")).toBeInTheDocument();

    // The first copy finishes: one finalize, one dispatch, and the page that is
    // showing now follows the job it created.
    openGate();
    expect(await screen.findByText("Number 1 in the GPU queue")).toBeInTheDocument();
    await flush();
    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(2);
    expect(callsTo("/api/finalize-upload", sid)).toHaveLength(1);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1);
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
    expect(statusOf(sid)).toBe("Processing");
  });

  it("waits for a pre-upload that Run handed on instead of polling a job that isn't there yet", async () => {
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    const sid = await runAPreUpload(view.container);

    view.rerender(<Shell onUpload={false} />);
    view.rerender(<Shell onUpload />);
    await settledSignedIn();
    await flush();
    await flush();

    // Nothing asked the server about a job it doesn't have yet.
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);
    expect(statusOf(sid)).toBe("Processing");

    openGate();
    expect(await screen.findByText("Number 1 in the GPU queue")).toBeInTheDocument();
    await flush();
    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(2);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1);
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
    expect(statusOf(sid)).toBe("Processing");
  });

  it("does not poll for a job the earlier page dispatches while no page is showing", async () => {
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    const sid = await runAPreUpload(view.container);

    // Leave, and let the bytes land while no /upload page is mounted: the
    // earlier page's closures finalize and dispatch on their own.
    view.rerender(<Shell onUpload={false} />);
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1));
    await flush();
    await flush();

    // Nobody is looking at the job, so nothing asks about it.
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);

    // Coming back picks the job up, and exactly one poller asks about it.
    view.rerender(<Shell onUpload />);
    expect(await screen.findByText("Number 1 in the GPU queue")).toBeInTheDocument();
    await flush();
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
  });

  it("lets Cancel on the returned page stop the upload the earlier page started", async () => {
    const user = userEvent.setup();
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    const sid = await runAPreUpload(view.container);
    const inFlight = callsTo("/api/upload-inference-chunk", sid);

    view.rerender(<Shell onUpload={false} />);
    view.rerender(<Shell onUpload />);
    await settledSignedIn();
    const card = await screen.findByRole("article", { name: /^Run: / });
    await user.click(within(card).getByRole("button", { name: "Cancel" }));

    expect(inFlight.every((c) => c.signal?.aborted)).toBe(true);
    await flush();
    expect(statusOf(sid)).toBe("Cancelled");
    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(inFlight.length);
    expect(callsTo("/api/finalize-upload", sid)).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(0);
  });

  it("keeps saying the tab is needed, and warns before unload, while the earlier page is still sending", async () => {
    const view = render(<Shell onUpload />);
    await settledSignedIn();
    // A pre-upload has no IndexedDB copy, so closing the tab would lose it.
    await runAPreUpload(view.container);

    view.rerender(<Shell onUpload={false} />);
    view.rerender(<Shell onUpload />);
    await settledSignedIn();

    // The close note refreshes once a second.
    expect(await screen.findByText(/keep tab open/, {}, { timeout: 2500 })).toBeInTheDocument();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    // Once the bytes land the tab is free again. The warning comes off in an
    // effect's cleanup, which can trail the text it is derived from, so it is
    // asked again until it has gone.
    openGate();
    await waitFor(() => {
      const after = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    }, { timeout: 2500 });
  });
});
