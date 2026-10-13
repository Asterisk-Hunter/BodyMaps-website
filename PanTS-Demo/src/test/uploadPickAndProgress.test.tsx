import { Profiler } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { groupUploads, recentUploadsStorageKey, splitByAge, type RecentUpload } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Picking and dropping scans on the Upload page, and how a run reads while it
// goes and once it ends: files the server can never take are refused at the
// pick, DICOM folders and slices can be dropped, the estimate keeps counting
// from the model step's real start, a failed run never gets the result card,
// a finished batch is announced, and an idle page sits still.

vi.mock("../components/CtPreview/CtPreview", () => ({ default: () => <div>CT preview</div> }));

const CHUNK_SIZE = 512 * 1024;
const MINUTE = 60 * 1000;
const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const makeFile = (name: string, size = CHUNK_SIZE) => new File([new Uint8Array(size)], name, { type: "application/gzip" });

let calls: string[] = [];
/** Answers a request before the defaults below; undefined falls through. */
let route: (url: string, init?: RequestInit) => unknown;
/** Session ids in the order their run requests reached the server. */
let runs: string[] = [];
/** What inference-status says for each of those, by its place in `runs`. */
let statusByRun: string[] = [];

beforeEach(() => {
  calls = [];
  runs = [];
  statusByRun = [];
  route = () => undefined;
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const answer = await route(u, init);
    if (answer) return answer;
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "scan.nii.gz" });
    if (u.includes("/api/run-epai-inference")) {
      const sid = String((init?.body as FormData).get("session_id"));
      runs.push(sid);
      return json({ message: "Segmentation started", session_id: sid });
    }
    if (u.includes("/api/inference-status/")) {
      const at = runs.findIndex((sid) => u.endsWith(`/${sid}`));
      return json({ status: statusByRun[at] ?? "queued" });
    }
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = (onCommit?: () => void) =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <Profiler id="upload" onRender={() => onCommit?.()}>
          <UploadPage />
        </Profiler>
      </MemoryRouter>
    </AuthProvider>,
  );

const signedIn = () => screen.findByRole("button", { name: "ePAI" });
const niftiInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
const statusLine = (container: HTMLElement) => container.querySelector(".status-msg")?.textContent ?? "";

describe("picking NIfTI files", () => {
  it("leaves out an empty file and one over the chunk limit and adds the rest", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();

    const huge = makeFile("huge.nii.gz", 1);
    Object.defineProperty(huge, "size", { value: 10_000 * CHUNK_SIZE + 1 });
    await user.upload(niftiInput(container), [makeFile("empty.nii.gz", 0), huge, makeFile("ok.nii.gz")]);

    expect(await screen.findByText("ok.nii.gz")).toBeInTheDocument();
    expect(statusLine(container)).toBe(
      "empty.nii.gz is empty (0 bytes). Download or export it again and select it once more. 1 other file was also left out.",
    );
    expect(screen.queryByRole("button", { name: "Remove empty.nii.gz" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove huge.nii.gz" })).toBeNull();
  });

  it("says a file is past the limit when it is the only one", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();

    const huge = makeFile("huge.nii.gz", 1);
    Object.defineProperty(huge, "size", { value: 10_000 * CHUNK_SIZE + 1 });
    await user.upload(niftiInput(container), huge);

    await waitFor(() => expect(statusLine(container)).toBe("huge.nii.gz is too large to upload. The limit is about 4.8 GiB."));
    expect(container.querySelector(".file-chip")).toBeNull();
  });

  it("says which files it takes when none of the picked ones is a NIfTI file", async () => {
    const { container } = renderUpload();
    await signedIn();

    fireEvent.change(niftiInput(container), { target: { files: [makeFile("photo.png", 10)] } });

    await waitFor(() => expect(statusLine(container)).toBe("Please select .nii or .nii.gz files only"));
    expect(container.querySelector(".file-chip")).toBeNull();
  });

  it("words the server's refusal of the file's size without asking to press Run again", async () => {
    route = (u) => (u.includes("/api/upload-inference-chunk")
      ? json({ error: "Chunk index is outside upload bounds" }, false, 400) : undefined);
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();

    await user.upload(niftiInput(container), makeFile("scan.nii.gz"));
    await waitFor(() => expect(statusLine(container)).toBe(
      "scan.nii.gz could not be uploaded. The server can't take this file because it is empty or too large (the limit is about 4.8 GiB). Check the file and select it again.",
    ));
  });
});

// A FileSystemEntry tree as webkitGetAsEntry hands it over during a drop.
const fileEntry = (file: File) => ({ isFile: true, isDirectory: false, name: file.name, file: (ok: (f: File) => void) => ok(file) });
const folderEntry = (name: string, children: unknown[]) => ({
  isFile: false, isDirectory: true, name,
  createReader: () => {
    let read = false;
    return { readEntries: (ok: (batch: unknown[]) => void) => { ok(read ? [] : children); read = true; } };
  },
});
const drop = (container: HTMLElement, files: File[], entries: unknown[]) =>
  fireEvent.drop(container.querySelector(".dropzone")!, {
    dataTransfer: { files, items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })) },
  });

