import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, Link } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UploadPage from "../routes/UploadPage";
import { setRecentUploadsAccount } from "../helpers/recentUploads";

const auth = vi.hoisted(() => ({
  isAuthenticated: true, promptAuth: vi.fn(), refreshUsage: vi.fn(), redeemAdminCoupon: vi.fn(),
  user: { id: "u1", email: "first@example.com", name: "First", plan: "pro", roles: [] },
}));
vi.mock("../contexts/authContext", () => ({ useAuth: () => auth }));
vi.mock("../helpers/pendingUploads", async () => ({
  ...(await vi.importActual<object>("../helpers/pendingUploads")), loadPendingUploads: async () => [],
}));
const CHUNK_SIZE = 512 * 1024;
const file = (name: string, chunks = 1) => new File([new Uint8Array(CHUNK_SIZE * chunks)], name, { type: "application/gzip" });
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => "", headers: { get: () => "application/json" } }) as Response;
const transfers = () => vi.mocked(fetch).mock.calls.filter(([url]) => /upload-inference-chunk|finalize-upload|run-epai-inference|upload-dicom-slice|finalize-dicom/.test(String(url)));
const standardFetch = async (url: RequestInfo | URL) => {
  if (String(url).includes("finalize-upload")) return json({ uploaded_filename: "scan.nii.gz" });
  if (String(url).includes("inference-status")) return json({ status: "queued" });
  return json({ items: [], total: 0, ids: [], ok: true });
};
const mount = () => render(<MemoryRouter initialEntries={["/upload"]}>
  <Routes><Route path="/upload" element={<><Link to="/elsewhere">Leave upload page</Link><UploadPage /></>} />
    <Route path="/elsewhere" element={<h1>Another feature</h1>} />
    <Route path="/local-nifti" element={<h1>Local viewer</h1>} />
  </Routes></MemoryRouter>);
const pickModel = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("button", { name: /^(ePAI|None \(view scan\))$/ }));
  await user.click(within(document.querySelector<HTMLElement>("#segmentation-options")!).getByText(name, { exact: true }));
};
const selectFiles = async (user: ReturnType<typeof userEvent.setup>, files: File | File[]) => {
  await user.upload(document.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, files);
};
beforeEach(() => {
  localStorage.clear();
  setRecentUploadsAccount("u1");
  global.fetch = vi.fn(standardFetch);
});
afterEach(() => { setRecentUploadsAccount(null); vi.restoreAllMocks(); });

// A held first file leaves a second file queued. It observes AbortSignal like
// fetch does, so cancelling the transfer can drain the serial queue in tests.
const holdChunks = () => {
  const signals: AbortSignal[] = [];
  const releases: (() => void)[] = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("upload-inference-chunk")) {
      signals.push(init!.signal!);
      return await new Promise<Response>((resolve, reject) => {
        releases.push(() => resolve(json({ ok: true })));
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return standardFetch(url);
  });
  return { signals, releases };
};

describe("view-only upload boundary", () => {
  it("never sends selected view-only bytes and opens the local viewer", async () => {
    const user = userEvent.setup();
    mount();
    await pickModel(user, "None");
    await selectFiles(user, file("private.nii.gz"));
    await user.click(screen.getByRole("button", { name: "View", exact: true }));
    expect(await screen.findByRole("heading", { name: "Local viewer" })).toBeInTheDocument();
    expect(transfers()).toHaveLength(0);
  });

  it("starts pre-upload only after a real model is selected", async () => {
    const user = userEvent.setup();
    mount();
    await pickModel(user, "None");
    await selectFiles(user, file("private.nii.gz"));
    expect(transfers()).toHaveLength(0);
    await pickModel(user, "ePAI");
    await waitFor(() => expect(transfers().some(([url]) => String(url).includes("finalize-upload"))).toBe(true));
    expect(transfers().every(([, init]) => new Headers(init?.headers).get("X-Upload-Owner") === "u1")).toBe(true);
  });

  it("switching to None aborts the active pre-upload and cancels queued files", async () => {
    const user = userEvent.setup();
    const { signals } = holdChunks();
    mount();
    await selectFiles(user, [file("active.nii.gz"), file("queued.nii.gz")]);
    await waitFor(() => expect(signals).toHaveLength(1));
    await pickModel(user, "None");
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(transfers()).toHaveLength(1);
    expect(await screen.findByText(/some scan data may already be on the server/)).toBeInTheDocument();
  });

  it("warns when an upload completed before the mode changed", async () => {
    const user = userEvent.setup();
    mount();
    await selectFiles(user, file("already-sent.nii.gz"));
    await waitFor(() => expect(document.querySelector(".file-chip--done")).not.toBeNull());
    const count = transfers().length;
    await pickModel(user, "None");
    expect(await screen.findByText(/Switching modes cannot undo that transfer/)).toBeInTheDocument();
    expect(transfers()).toHaveLength(count);
  });
});

