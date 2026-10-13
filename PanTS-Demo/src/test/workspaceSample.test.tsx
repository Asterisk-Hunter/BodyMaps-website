import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UploadPage from "../routes/UploadPage";
import { loadRecentUploads, RECENT_UPLOADS_CHANGED, setRecentUploadsAccount } from "../helpers/recentUploads";
import { deletePendingUpload, savePendingUpload } from "../helpers/pendingUploads";

const account = vi.hoisted(() => ({ id: "sample-owner", signedIn: true, prompt: vi.fn() }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ isAuthenticated: account.signedIn, promptAuth: account.prompt, refreshUsage: vi.fn(), user: account.signedIn ? { id: account.id, plan: "pro", roles: [] } : null }) }));
vi.mock("../helpers/pendingUploads", () => ({ loadPendingUploads: async () => [], deletePendingUpload: vi.fn(), savePendingUpload: vi.fn(async () => true), setPendingNextChunk: vi.fn(), setPendingUploaded: vi.fn(), chunkSizeOf: vi.fn() }));
vi.mock("../components/CtPreview/CtPreview", () => ({ default: ({ file }: { file: File }) => <div data-file-size={file.size}>Local preview of {file.name}</div> }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stageReply = (sid: string, overrides = {}) => json({ status: "combined", session_id: sid,
  uploaded_filename: "BDMAP_SAMPLE/ct.nii.gz", file_name: "PanTS_00000031.nii.gz", size: 11169107,
  case_id: "PanTS_00000031", bdmap_id: "BDMAP_SAMPLE", preview_url: `/api/session-ct/${sid}`, reused: false, ...overrides });
const isStage = (input: unknown, init?: RequestInit) => String(input).endsWith("/api/stage-sample") && init?.method === "POST";
const calls = (part: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes(part));
const stageId = () => JSON.parse(calls("/api/stage-sample").find(([, init]) => init?.method === "POST")![1]!.body as string).session_id;
const standardFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (isStage(input, init)) return stageReply(JSON.parse(init!.body as string).session_id);
  if (String(input).includes("/api/stage-sample/") && init?.method === "DELETE") return new Response(null, { status: 204 });
  if (String(input).includes("/api/run-epai-inference")) {
    const form = init!.body as FormData;
    return json({ session_id: form.get("session_id"), status: "queued", pipeline: { version: 1,
      preprocessing: form.get("preprocessing"), model: form.get("model_name"), postprocessing: form.get("postprocessing") } });
  }
  if (String(input).includes("/api/inference-status/")) return json({ status: "queued" });
  return json({ items: [], total: 0, jobs: [] });
};
beforeEach(() => { vi.clearAllMocks(); account.id = "sample-owner"; account.signedIn = true;
  localStorage.clear(); setRecentUploadsAccount(account.id); vi.stubGlobal("fetch", vi.fn(standardFetch)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setRecentUploadsAccount(null); });
function RouteProbe() { return <output data-testid="path">{useLocation().pathname}</output>; }
const page = () => <MemoryRouter><UploadPage /><RouteProbe /></MemoryRouter>;
async function mountWorkspace(viewOnly = false) {
  const user = userEvent.setup();
  const view = render(page());
  await screen.findByRole("button", { name: /^ePAI$/ }, { timeout: 5000 });
  if (viewOnly) {
    await user.click(screen.getByRole("button", { name: /^ePAI$/ }));
    await user.click(within(document.getElementById("segmentation-options")!).getByText("None", { exact: true }));
  }
  return { user, view };
}
const mountViewOnly = () => mountWorkspace(true);
async function chooseSample(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  await screen.findByText("PanTS_00000031.nii.gz");
}

it("stages a real owned sample with metadata only, without downloading or uploading CT bytes", async () => {
  const { user } = await mountWorkspace();
  await chooseSample(user);
  expect(screen.getByText("On server", { selector: ".file-chip-status" })).toBeInTheDocument();
  const posts = calls("/api/stage-sample").filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0][1]).toMatchObject({ credentials: "include", headers: { "Content-Type": "application/json", "X-Upload-Owner": account.id } });
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ session_id: expect.any(String) });
  expect(calls("get-main-nifti")).toHaveLength(0);
  expect(calls("session-ct")).toHaveLength(0);
  expect(calls("upload-inference")).toHaveLength(0);
  expect(calls("run-epai-inference")).toHaveLength(0);
  expect(savePendingUpload).not.toHaveBeenCalled();
});