describe("dropping on the drop zone", () => {
  it("reads a dropped DICOM folder as a series", async () => {
    const { container } = renderUpload();
    await signedIn();
    const slices = ["IM0001.dcm", "IM0002.dcm", "IM0003.dcm"].map((name) => makeFile(name, 10));
    const folder = folderEntry("series", [...slices.map(fileEntry), fileEntry(makeFile("notes.txt", 10))]);

    drop(container, [makeFile("series", 0)], [folder]);
    expect(await screen.findByText("DICOM series (3 slices)")).toBeInTheDocument();
  });

  it("takes the NIfTI file from a folder that also holds slices, and says so", async () => {
    const { container } = renderUpload();
    await signedIn();
    const inside = [makeFile("ct.nii.gz"), makeFile("._ct.nii.gz", 10), makeFile("IM0001.dcm", 10), makeFile("IM0002.dcm", 10)];
    drop(container, [makeFile("case", 0)], [folderEntry("case", [folderEntry("scans", inside.map(fileEntry))])]);

    expect(await screen.findByText("ct.nii.gz")).toBeInTheDocument();
    expect(screen.queryByText("._ct.nii.gz")).toBeNull();
    await waitFor(() => expect(statusLine(container)).toBe(
      "The 2 DICOM slices in that folder were left out because it also holds a NIfTI file. To view the slices, select a folder with only the slices.",
    ));
  });

  it("takes loose DICOM slices as one series and refuses other files", async () => {
    const { container } = renderUpload();
    await signedIn();
    const slices = ["1.dcm", "2.dcm"].map((name) => makeFile(name, 10));
    drop(container, slices, slices.map(fileEntry));
    expect(await screen.findByText("DICOM series (2 slices)")).toBeInTheDocument();

    const image = makeFile("photo.png", 10);
    drop(container, [image], [fileEntry(image)]);
    await waitFor(() => expect(statusLine(container)).toBe("Please drop .nii or .nii.gz files or a DICOM series"));
  });

  it("takes a dropped file without an extension as a slice only when it reads as DICOM", async () => {
    const { container } = renderUpload();
    await signedIn();
    const license = makeFile("LICENSE", 200);
    drop(container, [license], [fileEntry(license)]);
    await waitFor(() => expect(statusLine(container)).toBe("Please drop .nii or .nii.gz files or a DICOM series"));
    expect(screen.queryByText("DICOM series (1 slice)")).toBeNull();

    // A DICOM file carries "DICM" after its 128-byte preamble.
    const bytes = new Uint8Array(200);
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128);
    const slice = new File([bytes], "IM000001");
    drop(container, [slice], [fileEntry(slice)]);
    expect(await screen.findByText("DICOM series (1 slice)")).toBeInTheDocument();
  });

  it("takes the NIfTI files from a drop that also holds slices, and says the rest was left out", async () => {
    const { container } = renderUpload();
    await signedIn();
    const dropped = [makeFile("ct.nii.gz"), makeFile("IM0001.dcm", 10), makeFile("IM0002.dcm", 10)];
    drop(container, dropped, dropped.map(fileEntry));

    expect(await screen.findByText("ct.nii.gz")).toBeInTheDocument();
    expect(screen.queryByText(/^DICOM series/)).toBeNull();
    await waitFor(() => expect(statusLine(container)).toBe(
      "2 dropped DICOM slices were left out. To add a DICOM series, drop it on its own.",
    ));
  });

  it("counts only the files that read as DICOM among those dropped with a NIfTI file", async () => {
    const { container } = renderUpload();
    await signedIn();
    // A DICOM file carries "DICM" after its 128-byte preamble; a README and a LICENSE do not.
    const bytes = new Uint8Array(200);
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128);
    const dropped = [makeFile("ct.nii.gz"), makeFile("README", 200), makeFile("LICENSE", 200), new File([bytes], "IM000001")];
    drop(container, dropped, dropped.map(fileEntry));

    expect(await screen.findByText("ct.nii.gz")).toBeInTheDocument();
    await waitFor(() => expect(statusLine(container)).toBe(
      "1 dropped DICOM slice was left out. To add a DICOM series, drop it on its own.",
    ));
  });

  it("says nothing was left out when only other files came with the NIfTI file", async () => {
    const { container } = renderUpload();
    await signedIn();
    const dropped = [makeFile("ct.nii.gz"), makeFile("README", 200), makeFile("LICENSE", 200)];
    drop(container, dropped, dropped.map(fileEntry));

    expect(await screen.findByText("ct.nii.gz")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statusLine(container)).not.toMatch(/left out/);
  });

  it("counts the slices in a folder dropped with a NIfTI file", async () => {
    const { container } = renderUpload();
    await signedIn();
    const scan = makeFile("ct.nii.gz");
    const inside = [makeFile("IM0001.dcm", 10), makeFile("IM0002.dcm", 10), makeFile("README", 200)];
    drop(container, [scan, makeFile("series", 0)], [fileEntry(scan), folderEntry("series", inside.map(fileEntry))]);

    expect(await screen.findByText("ct.nii.gz")).toBeInTheDocument();
    await waitFor(() => expect(statusLine(container)).toBe(
      "2 dropped DICOM slices were left out. To add a DICOM series, drop it on its own.",
    ));
  });

  it("does not open the NIfTI chooser when Upload DICOM clicks its own hidden input", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();
    const click = vi.spyOn(HTMLInputElement.prototype, "click");

    await user.click(screen.getByRole("button", { name: "Select DICOM" }));
    const clicked = click.mock.contexts as HTMLInputElement[];
    expect(clicked.length).toBeGreaterThan(0);
    expect(clicked).not.toContain(niftiInput(container));
  });
});

