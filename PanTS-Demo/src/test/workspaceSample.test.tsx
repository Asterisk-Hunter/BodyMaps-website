import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UploadPage from "../routes/UploadPage";
import { setRecentUploadsAccount } from "../helpers/recentUploads";

const account = vi.hoisted(() => ({ id: "sample-owner" }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ isAuthenticated: true, promptAuth: vi.fn(), refreshUsage: vi.fn(), user: { id: account.id, plan: "pro", roles: [] } }) }));
vi.mock("../helpers/pendingUploads", () => ({ loadPendingUploads: async () => [], deletePendingUpload: vi.fn(), savePendingUpload: vi.fn(), setPendingNextChunk: vi.fn(), setPendingUploaded: vi.fn(), chunkSizeOf: vi.fn() }));
vi.mock("../components/CtPreview/CtPreview", () => ({ default: ({ file }: { file: File }) => <div data-file-size={file.size}>Local preview of {file.name}</div> }));
const sampleUrl = (input: unknown) => String(input).includes("/api/get-main-nifti/");
const searchUrl = (input: unknown) => String(input).includes("/api/search?") && String(input).includes("sort_by=sample");
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const catalog = (items: unknown[] = [{ case_id: "PanTS_00008854" }]) => json({ items, total: items.length });
beforeEach(() => { account.id = "sample-owner"; localStorage.clear(); setRecentUploadsAccount("sample-owner"); });
afterEach(() => { vi.unstubAllGlobals(); setRecentUploadsAccount(null); });
async function mountViewOnly() {
  const user = userEvent.setup();
  const view = render(<MemoryRouter><UploadPage /></MemoryRouter>);
  await user.click(await screen.findByRole("button", { name: /^ePAI$/ }));
  await user.click(within(document.getElementById("segmentation-options")!).getByText("None", { exact: true }));
  return { user, view };
}

it("loads the top-ranked available sample into the composer without starting inference", async () => {
  const sample = new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } });
  const blobReader = vi.spyOn(sample, "blob").mockRejectedValue(new TypeError("Failed to fetch"));
  const bufferReader = vi.spyOn(sample, "arrayBuffer");
  vi.stubGlobal("fetch", vi.fn(async (input) => searchUrl(input) ? catalog([{ case_id: "PanTS_00008854" }, { case_id: "PanTS_00000035" }]) : sampleUrl(input)
    ? sample
    : json({ items: [], total: 0, ids: [] })));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("PanTS_00008854.nii.gz")).toBeInTheDocument();
  expect(screen.getByText(/Sample case 8854 is loaded into the workspace/)).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /run-inference|run-epai-inference|upload-inference-chunk/.test(String(input)))).toBe(false);
  expect(vi.mocked(fetch).mock.calls.find(([input]) => sampleUrl(input))?.[1]).toEqual(expect.objectContaining({ credentials: "include" }));
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input)).map(([input]) => String(input))).toEqual(["/api/get-main-nifti/8854.nii.gz"]);
  expect(vi.mocked(fetch).mock.calls.find(([input]) => searchUrl(input))).toEqual([
    "/api/search?dataset=all&sort_by=sample&page=1&per_page=5", expect.objectContaining({ credentials: "include" }),
  ]);
  const preview = screen.getByRole("button", { name: "Preview PanTS_00008854.nii.gz" });
  expect(preview.querySelector("img")).toHaveAttribute("src", "/api/get_image_preview/8854");
  expect(screen.getByText("NIfTI · Sample case")).toBeInTheDocument();
  expect(screen.getByText("Ready", { selector: ".file-chip-status" })).toBeInTheDocument();
  await user.click(preview);
  expect(await screen.findByText("Local preview of PanTS_00008854.nii.gz")).toHaveAttribute("data-file-size", "3");
  expect(bufferReader).toHaveBeenCalledTimes(1);
  expect(blobReader).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Hide preview for PanTS_00008854.nii.gz" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Remove PanTS_00008854.nii.gz" }));
  expect(screen.queryByText("Local preview of PanTS_00008854.nii.gz")).not.toBeInTheDocument();
  expect(screen.getByText("Drop a CT scan here")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select NIfTI file" })).toBeVisible();
});