it("runs the staged session directly with a resumable reference and no re-upload", async () => {
  const { user, view } = await mountWorkspace();
  await chooseSample(user);
  const sid = stageId();
  await user.click(screen.getByRole("button", { name: "Run", exact: true }));
  await waitFor(() => expect(calls("run-epai-inference")).toHaveLength(1));
  expect(screen.queryByText(/Sample case 31 is ready on the server/)).not.toBeInTheDocument();
  const init = calls("run-epai-inference")[0][1]!;
  expect(init.credentials).toBe("include");
  expect(init.headers).toEqual({ "X-Upload-Owner": account.id });
  const form = init.body as FormData;
  expect(Object.fromEntries(form.entries())).toMatchObject({ session_id: sid, model_name: "ePAI", uploaded_filename: "BDMAP_SAMPLE/ct.nii.gz" });
  expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sid, filename: "PanTS_00000031.nii.gz", uploadedFilename: "BDMAP_SAMPLE/ct.nii.gz", totalChunks: 0 }));
  expect(calls("upload-inference")).toHaveLength(0);
  expect(calls("session-ct")).toHaveLength(0);
  expect(loadRecentUploads(account.id)).toContainEqual(expect.objectContaining({ sessionId: sid, sourceName: "PanTS_00000031.nii.gz", status: "Processing" }));
  view.unmount();
  expect(calls(`/api/stage-sample/${sid}`)).toHaveLength(0);
});

it("downloads original CT only on explicit Preview and handles HTTP gzip decompression", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input, init) => String(input).includes("/api/session-ct/")
    ? new Response(new Uint8Array([92, 1, 0, 0]), { headers: { "Content-Type": "application/gzip", "Content-Encoding": "gzip" } }) : standardFetch(input, init)));
  const { user } = await mountViewOnly();
  await chooseSample(user);
  expect(calls("session-ct")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Preview PanTS_00000031.nii.gz" }));
  expect(await screen.findByText("Local preview of PanTS_00000031.nii")).toHaveAttribute("data-file-size", "4");
  expect(calls("session-ct")).toHaveLength(1);
  expect(calls("session-ct")[0][1]).toMatchObject({ credentials: "include", headers: { "X-Upload-Owner": account.id } });
  expect(calls("upload-inference")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Remove PanTS_00000031.nii.gz" }));
  expect(screen.queryByText("Local preview of PanTS_00000031.nii")).not.toBeInTheDocument();
  expect(screen.queryByText(/Sample case 31 is ready on the server/)).not.toBeInTheDocument();
  expect(calls(`/api/stage-sample/${stageId()}`)[0][1]?.method).toBe("DELETE");
});

it("opens the existing sample dataset viewer in view-only mode without starting inference", async () => {
  const { user } = await mountViewOnly();
  await chooseSample(user);
  await user.click(screen.getByRole("button", { name: "View", exact: true }));
  expect(screen.getByTestId("path")).toHaveTextContent("/case/31");
  expect(calls("run-epai-inference")).toHaveLength(0);
  expect(calls("upload-inference")).toHaveLength(0);
  expect(calls("session-ct")).toHaveLength(0);
});

it("falls back to the NIfTI icon after a missing thumbnail while preserving the actual scan preview", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input, init) => String(input).includes("/api/session-ct/")
    ? new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } }) : standardFetch(input, init)));
  const { user } = await mountViewOnly();
  await chooseSample(user);
  const previewButton = screen.getByRole("button", { name: "Preview PanTS_00000031.nii.gz" });
  expect(previewButton.querySelector("img")).toHaveAttribute("src", "/api/get_image_preview/31");
  fireEvent.error(previewButton.querySelector("img")!);
  expect(previewButton.querySelector("img")).toBeNull();
  expect(previewButton.querySelector(".file-chip-icon svg")).not.toBeNull();
  expect(previewButton).toBeEnabled();
  expect(calls("session-ct")).toHaveLength(0);
  await user.click(previewButton);
  expect(await screen.findByText("Local preview of PanTS_00000031.nii.gz")).toHaveAttribute("data-file-size", "3");
  expect(calls("session-ct")).toHaveLength(1);
  expect(calls("upload-inference")).toHaveLength(0);
});

