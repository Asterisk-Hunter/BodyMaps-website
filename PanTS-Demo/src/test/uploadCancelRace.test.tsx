import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import { loadRecentUploads, recentUploadsStorageKey, type RecentUpload } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Cancel takes a run out of the line or aborts its upload, but a run only has
// a controller or a place in the line once its turn is queued. Before that
// there are awaits (writing the resumable copy to IndexedDB, asking whether
// another tab carries the session) during which the card already shows Cancel.
// A Cancel pressed then used to be forgotten: the card said Cancelled, and the
// upload started and dispatched a scan anyway.

// jsdom has no IndexedDB, so the resumable-upload store is faked. Writing a
// copy waits on saveGate, which stands in for a large file taking its time.
const store = vi.hoisted(() => ({
  pending: [] as PendingUpload[],
  saveGate: null as Promise<void> | null,
}));
vi.mock("../helpers/pendingUploads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/pendingUploads")>();
  return {
    ...actual,
    loadPendingUploads: vi.fn(async () => store.pending),
    deletePendingUpload: vi.fn(async (sid: string) => {
      store.pending = store.pending.filter((p) => p.sessionId !== sid);
    }),
    savePendingUpload: vi.fn(async (p: PendingUpload) => {
      await store.saveGate;
      store.pending = [...store.pending.filter((q) => q.sessionId !== p.sessionId), p];
      return true;
    }),
    setPendingNextChunk: vi.fn(async () => {}),
    setPendingUploaded: vi.fn(async () => {}),
  };
});

// Nor does it have navigator.locks. Requests wait on lockGate before they are
// answered (nobody else holds a lock in these tests), which stands in for the
// time the browser takes to say so.
let lockGate: Promise<void> | null = null;

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
/** While set, chunk uploads are refused, as when the server rejects a file. */
let refuseChunks = false;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

let openSave: () => void;
let openLock: () => void;

beforeEach(() => {
  calls = [];
  refuseChunks = false;
  store.pending = [];
  store.saveGate = null;
  lockGate = null;
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, a: unknown, b?: (lock: { name: string } | null) => unknown) => {
        await lockGate;
        const callback = (typeof a === "function" ? a : b)!;
        return callback({ name: _name });
      },
    },
  });
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, sid: sessionOf(init?.body) });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      return refuseChunks ? json({ error: "Refused" }, false, 400) : json({ ok: true });
    }
    if (u.includes("/api/upload-status")) return json({ next_chunk: 0 });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) return json({ message: "Segmentation started" });
    if (u.includes("/api/inference-status/")) return json({ status: "queued", queue_position: 1 });
    if (u.includes("/api/cancel-inference/")) return json({ error: "No such run" }, false, 404);
    if (u.includes("/api/discard-upload/")) return json({ status: "discarded" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openSave?.();
  openLock?.();
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
});

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const settledSignedIn = () => screen.findByRole("button", { name: /^ePAI$/ });

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

const recent = () => loadRecentUploads("u1");
const statusOf = (sid: string) => recent().find((u) => u.sessionId === sid)?.status;

const cardOf = (label: string) => screen.getByRole("article", { name: `Run: ${label}` });

/** Nothing about the cancelled run went on the wire after the point given. */
const expectNothingSentSince = (before: number) => {
  const later = calls.slice(before);
  expect(later.filter((c) => /upload-inference-chunk|finalize-upload|run-epai-inference/.test(c.url))).toEqual([]);
};

/** A half-sent upload from an earlier visit, which the page resumes once the lock check answers. */
const seedResumableRun = () => {
  localStorage.setItem(
    recentUploadsStorageKey("u1"),
    JSON.stringify([
      { sessionId: "sid-r", label: "Scan R", model: "ePAI", status: "Processing", timestamp: Date.now() },
    ] satisfies RecentUpload[]),
  );
  store.pending = [
    {
      sessionId: "sid-r",
      file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
      filename: "sid-r.nii.gz",
      model: "ePAI",
      bdmapId: "",
      totalChunks: 2,
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    },
  ];
  lockGate = new Promise((resolve) => {
    openLock = resolve;
  });
};

describe("cancelling a run before it has a place in the upload line", () => {
  it("stops a run still saving its resumable copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    refuseChunks = true;
    const page = renderUpload();
    await settledSignedIn();
    // The background upload of the picked file is refused, so Run starts a
    // fresh run for it instead of handing that upload on.
    const input = page.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    expect(await screen.findByText(/scan\.nii\.gz could not be uploaded/)).toBeInTheDocument();
    refuseChunks = false;

    store.saveGate = new Promise((resolve) => {
      openSave = resolve;
    });
    await user.click(screen.getByRole("button", { name: "Run" }));
    const card = await screen.findByRole("article", { name: /^Run: / });
    const sid = recent()[0].sessionId;
    const before = calls.length;

    // The copy is still being written: no controller, no place in the line.
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(statusOf(sid)).toBe("Cancelled");
    openSave();
    await flush();
    await flush();

    expectNothingSentSince(before);
    expect(statusOf(sid)).toBe("Cancelled");
    // The copy the late write left behind is gone too, so it cannot be resumed.
    expect(store.pending.map((p) => p.sessionId)).not.toContain(sid);
  });

  it("stops a run resumed after another tab was asked whether it carries it", async () => {
    const user = userEvent.setup();
    seedResumableRun();
    renderUpload();
    await settledSignedIn();
    const card = cardOf("Scan R");
    const before = calls.length;

    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(statusOf("sid-r")).toBe("Cancelled");
    // The lock check answers, and the resume goes on with the record it read
    // before the cancel.
    openLock();
    await flush();
    await flush();

    expectNothingSentSince(before);
    expect(statusOf("sid-r")).toBe("Cancelled");
  });

  it("asks the server to delete the file of an upload that finished before it was cancelled", async () => {
    seedResumableRun();
    // Fully uploaded, with only the dispatch left: the file is already on the server.
    store.pending = store.pending.map((p) => ({ ...p, file: new Blob(), uploadedFilename: "ct.nii.gz" }));
    renderUpload();
    await settledSignedIn();
    const before = calls.length;

    // Another tab cancelled it, without a word to this one but the card.
    localStorage.setItem(
      recentUploadsStorageKey("u1"),
      JSON.stringify(recent().map((u) => ({ ...u, status: "Cancelled" }))),
    );
    openLock();
    await flush();
    await flush();

    expectNothingSentSince(before);
    expect(callsTo("/api/discard-upload/", "sid-r")).toHaveLength(1);
  });

  it("stays cancelled after its card is removed from the list", async () => {
    const user = userEvent.setup();
    seedResumableRun();
    renderUpload();
    await settledSignedIn();
    const before = calls.length;

    await user.click(within(cardOf("Scan R")).getByRole("button", { name: "Cancel" }));
    await user.click(within(cardOf("Scan R")).getByRole("button", { name: "Remove" }));
    expect(statusOf("sid-r")).toBeUndefined();
    openLock();
    await flush();
    await flush();

    expectNothingSentSince(before);
  });

  it("stays cancelled when another tab announces it and the card is not touched", async () => {
    seedResumableRun();
    const otherTab = new BroadcastChannel("bodymaps-upload-cancel");
    renderUpload();
    await settledSignedIn();
    const before = calls.length;

    otherTab.postMessage({ sid: "sid-r", ownerId: "u1" });
    await flush();
    otherTab.close();
    openLock();
    await flush();
    await flush();

    expectNothingSentSince(before);
  });
});