it("falls back in ranked order past missing and unavailable scans while retaining CancerVerse identity", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog([{ case_id: "PanTS_00008854" }, { id: 9000 }, { case_id: "CV_00000012" }]);
    if (String(input).endsWith("/8854.nii.gz")) return new Response(null, { status: 404 });
    if (String(input).endsWith("/9000.nii.gz")) return new Response(null, { status: 503 });
    if (String(input).endsWith("/CV_00000012.nii.gz")) return new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("CV_00000012.nii.gz")).toBeInTheDocument();
  expect(screen.getByText(/Sample case CV_00000012 is loaded/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Preview CV_00000012.nii.gz" }).querySelector("img")).toHaveAttribute("src", "/api/get_image_preview/CV_00000012");
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input)).map(([input]) => String(input))).toEqual([
    "/api/get-main-nifti/8854.nii.gz", "/api/get-main-nifti/9000.nii.gz", "/api/get-main-nifti/CV_00000012.nii.gz",
  ]);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /run-epai-inference|upload-inference-chunk/.test(String(input)))).toBe(false);
});

it("bounds candidate attempts and explains when every ranked scan is missing", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog(Array.from({ length: 8 }, (_, index) => ({ id: index + 1 })));
    if (sampleUrl(input)) return new Response(null, { status: 404 });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("No sample scan is available right now. Try again later or upload a CT scan.")).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input))).toHaveLength(5);
  expect(screen.queryByText("NIfTI · Sample case")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
});

it.each([16 * 1024 * 1024 + 1, 40442531, 248354566])("skips an oversized %s-byte sample without buffering it, then accepts a response without Content-Length", async (size) => {
  const oversized = new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip", "Content-Length": String(size) } });
  const read = vi.spyOn(oversized, "arrayBuffer");
  const cancel = vi.spyOn(oversized.body!, "cancel");
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog([{ id: 900 }, { id: 22 }]);
    if (String(input).endsWith("/900.nii.gz")) return oversized;
    if (sampleUrl(input)) return new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("PanTS_00000022.nii.gz")).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input)).map(([input]) => String(input))).toEqual([
    "/api/get-main-nifti/900.nii.gz", "/api/get-main-nifti/22.nii.gz",
  ]);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("res=low"))).toBe(false);
});

it("explains when every candidate exceeds the automatic sample transfer budget", async () => {
  const responses: Response[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog([{ id: 900 }, { id: 901 }]);
    if (sampleUrl(input)) {
      const response = new Response(new Uint8Array([31]), { headers: { "Content-Type": "application/gzip", "Content-Length": "248354566" } });
      vi.spyOn(response, "arrayBuffer");
      responses.push(response);
      return response;
    }
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("No suitable compact sample is available right now. You can browse the dataset or upload a CT scan.")).toBeInTheDocument();
  expect(responses).toHaveLength(2);
  for (const response of responses) expect(response.arrayBuffer).not.toHaveBeenCalled();
  expect(screen.queryByText("NIfTI · Sample case")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
});

it.each(["network", "body"])("tries the next ranked candidate after a %s transfer failure", async (failure) => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog([{ id: 11 }, { id: 22 }]);
    if (String(input).endsWith("/11.nii.gz")) {
      if (failure === "network") throw new TypeError("Failed to fetch");
      const response = new Response(new Uint8Array([31]), { headers: { "Content-Type": "application/gzip" } });
      vi.spyOn(response, "arrayBuffer").mockRejectedValue(new TypeError("Failed to fetch"));
      return response;
    }
    if (sampleUrl(input)) return new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("PanTS_00000022.nii.gz")).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input))).toHaveLength(2);
});

it.each([401, 403])("stops sample fallback on authorization failure %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog([{ id: 11 }, { id: 22 }]);
    if (sampleUrl(input)) return new Response(null, { status });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText(status === 401 ? "Sign in again to load a sample case." : "The sample could not be loaded. Please try again.")).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => sampleUrl(input))).toHaveLength(1);
  expect(screen.queryByText("NIfTI · Sample case")).not.toBeInTheDocument();
});

it("stops candidate fetching when the account changes during catalogue lookup", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return new Promise<Response>((resolve) => { finish = resolve; });
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  await act(async () => { setRecentUploadsAccount("another-owner"); finish(catalog()); });
  expect(vi.mocked(fetch).mock.calls.some(([input]) => sampleUrl(input))).toBe(false);
  expect(screen.queryByText("NIfTI · Sample case")).not.toBeInTheDocument();
});

