import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesignShell from "../components/DesignShell";
import UploadPage from "../routes/UploadPage";
import { deletePendingUpload, savePendingUpload } from "../helpers/pendingUploads";
import { loadRecentUploads, recentUploadsStorageKey, setRecentUploadsAccount, type RecentUpload } from "../helpers/recentUploads";

const account = vi.hoisted(() => ({ id: "new-run-owner", plan: "pro", roles: [] }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ isAuthenticated: true, user: account, refreshUsage: vi.fn(), promptAuth: vi.fn() }) }));
vi.mock("../components/AuthButton", () => ({ default: () => <button>Account controls</button> }));
vi.mock("../components/WorkspaceTour", () => ({ default: () => null }));
vi.mock("../components/SiteFooter", () => ({ default: () => <footer>Site footer</footer> }));
vi.mock("../components/CtPreview/CtPreview", () => ({ default: () => <div>CT preview</div> }));
vi.mock("../helpers/pendingUploads", () => ({ loadPendingUploads: async () => [], deletePendingUpload: vi.fn(), savePendingUpload: vi.fn(async () => true), setPendingNextChunk: vi.fn(), setPendingUploaded: vi.fn(), chunkSizeOf: vi.fn() }));

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const completed = (): RecentUpload => ({ sessionId: "previous-run", label: "Previous scan", model: "ePAI", status: "Completed", timestamp: Date.now() });
const calls = (path: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes(path));
let statusResponse: Promise<Response> | undefined;
const standardFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(input);
  if (path.includes("/api/inference-status/")) return statusResponse || json({ status: "queued" });
  if (path.includes("/api/finalize-")) return json({ uploaded_filename: "ct.nii.gz" });
  if (path.endsWith("/api/stage-sample") && init?.method === "POST") {
    const sid = JSON.parse(init.body as string).session_id;
    return json({ status: "combined", session_id: sid, uploaded_filename: "BDMAP_SAMPLE/ct.nii.gz",
      file_name: "PanTS_00000002.nii.gz", size: 11169107, case_id: "PanTS_00000002", bdmap_id: "BDMAP_SAMPLE", preview_url: `/api/session-ct/${sid}` });
  }
  if (path.includes("/api/run-epai-inference")) return json({ session_id: (init!.body as FormData).get("session_id"), status: "queued" });
  return json({ items: [], jobs: [] });
};
beforeEach(() => {
  vi.clearAllMocks(); statusResponse = undefined; localStorage.clear(); setRecentUploadsAccount(account.id);
  localStorage.setItem(recentUploadsStorageKey(account.id), JSON.stringify([completed()]));
  vi.stubGlobal("fetch", vi.fn(standardFetch));
});
afterEach(() => { vi.unstubAllGlobals(); setRecentUploadsAccount(null); });

function RouteProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}:{String(Boolean(location.state?.newWorkspaceRun))}</output>;
}
function HistoryProbe() { return <><h1>Account history</h1><p>{loadRecentUploads(account.id).map((run) => run.label).join(", ")}</p></>; }
const mount = (path = "/upload") => render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route element={<DesignShell />}>
    <Route path="/" element={<><UploadPage /><RouteProbe /></>} />
    <Route path="/upload" element={<><UploadPage /><RouteProbe /></>} />
    <Route path="/team" element={<h1>Team</h1>} />
  </Route>
  <Route element={<Outlet />}><Route element={<DesignShell />}>
    <Route path="/account/history" element={<HistoryProbe />} />
  </Route></Route>
</Routes></MemoryRouter>);