it.each([401, 403, 503])("shows an honest staging error for HTTP %s without a pretend selected file", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async (input, init) => isStage(input, init) ? json({}, status) : standardFetch(input, init)));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText(status === 503 ? "The sample is temporarily unavailable. Please try again or select a local CT scan." : "Sign in again to prepare a sample case.")).toBeInTheDocument();
  expect(screen.queryByText("PanTS_00000031.nii.gz")).not.toBeInTheDocument();
  expect(calls("session-ct")).toHaveLength(0);
});

it.each([{ session_id: "someone-elses-session" }, { uploaded_filename: "../../private.nii.gz" }, { size: 0 }, { preview_url: "https://example.com/private" }])("validates owned sample references and never follows an arbitrary preview URL: %j", async (override) => {
  vi.stubGlobal("fetch", vi.fn(async (input, init) => isStage(input, init) ? stageReply(JSON.parse(init!.body as string).session_id, override) : standardFetch(input, init)));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  if ("preview_url" in override) {
    await screen.findByText("PanTS_00000031.nii.gz");
    await user.click(screen.getByRole("button", { name: "Preview PanTS_00000031.nii.gz" }));
    await waitFor(() => expect(calls("/api/session-ct/")).toHaveLength(1));
    for (const [input] of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(input), window.location.href).origin).toBe(window.location.origin);
    }
  } else {
    expect(await screen.findByText("The server returned an invalid sample reference. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("PanTS_00000031.nii.gz")).not.toBeInTheDocument();
  }
});

it("cancels selection immediately and cleans a late successful copy without displaying it", async () => {
  let finish!: (response: Response) => void;
  let sid = "";
  let transport!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (isStage(input, init)) { sid = JSON.parse(init!.body as string).session_id; transport = init!.signal!;
      return new Promise<Response>((resolve) => { finish = resolve; }); }
    return standardFetch(input, init);
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText(/Loading sample/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(calls("/api/stage-sample").filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
  expect(transport.aborted).toBe(false);
  await act(async () => { finish(stageReply(sid)); });
  expect(screen.queryByText("PanTS_00000031.nii.gz")).not.toBeInTheDocument();
  expect(calls(`/api/stage-sample/${sid}`).filter(([, init]) => init?.method === "DELETE").length).toBeGreaterThanOrEqual(2);
});

it("aborts staging transport on account switch and cannot let late old data clear the new request", async () => {
  const pending: { sid: string; finish: (response: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => isStage(input, init) ? new Promise<Response>((finish) => {
    pending.push({ sid: JSON.parse(init!.body as string).session_id, finish, signal: init!.signal! });
  }) : standardFetch(input, init)));
  const { user, view } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  act(() => { account.id = "next-owner"; setRecentUploadsAccount(account.id); view.rerender(page()); });
  expect(pending[0].signal.aborted).toBe(true);
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  await act(async () => { pending[0].finish(stageReply(pending[0].sid)); });
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeDisabled();
  expect(pending[1].signal.aborted).toBe(false);
  expect(screen.queryByText("PanTS_00000031.nii.gz")).not.toBeInTheDocument();
  await act(async () => { pending[1].finish(stageReply(pending[1].sid)); });
  expect(await screen.findByText("PanTS_00000031.nii.gz")).toBeInTheDocument();
});

it("clears a staged selection on account switch while retaining the user's local file", async () => {
  const { user, view } = await mountViewOnly();
  await chooseSample(user);
  await user.upload(view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, new File(["CT"], "mine.nii"));
  const sid = stageId();
  act(() => { account.id = "next-owner"; setRecentUploadsAccount(account.id); view.rerender(page()); });
  expect(screen.queryByText("PanTS_00000031.nii.gz")).not.toBeInTheDocument();
  expect(screen.getByText("mine.nii")).toBeInTheDocument();
  expect(screen.queryByText(/Sample case 31 is ready on the server/)).not.toBeInTheDocument();
  expect(calls(`/api/stage-sample/${sid}`)[0][1]?.headers).toEqual({ "X-Upload-Owner": "sample-owner" });
});

it.each(["account switch", "cancel"])("cleans a late pending-record write after %s before any inference request", async (action) => {
  let finishWrite!: (value: boolean) => void;
  vi.mocked(savePendingUpload).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishWrite = resolve; }));
  const { user, view } = await mountWorkspace();
  await chooseSample(user);
  const sid = stageId();
  await user.click(screen.getByRole("button", { name: "Run", exact: true }));
  await waitFor(() => expect(finishWrite).toBeDefined());
  if (action === "account switch") {
    act(() => { account.id = "next-owner"; setRecentUploadsAccount(account.id); view.rerender(page()); });
  } else await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await act(async () => { finishWrite(true); });
  expect(calls("run-epai-inference")).toHaveLength(0);
  expect(deletePendingUpload).toHaveBeenCalledWith(sid);
  expect(calls(`/api/stage-sample/${sid}`)[0][1]?.headers).toEqual({ "X-Upload-Owner": "sample-owner" });
  expect(loadRecentUploads("sample-owner").find((upload) => upload.sessionId === sid)?.status).toBe("Cancelled");
});