describe("upload session initialization", () => {
  it("waits for the first chunk to bind ownership before parallel background chunks", async () => {
    const user = userEvent.setup();
    let releaseFirst!: () => void;
    let initialized = false;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const indices: number[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("upload-inference-chunk")) {
        const index = Number((init!.body as FormData).get("chunk_index"));
        indices.push(index);
        if (index === 0) { await firstGate; initialized = true; }
        if (!initialized) return { ...json({ error: "Upload ownership is unknown; restart the upload." }), ok: false, status: 409 };
        return json({ ok: true });
      }
      return standardFetch(url);
    });
    mount();
    await selectFiles(user, file("owned.nii.gz", 3));
    await waitFor(() => expect(indices).toHaveLength(1));
    expect(indices).toEqual([0]);
    expect(screen.getByRole("progressbar", { name: "Uploading owned.nii.gz" })).toHaveAttribute("aria-valuenow", "0");
    await act(async () => releaseFirst());
    await waitFor(() => expect(screen.getByText("Uploaded", { selector: ".file-chip-status" })).toBeInTheDocument());
    expect(indices).toEqual([0, 1, 2]);
    expect(transfers().filter(([url]) => String(url).includes("finalize-upload"))).toHaveLength(1);
  });

  it("Run retries a failed background upload with a new session and serializes its first chunk", async () => {
    const user = userEvent.setup();
    let failedSession: string | undefined;
    let releaseRetry!: () => void;
    let initialized = false;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const chunks: { sid: string; index: number }[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("upload-inference-chunk")) {
        const data = init!.body as FormData;
        const sid = String(data.get("session_id"));
        const index = Number(data.get("chunk_index"));
        chunks.push({ sid, index });
        if (!failedSession) failedSession = sid;
        if (sid === failedSession) return { ...json({ error: "Upload ownership is unknown; restart the upload." }), ok: false, status: 409 };
        if (index === 0) { await retryGate; initialized = true; }
        if (!initialized) return { ...json({ error: "Owner marker is not ready" }), ok: false, status: 409 };
        return json({ ok: true });
      }
      return standardFetch(url);
    });
    mount();
    await selectFiles(user, file("retry.nii.gz", 3));
    expect(await screen.findByText("Upload failed", { selector: ".file-chip-status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview retry.nii.gz" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Run", exact: true }));
    await waitFor(() => expect(chunks).toHaveLength(2));
    expect(chunks[1].sid).not.toBe(failedSession);
    expect(chunks[1].index).toBe(0);
    await act(async () => releaseRetry());
    await waitFor(() => expect(transfers().filter(([url]) => String(url).includes("run-epai-inference"))).toHaveLength(1));
    expect(chunks.filter(({ sid }) => sid !== failedSession).map(({ index }) => index)).toEqual([0, 1, 2]);
    const inference = transfers().find(([url]) => String(url).includes("run-epai-inference"))!;
    expect((inference[1]!.body as FormData).get("session_id")).toBe(chunks[1].sid);
    expect(errorLog).toHaveBeenCalledWith("Background upload failed:", expect.any(Error));
  });
});

describe("uploads outliving the page", () => {
  it("continues an authorized upload through same-account route navigation", async () => {
    const user = userEvent.setup();
    const { signals, releases } = holdChunks();
    mount();
    await selectFiles(user, file("continuing.nii.gz"));
    await waitFor(() => expect(signals).toHaveLength(1));
    await user.click(screen.getByRole("link", { name: "Leave upload page" }));
    expect(screen.getByRole("heading", { name: "Another feature" })).toBeInTheDocument();
    expect(signals[0].aborted).toBe(false);
    await act(async () => releases[0]());
    await waitFor(() => expect(transfers().some(([url]) => String(url).includes("finalize-upload"))).toBe(true));
  });

  it("aborts old-account uploads after page unmount and never starts their queued files", async () => {
    const user = userEvent.setup();
    const { signals } = holdChunks();
    mount();
    await selectFiles(user, [file("active.nii.gz"), file("queued.nii.gz")]);
    await waitFor(() => expect(signals).toHaveLength(1));
    await user.click(screen.getByRole("link", { name: "Leave upload page" }));
    await act(async () => setRecentUploadsAccount("u2"));
    expect(signals[0].aborted).toBe(true);
    expect(transfers()).toHaveLength(1);
  });

  it("does not restart cancelled queued transfers when the original account signs back in", async () => {
    const user = userEvent.setup();
    const { signals } = holdChunks();
    mount();
    await selectFiles(user, [file("active.nii.gz"), file("queued.nii.gz")]);
    await waitFor(() => expect(signals).toHaveLength(1));
    await act(async () => {
      setRecentUploadsAccount(null);
      setRecentUploadsAccount("u1");
    });
    expect(signals[0].aborted).toBe(true);
    expect(transfers()).toHaveLength(1);
  });
});