describe("New run resets only the workspace view", () => {
  it.each(["/", "/upload"])("clears selected scans and the previous card on %s while retaining History", async (path) => {
    const user = userEvent.setup(); const view = mount(path);
    await screen.findByRole("article", { name: "Run: Previous scan" });
    await user.click(screen.getByRole("button", { name: "ePAI", exact: true }));
    await user.click(within(document.getElementById("segmentation-options")!).getByText("None", { exact: true }));
    const input = view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File(["scan"], "selected.nii.gz"));
    expect(screen.getByRole("button", { name: "Remove selected.nii.gz" })).toBeInTheDocument();
    const history = loadRecentUploads(account.id);
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove selected.nii.gz" })).not.toBeInTheDocument();
    expect(input.files).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Select NIfTI file" })).toHaveFocus();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    expect(screen.getByLabelText("Current route")).toHaveTextContent(`${path}:false`);
    expect(loadRecentUploads(account.id)).toEqual(history);
    expect(deletePendingUpload).not.toHaveBeenCalled();
    await user.upload(input, new File(["again"], "another.nii.gz"));
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(screen.queryByRole("button", { name: "Remove another.nii.gz" })).not.toBeInTheDocument();
    expect(loadRecentUploads(account.id)).toEqual(history);
  });

  it.each(["/team", "/account/history"])("opens a fresh composer from %s across the shell boundary", async (path) => {
    const user = userEvent.setup(); mount(path);
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(await screen.findByRole("button", { name: "Select NIfTI file" })).toHaveFocus();
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/upload:false");
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
    expect(loadRecentUploads(account.id)).toHaveLength(1);
  });

  it("keeps an actual pending poll alive and hides its completion until the user opens it", async () => {
    let finish!: (response: Response) => void;
    statusResponse = new Promise((resolve) => { finish = resolve; });
    localStorage.setItem(recentUploadsStorageKey(account.id), JSON.stringify([{ ...completed(), status: "Processing" }]));
    const user = userEvent.setup(); mount();
    await screen.findByRole("article", { name: "Run: Previous scan" });
    await waitFor(() => expect(calls("/api/inference-status/previous-run")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
    expect(loadRecentUploads(account.id)[0].status).toBe("Processing");
    expect(calls("cancel-inference")).toHaveLength(0);
    expect(deletePendingUpload).not.toHaveBeenCalled();
    // An explicit sidebar selection can restore a running card after resetting.
    await user.click(screen.getByRole("button", { name: /Previous scan/ }));
    expect(screen.getByRole("article", { name: "Run: Previous scan" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    await act(async () => finish(json({ status: "completed" })));
    await waitFor(() => expect(loadRecentUploads(account.id)[0].status).toBe("Completed"));
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
    expect(calls("cancel-inference")).toHaveLength(0);
    expect(deletePendingUpload).not.toHaveBeenCalled();
  });

  it("releases an unused selected sample and shows a newly submitted run after resetting", async () => {
    const user = userEvent.setup(); mount();
    await screen.findByRole("button", { name: "ePAI", exact: true });
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    await screen.findByText("PanTS_00000002.nii.gz");
    const firstSid = JSON.parse(calls("/api/stage-sample")[0][1]!.body as string).session_id;
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(screen.queryByText("PanTS_00000002.nii.gz")).not.toBeInTheDocument();
    expect(calls(`/api/stage-sample/${firstSid}`)[0][1]?.method).toBe("DELETE");
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    await screen.findByText("PanTS_00000002.nii.gz");
    await user.click(screen.getByRole("button", { name: "Run", exact: true }));
    await waitFor(() => expect(calls("run-epai-inference")).toHaveLength(1));
    expect(screen.getByRole("region", { name: "Current runs" })).toBeInTheDocument();
    expect(loadRecentUploads(account.id)).toHaveLength(2);
    const sid = (calls("run-epai-inference")[0][1]!.body as FormData).get("session_id");
    expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sid }));
    // Resetting again must retain the sample already claimed by the real Run.
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    expect(calls(`/api/stage-sample/${sid}`)).toHaveLength(0);
    expect(loadRecentUploads(account.id).find((run) => run.sessionId === sid)?.status).toBe("Processing");
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
  });

  it("preserves every submitted batch sample while the first admission is still pending", async () => {
    let finishSave!: (saved: boolean) => void;
    vi.mocked(savePendingUpload).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const user = userEvent.setup(); mount();
    await screen.findByRole("button", { name: "ePAI", exact: true });
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    await screen.findByText("PanTS_00000002.nii.gz");
    await user.click(screen.getByText("Add scans", { exact: true }));
    await user.click(screen.getByRole("button", { name: "Sample case", exact: true }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove PanTS_00000002.nii.gz" })).toHaveLength(2));
    const sids = calls("/api/stage-sample").map(([, init]) => JSON.parse(init!.body as string).session_id);
    await user.click(screen.getByRole("button", { name: "Run", exact: true }));
    await waitFor(() => expect(savePendingUpload).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "New run", exact: true }));
    for (const sid of sids) expect(calls(`/api/stage-sample/${sid}`)).toHaveLength(0);
    await act(async () => finishSave(true));
    await waitFor(() => expect(calls("run-epai-inference")).toHaveLength(2));
    for (const sid of sids) {
      expect(loadRecentUploads(account.id).find((run) => run.sessionId === sid)?.status).toBe("Processing");
      expect(calls(`/api/stage-sample/${sid}`)).toHaveLength(0);
    }
    expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument();
    expect(calls("cancel-inference")).toHaveLength(0);
  });
});