it("requires sign-in before staging a guest's sample", async () => {
  account.signedIn = false; setRecentUploadsAccount(null);
  const user = userEvent.setup(); render(page());
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(account.prompt).toHaveBeenCalledTimes(1);
  expect(calls("stage-sample")).toHaveLength(0);
});

it("aborts an explicit preview when it is hidden and never uploads its bytes", async () => {
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (String(input).includes("/api/session-ct/")) {
      signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    return standardFetch(input, init);
  }));
  const { user } = await mountViewOnly(); await chooseSample(user);
  await user.click(screen.getByRole("button", { name: "Preview PanTS_00000031.nii.gz" }));
  await waitFor(() => expect(signal).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Hide preview for PanTS_00000031.nii.gz" }));
  expect(signal.aborted).toBe(true);
  expect(calls("upload-inference")).toHaveLength(0);
});

it("bounds sample preparation and releases a timed-out server copy", async () => {
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (isStage(input, init)) {
      signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    return standardFetch(input, init);
  }));
  await mountViewOnly(); vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sample case", exact: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(signal.aborted).toBe(true);
  expect(screen.getByText("Preparing the sample timed out. Please try again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
});

it.each([0, -10, 20])("never describes a %s-second estimate as nearly finished without evidence", async (seconds) => {
  vi.stubGlobal("fetch", vi.fn(async (input, init) => String(input).includes("inference-duration-estimate")
    ? json({ available: true, median_seconds: seconds }) : String(input).includes("inference-status/")
    ? json({ status: "running" }) : standardFetch(input, init)));
  const { user } = await mountWorkspace(); await chooseSample(user);
  await user.click(screen.getByRole("button", { name: "Run", exact: true }));
  await waitFor(() => expect(calls("inference-duration-estimate")).toHaveLength(1));
  expect(screen.queryByText(/Finishing up/)).not.toBeInTheDocument();
  if (seconds > 0) {
    expect(await screen.findByText(/About <1 min left/)).toBeInTheDocument();
    vi.useFakeTimers();
    act(() => { vi.setSystemTime(Date.now() + 30_000); window.dispatchEvent(new Event(RECENT_UPLOADS_CHANGED)); });
    expect(screen.getByText(/Taking longer than estimated/)).toBeInTheDocument();
  } else {
    await waitFor(() => expect(screen.queryByText(/About .*left|Taking longer than estimated/)).not.toBeInTheDocument());
  }
});

it("keeps each staged batch session and its frozen model when the composer changes during admission", async () => {
  let finishFirst!: () => void;
  const forms: FormData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (String(input).includes("run-epai-inference")) {
      forms.push(init!.body as FormData);
      if (forms.length === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
    }
    return standardFetch(input, init);
  }));
  const { user } = await mountWorkspace(); await chooseSample(user);
  await user.click(screen.getByText("Add scans"));
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  await waitFor(() => expect(screen.getAllByText("PanTS_00000031.nii.gz")).toHaveLength(2));
  const ids = calls("stage-sample").filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string).session_id);
  await user.click(screen.getByRole("button", { name: "Run", exact: true }));
  await waitFor(() => expect(forms).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: /^ePAI$/ }));
  await user.click(within(document.getElementById("segmentation-options")!).getByText("Atlas-Net", { exact: true }));
  await act(async () => { finishFirst(); });
  await waitFor(() => expect(forms).toHaveLength(2));
  expect(forms.map((form) => form.get("session_id"))).toEqual(ids);
  expect(forms.map((form) => form.get("model_name"))).toEqual(["ePAI", "ePAI"]);
  expect(calls("upload-inference")).toHaveLength(0);
  expect(calls("session-ct")).toHaveLength(0);
});