it("rejects an empty sample byte response without creating a file", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input) => searchUrl(input) ? catalog() : sampleUrl(input)
    ? new Response(new ArrayBuffer(0), { headers: { "Content-Type": "application/gzip" } })
    : json({ items: [], total: 0, ids: [] })));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("No sample scan is available right now. Try again later or upload a CT scan.")).toBeInTheDocument();
  expect(screen.queryByText("PanTS_00008854.nii.gz")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
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
  vi.stubGlobal("fetch", vi.fn(async (input) => searchUrl(input) ? catalog() : sampleUrl(input) ? new Response("Unavailable", { status: 503 }) : json({ items: [], total: 0 })));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText(/No sample scan is available right now/)).toBeInTheDocument();
  expect(screen.queryByText("PanTS_00008854.nii.gz")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
});

it.each(["picker", "drop", "dicom"])("clears stale sample feedback after a successful %s selection", async (method) => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (searchUrl(input)) return catalog();
    if (sampleUrl(input)) throw new TypeError("Failed to fetch");
    return json({ items: [], total: 0, ids: [] });
  }));
  const { user, view } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(await screen.findByText("No sample scan is available right now. Try again later or upload a CT scan.")).toBeInTheDocument();
  const file = new File(["local scan"], method === "dicom" ? "slice.dcm" : "local.nii.gz");
  if (method === "picker") await user.upload(view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, file);
  else if (method === "drop") fireEvent.drop(view.container.querySelector('[data-tour="scan-input"]')!, { dataTransfer: { files: [file] } });
  else fireEvent.change(view.container.querySelector('input[webkitdirectory]')!, { target: { files: [file] } });
  expect(screen.queryByText("No sample scan is available right now. Try again later or upload a CT scan.")).not.toBeInTheDocument();
  expect(screen.getByText("Ready", { selector: ".file-chip-status" })).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /run-inference|upload-inference-chunk/.test(String(input)))).toBe(false);
});

it("clears stale sample feedback without hiding a selected file's real upload failure", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (searchUrl(input)) return catalog();
      if (sampleUrl(input)) throw new TypeError("Failed to fetch");
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
    expect(await screen.findByText("No sample scan is available right now. Try again later or upload a CT scan.")).toBeInTheDocument();
    await user.upload(picker, new File(["second"], "next.nii.gz"));
    expect(screen.queryByText("No sample scan is available right now. Try again later or upload a CT scan.")).not.toBeInTheDocument();
    const previousCard = screen.getByText("failed.nii.gz").closest(".file-chip")!;
    expect(within(previousCard as HTMLElement).getByText("Upload failed")).toBeInTheDocument();
  } finally { errorLog.mockRestore(); }
});

it("aborts sample loading on account change and ignores late data", async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (searchUrl(input)) return catalog();
    if (sampleUrl(input)) { signal = init.signal; return new Promise<Response>((resolve) => { finish = resolve; }); }
    return json({ items: [], total: 0 });
  }));
  const { user } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  await waitFor(() => expect(signal).toBeDefined());
  await act(async () => {
    setRecentUploadsAccount("another-owner");
    finish(new Response(new Uint8Array([1]), { headers: { "Content-Type": "application/gzip" } }));
  });
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByText("PanTS_00008854.nii.gz")).not.toBeInTheDocument();
});

it("lets a new account load a sample without an old request clearing its loading state", async () => {
  const pending: { finish: (response: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (searchUrl(input)) return catalog();
    if (sampleUrl(input)) return new Promise<Response>((finish) => { pending.push({ finish, signal: init.signal }); });
    return json({ items: [], total: 0 });
  }));
  const { user, view } = await mountViewOnly();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(pending).toHaveLength(1);
  act(() => {
    account.id = "new-sample-owner";
    setRecentUploadsAccount(account.id);
    view.rerender(<MemoryRouter><UploadPage /></MemoryRouter>);
  });
  expect(pending[0].signal.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Sample case", exact: true })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
  expect(pending).toHaveLength(2);
  await act(async () => { pending[0].finish(new Response(new Uint8Array([1]), { headers: { "Content-Type": "application/gzip" } })); });
  expect(screen.getByRole("button", { name: "Loading sample…", exact: true })).toBeDisabled();
  expect(pending[1].signal.aborted).toBe(false);
  expect(screen.queryByText("PanTS_00008854.nii.gz")).not.toBeInTheDocument();
  await act(async () => { pending[1].finish(new Response(new Uint8Array([31, 139, 8]), { headers: { "Content-Type": "application/gzip" } })); });
  expect(await screen.findByText("PanTS_00008854.nii.gz")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel loading" })).not.toBeInTheDocument();
});