describe("previewing while the scan uploads", () => {
  it("shows the preview while the background upload is still sending", async () => {
    route = (u, init) => (u.includes("/api/upload-inference-chunk")
      ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      : undefined);
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();

    await user.upload(niftiInput(container), makeFile("scan.nii.gz"));
    await screen.findByText("Uploading 0%");
    await user.click(screen.getByRole("button", { name: "Preview scan.nii.gz" }));
    expect(await screen.findByText("CT preview")).toBeInTheDocument();
  });
});

const seedRun = (run: Partial<RecentUpload>) =>
  localStorage.setItem(recentUploadsStorageKey(USER.id), JSON.stringify([{
    sessionId: "s1", label: "Abdomen run", model: "ePAI", status: "Processing", timestamp: Date.now() - 30 * MINUTE, ...run,
  }]));
const runningReply = (stages?: unknown) => (u: string) => (u.includes("/api/inference-status/s1")
  ? json({ status: "running", ...(stages ? { pipeline_stages: stages } : {}) }) : undefined);
const segmentationStartedAt = (iso: string) => [
  { id: "segmentation", model: "ePAI", status: "running", started_at: iso, completed_at: null, error: null },
  { id: "packaging", model: null, status: "queued", started_at: null, completed_at: null, error: null },
];

describe("the time-left estimate of a run this page did not start", () => {
  it("counts from the server's start of the model step", async () => {
    seedRun({});
    route = runningReply(segmentationStartedAt(new Date(Date.now() - 10 * MINUTE).toISOString()));
    renderUpload();
    expect(await screen.findByText("Estimated timing: Taking longer than estimated")).toBeInTheDocument();
  });

  it("counts from a start saved by the page that saw it", async () => {
    seedRun({});
    localStorage.setItem("scanRunTiming", JSON.stringify({ s1: { startedAt: Date.now() - 10 * MINUTE, sizeBytes: 1000, savedAt: Date.now() } }));
    route = runningReply();
    renderUpload();
    expect(await screen.findByText("Estimated timing: Taking longer than estimated")).toBeInTheDocument();
  });

  it("shows no estimate when nothing says when it started", async () => {
    seedRun({});
    route = runningReply();
    renderUpload();
    expect(await screen.findByRole("heading", { name: "Running ePAI on your scan." })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText(/^Estimated timing/)).toBeNull();
  });
});