it("keeps local files distinct from the sample and lets users add, preview and remove scans", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [], total: 0, ids: [] })));
  const { user, view } = await mountViewOnly();
  const picker = view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(picker, new File(["local scan"], "PanTS_00008854.nii.gz"));
  expect(screen.getByRole("button", { name: "Preview PanTS_00008854.nii.gz" }).querySelector("img")).toBeNull();
  expect(screen.queryByText("NIfTI · Sample case")).not.toBeInTheDocument();
  const disclosure = screen.getByText("Add scans").closest("details")!;
  expect(disclosure).not.toHaveAttribute("open");
  await user.click(screen.getByText("Add scans"));
  expect(disclosure).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "Select NIfTI file" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Select DICOM" })).toBeVisible();
  await user.upload(picker, new File(["second scan"], "second.nii.gz"));
  await user.click(screen.getByRole("button", { name: "Preview second.nii.gz" }));
  expect(await screen.findByText("Local preview of second.nii.gz")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remove second.nii.gz" }));
  expect(screen.getByText("PanTS_00008854.nii.gz")).toBeInTheDocument();
  expect(screen.queryByText("second.nii.gz", { exact: true })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /run-inference|upload-inference-chunk/.test(String(input)))).toBe(false);
});

it("shows a useful outage error without adding a pretend sample", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input) => String(input).endsWith("/api/stage-sample") ? json({}, 503) : json({ items: [], total: 0 })));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText(/The sample is temporarily unavailable/)).toBeInTheDocument();
  expect(screen.queryByText("PanTS_00008854.nii.gz")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
});

it.each(["picker", "drop", "dicom"])("clears stale sample feedback after a successful %s selection", async (method) => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (String(input).endsWith("/api/stage-sample")) return json({}, 503);
    return json({ items: [], total: 0, ids: [] });
  }));
  const { user, view } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("The sample is temporarily unavailable. Please try again or select a local CT scan.")).toBeInTheDocument();
  const file = new File(["local scan"], method === "dicom" ? "slice.dcm" : "local.nii.gz");
  if (method === "picker") await user.upload(view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, file);
  else if (method === "drop") fireEvent.drop(view.container.querySelector('[data-tour="scan-input"]')!, { dataTransfer: { files: [file] } });
  else fireEvent.change(view.container.querySelector('input[webkitdirectory]')!, { target: { files: [file] } });
  expect(screen.queryByText("The sample is temporarily unavailable. Please try again or select a local CT scan.")).not.toBeInTheDocument();
  expect(screen.getByText("Ready", { selector: ".file-chip-status" })).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /run-inference|upload-inference-chunk/.test(String(input)))).toBe(false);
});

it("clears stale sample feedback without hiding a selected file's real upload failure", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/api/stage-sample")) return json({}, 503);
      if (String(input).includes("upload-inference-chunk")) return new Response(JSON.stringify({ error: "Upload rejected" }), { status: 409, headers: { "Content-Type": "application/json" } });
      return json({ items: [], total: 0, ids: [] });
    }));
    const user = userEvent.setup();
    const view = render(<MemoryRouter><UploadPage /></MemoryRouter>);
    await screen.findByRole("button", { name: /^ePAI$/ });
    const picker = view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(picker, new File(["first"], "failed.nii.gz"));
    expect(await screen.findByText("Upload failed", { selector: ".file-chip-status" })).toBeInTheDocument();
    await user.click(screen.getByText("Add scans"));
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    expect(await screen.findByText("The sample is temporarily unavailable. Please try again or select a local CT scan.")).toBeInTheDocument();
    await user.upload(picker, new File(["second"], "next.nii.gz"));
    expect(screen.queryByText("The sample is temporarily unavailable. Please try again or select a local CT scan.")).not.toBeInTheDocument();
    const previousCard = screen.getByText("failed.nii.gz").closest(".file-chip")!;
    expect(within(previousCard as HTMLElement).getByText("Upload failed")).toBeInTheDocument();
  } finally { errorLog.mockRestore(); }
});
