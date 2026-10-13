import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchDetailsModal from "../components/BatchDetailsModal";
import { AuthProvider } from "../contexts/authContext";
import { recentUploadsStorageKey, setRecentUploadsAccount, type RecentUpload } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Where keyboard focus goes on the upload page when the control that had it leaves the
// page, and the batch dialog's focus handling. A mouse click leaves focus as before.

const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "free" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const run = (sessionId: string, label: string, extra: Partial<RecentUpload> = {}): RecentUpload => ({
  sessionId, label, model: "LesionSegmenter", status: "Completed", timestamp: Date.now() - 60_000, ...extra,
});

beforeEach(() => {
  localStorage.clear();
  setRecentUploadsAccount(null);
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/usage")) {
      return json({
        plan: "free",
        limits: { daily_scans: 1 },
        scans: { used: 0, limit: 3, in_flight: 0, resets_at: null },
        ai_messages: { used: 0, limit: 10, resets_at: null },
      });
    }
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/inference-status/")) return json({ status: "queued" });
    if (u.includes("/api/cancel-inference/")) return json({ ok: true });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = (runs: RecentUpload[] = []) => {
  if (runs.length) localStorage.setItem(recentUploadsStorageKey(USER.id), JSON.stringify(runs));
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/upload"]}>
        <Routes>
          <Route path="/upload" element={<UploadPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
};

const settled = () =>
  waitFor(() => expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument());

const currentRuns = () => screen.findByRole("region", { name: "Current runs" });
const filePicker = () => screen.getByRole("button", { name: "Select NIfTI file" });

describe("batch details dialog", () => {
  const uploads = [run("s1", "first.nii.gz"), run("s2", "second.nii.gz", { model: "ePAI" })];
  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen(true)}>View details</button>
      {open && <BatchDetailsModal label="Two scans" uploads={uploads} onView={vi.fn()} onDownloadScan={vi.fn()}
        onDownloadAll={vi.fn()} onClose={() => { onClose(); setOpen(false); }} />}
    </>;
  }

  it("takes focus, keeps Tab inside, closes on Escape and hands focus back", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "View details" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Two scans details" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const buttons = within(dialog).getAllByRole("button");
    buttons[buttons.length - 1].focus();
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes on a click on the backdrop but not on a drag that started in the panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "View details" }));
    const dialog = screen.getByRole("dialog", { name: "Two scans details" });
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(within(dialog).getByText("first.nii.gz"));
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tells a screen reader which scan each row's View and Download belong to", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "View details" }));
    const dialog = screen.getByRole("dialog", { name: "Two scans details" });
    const views = within(dialog).getAllByRole("button", { name: "View", exact: true });
    const downloads = within(dialog).getAllByRole("button", { name: "Download", exact: true });
    expect(views[0]).toHaveAccessibleDescription(/first\.nii\.gz LesionSegmenter/);
    expect(downloads[1]).toHaveAccessibleDescription(/second\.nii\.gz ePAI/);
  });
});

describe("file chips", () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement, names: string[]) => {
    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, names.map((name) => new File([new Uint8Array(1024)], name, { type: "application/gzip" })));
  };

  it("moves keyboard focus to the next chip's Remove, then to the file picker", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();
    await pick(user, container, ["a.nii.gz", "b.nii.gz"]);

    screen.getByRole("button", { name: "Remove a.nii.gz" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove b.nii.gz" })).toHaveFocus());

    await user.keyboard("{Enter}");
    await waitFor(() => expect(filePicker()).toHaveFocus());
  });

  it("leaves focus alone when a chip is removed with the mouse", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();
    await pick(user, container, ["a.nii.gz", "b.nii.gz"]);
    await user.click(screen.getByRole("button", { name: "Remove a.nii.gz" }));
    expect(screen.queryByRole("button", { name: "Remove a.nii.gz" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove b.nii.gz" })).not.toHaveFocus();
  });
});

describe("runs", () => {
  it("puts focus back on Rename after Enter or Escape and ignores an input method's Enter", async () => {
    const user = userEvent.setup();
    renderUpload([run("s1", "first.nii.gz")]);
    const region = await currentRuns();

    within(region).getByRole("button", { name: "Rename" }).focus();
    await user.keyboard("{Enter}");
    const field = within(region).getByRole("textbox", { name: "Run name" });
    await user.clear(field);
    await user.type(field, "Liver follow-up");
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(within(region).getByRole("textbox", { name: "Run name" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(region).getByRole("button", { name: "Rename" })).toHaveFocus());
    expect(within(region).getAllByText("Liver follow-up").length).toBeGreaterThan(0);

    await user.keyboard("{Enter}");
    await user.type(within(region).getByRole("textbox", { name: "Run name" }), " draft");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(region).getByRole("button", { name: "Rename" })).toHaveFocus());
  });

  it("moves keyboard focus to the run selector after Remove, then to the file picker after the last one", async () => {
    const user = userEvent.setup();
    renderUpload([run("s1", "first.nii.gz"), run("s2", "second.nii.gz")]);
    const region = await currentRuns();

    within(region).getByRole("button", { name: "Remove" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current run" })).toHaveFocus());

    within(await currentRuns()).getByRole("button", { name: "Remove" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Current runs" })).not.toBeInTheDocument());
    await waitFor(() => expect(filePicker()).toHaveFocus());
  });

  it("leaves focus alone when a run is removed with the mouse", async () => {
    const user = userEvent.setup();
    renderUpload([run("s1", "first.nii.gz"), run("s2", "second.nii.gz")]);
    const region = await currentRuns();
    await user.click(within(region).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current run" })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Current run" })).not.toHaveFocus();
    expect(filePicker()).not.toHaveFocus();
  });

  it("moves keyboard focus to the file picker after Cancel all", async () => {
    const user = userEvent.setup();
    const batch = { batchId: "b1", batchLabel: "Two scans", status: "Processing" as const, timestamp: Date.now() };
    renderUpload([run("s1", "a.nii.gz", batch), run("s2", "b.nii.gz", batch)]);
    const region = await currentRuns();
    const cancelAll = await within(region).findByRole("button", { name: "Cancel all" });
    cancelAll.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(region).queryByRole("button", { name: "Cancel all" })).not.toBeInTheDocument());
    await waitFor(() => expect(filePicker()).toHaveFocus());
  });

  it("gives the page a level 1 heading while a run hides the intro", async () => {
    renderUpload([run("s1", "first.nii.gz")]);
    await currentRuns();
    expect(screen.getByRole("heading", { level: 1, name: "Workspace" })).toBeInTheDocument();
  });

  it("adds no heading while the intro shows", async () => {
    renderUpload();
    await settled();
    expect(screen.queryByRole("heading", { level: 1, name: "Workspace" })).not.toBeInTheDocument();
  });
});