describe("a run that ends after another one finished", () => {
  it("gets the result buttons only if it completed", async () => {
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
    route = async (u) => {
      if (u.includes("/api/run-epai-inference") && runs.length === 1) await secondHeld;
      return undefined;
    };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();

    // The first scan runs and waits in the queue; the second is started while it waits.
    await user.upload(niftiInput(container), makeFile("a.nii.gz"));
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runs).toHaveLength(1));
    await user.upload(niftiInput(container), makeFile("b.nii.gz"));
    await user.click(screen.getByRole("button", { name: "Run" }));

    // The first one finishes before the second's run request is answered.
    statusByRun = ["completed", "failed"];
    // Polls come every 2.5 seconds.
    await waitFor(() => {
      const stored: RecentUpload[] = JSON.parse(localStorage.getItem(recentUploadsStorageKey(USER.id)) || "[]");
      expect(stored.find((u) => u.sessionId === runs[0])?.status).toBe("Completed");
    }, { timeout: 5000 });
    releaseSecond();
    await waitFor(() => expect(runs).toHaveLength(2));
    const thread = screen.getByRole("region", { name: "Current runs" });
    expect(await within(thread).findByRole("heading", { name: "Run failed" }, { timeout: 5000 })).toBeInTheDocument();
    expect(within(thread).queryByRole("button", { name: "View Visualization" })).toBeNull();
    expect(within(thread).queryByRole("button", { name: "Download Results" })).toBeNull();
    expect(within(thread).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});

describe("a batch that stops running", () => {
  it("is announced with how its scans ended", async () => {
    statusByRun = ["completed", "failed"];
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();
    const announcement = container.querySelector("span.sr-only[aria-live]")!;
    expect(announcement).toBeEmptyDOMElement();

    await user.upload(niftiInput(container), [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(announcement).toHaveTextContent("2 scans: 1 of 2 complete, 1 failed"), { timeout: 5000 });
  });
});

describe("the batch details dialog", () => {
  it("does not show a download line from a dialog closed earlier", async () => {
    let failResult!: () => void;
    const resultHeld = new Promise<void>((resolve) => { failResult = resolve; });
    route = async (u) => {
      if (!u.includes("/api/get_result/")) return undefined;
      await resultHeld;
      throw new Error("The connection dropped.");
    };
    statusByRun = ["completed", "completed"];
    const user = userEvent.setup();
    const { container } = renderUpload();
    await signedIn();
    await user.upload(niftiInput(container), [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Inference complete", {}, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "View details" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getAllByRole("button", { name: "Download" })[0]);
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Preparing download..."));
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    // The download fails with the dialog closed: the page's status line says so.
    await act(async () => { failResult(); await resultHeld; });
    await waitFor(() => expect(statusLine(container)).toMatch(/^Download failed/));

    await user.click(screen.getByRole("button", { name: "View details" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("status")).toBeNull();
  });
});

describe("splitting finished runs for the Upload page and History", () => {
  const scan = (sessionId: string, status: RecentUpload["status"], viewed = false): RecentUpload => ({
    sessionId, label: sessionId, model: "ePAI", status, timestamp: Date.now(), batchId: "b1", batchLabel: "3 scans", viewed,
  });

  it("judges a batch by the scans that can be opened", () => {
    const opened = splitByAge(groupUploads([scan("a", "Completed", true), scan("b", "Failed"), scan("c", "Cancelled")]));
    expect(opened.older).toHaveLength(1);
    const waiting = splitByAge(groupUploads([scan("a", "Completed"), scan("b", "Failed")]));
    expect(waiting.recent).toHaveLength(1);
    // Nothing to open: it waits for the age cutoff like any unviewed batch.
    const nothing = splitByAge(groupUploads([scan("a", "Failed"), scan("b", "Cancelled")]));
    expect(nothing.recent).toHaveLength(1);
  });
});

describe("while idle", () => {
  // The intro's count-up animates for its first seconds; with reduced motion
  // it shows the final numbers at once, so only the page itself is measured.
  const reduceMotion = () =>
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);

  it("does not re-render once a second", async () => {
    reduceMotion();
    let commits = 0;
    renderUpload(() => {
      commits += 1;
    });
    await signedIn();
    // Let the auth, plan and usage requests land. This first second also
    // absorbs the one empty pass React may make the first time a state
    // update turns out to change nothing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1200)));
    const before = commits;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2200)));
    expect(commits).toBe(before);
  });

  it("stops re-rendering once a second when the account whose scan was running signs out", async () => {
    reduceMotion();
    seedRun({});
    route = runningReply();
    const SignOut = () => {
      const { signOut } = useAuth();
      return <button type="button" onClick={() => void signOut()}>test sign out</button>;
    };
    let commits = 0;
    render(
      <AuthProvider>
        <MemoryRouter>
          <SignOut />
          <Profiler id="upload" onRender={() => { commits += 1; }}>
            <UploadPage />
          </Profiler>
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Running ePAI on your scan." })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "test sign out" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Running ePAI on your scan." })).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 1200)));
    const before = commits;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2200)));
    expect(commits).toBe(before);
  });
});
