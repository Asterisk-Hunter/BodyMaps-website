import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// What the plan allows is checked before a single byte goes up: a spent daily
// allowance, a batch bigger than what is left today or than the plan runs at
// once, and a model the plan has locked since it was picked. The server's 402
// stays the fallback, but it used to arrive only after the whole CT was sent.

const CHUNK_SIZE = 512 * 1024;
const HOUR = 60 * 60 * 1000;

let plan = "pro";
let scans: { used: number; limit: number | null; in_flight: number; resets_at: string | null };
let calls: string[] = [];

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const makeFile = (name: string) => new File([new Uint8Array(CHUNK_SIZE)], name, { type: "application/gzip" });

beforeEach(() => {
  plan = "pro";
  scans = { used: 0, limit: 3, in_flight: 0, resets_at: null };
  calls = [];
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/auth/me")) return json({ user: { id: "u1", email: "one@example.com", name: null, plan } });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/usage")) {
      return json({ plan, limits: {}, scans, ai_messages: { used: 0, limit: 10, resets_at: null } });
    }
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "scan.nii.gz" });
    if (u.includes("/api/run-epai-inference")) {
      return json({ message: "Segmentation started", session_id: String((init?.body as FormData).get("session_id")) });
    }
    if (u.includes("/api/inference-status/")) return json({ status: "queued" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const sent = () => calls.filter((u) => u.includes("/api/upload-inference-chunk") || u.includes("/api/run-epai-inference"));

// Lets every request the page has made (auth, usage, a pre-upload) answer.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const pick = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement, names: string[]) => {
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, names.map(makeFile));
  for (const name of names) expect(await screen.findByText(name)).toBeInTheDocument();
};

describe("the daily scan allowance", () => {
  it("is checked before anything uploads, with the reset time read as UTC", async () => {
    // The server writes UTC; a time without a zone must not be read as local time.
    scans = { used: 3, limit: 3, in_flight: 0, resets_at: new Date(Date.now() + 2 * HOUR).toISOString().replace("Z", "") };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: "ePAI" });
    await settle();

    await pick(user, container, ["a.nii.gz"]);
    await settle();
    // Not even a background pre-upload: the run could never start today.
    expect(sent()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "You've used your scans for today" })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(/available in about 2 hours\./);
    await settle();
    expect(sent()).toEqual([]);
  });

  it("asks for fewer files when some scans are left but not enough", async () => {
    scans = { used: 1, limit: 3, in_flight: 0, resets_at: new Date(Date.now() + 5 * HOUR).toISOString() };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: "ePAI" });
    await settle();

    await pick(user, container, ["a.nii.gz", "b.nii.gz", "c.nii.gz"]);
    await settle();
    expect(sent()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Not enough scans left for today" })).toBeInTheDocument();
    expect(within(dialog).getByText("Choose up to 2 files for today, or upgrade to run more.")).toBeInTheDocument();
    expect(sent()).toEqual([]);
  });

  it("leaves a full allowance whose window has passed to the server", async () => {
    scans = { used: 3, limit: 3, in_flight: 0, resets_at: new Date(Date.now() - HOUR).toISOString() };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: "ePAI" });
    await settle();

    await pick(user, container, ["a.nii.gz"]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.some((u) => u.includes("/api/run-epai-inference"))).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the upgrade dialog", () => {
  it("tells a batch bigger than the plan runs at once to choose fewer files", async () => {
    plan = "free";
    scans = { used: 0, limit: 1, in_flight: 0, resets_at: null };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: /LesionSegmenter/ });

    await pick(user, container, ["a.nii.gz", "b.nii.gz"]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "One scan at a time on Free" })).toBeInTheDocument();
    // Waiting for a running scan would not help: there is none, and two never fit.
    expect(within(dialog).getByText("Choose one file to run, or upgrade to run more at once.")).toBeInTheDocument();
  });

  it("takes focus, closes on Escape and gives focus back to Run", async () => {
    scans = { used: 3, limit: 3, in_flight: 0, resets_at: new Date(Date.now() + HOUR).toISOString() };
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: "ePAI" });
    await settle();
    await pick(user, container, ["a.nii.gz"]);

    const run = screen.getByRole("button", { name: "Run" });
    await user.click(run);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run).toHaveFocus();
  });
});

describe("a model the plan no longer includes", () => {
  it("opens the upgrade dialog on Run instead of uploading for it", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await screen.findByRole("button", { name: "ePAI" });

    // The plan changes while ePAI stays picked (another tab moved to Free).
    plan = "free";
    const asked = calls.filter((u) => u.includes("/api/auth/me")).length;
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing" }));
    });
    await waitFor(() => expect(calls.filter((u) => u.includes("/api/auth/me")).length).toBeGreaterThan(asked));
    await settle();
    expect(screen.getByRole("button", { name: "ePAI" })).toBeInTheDocument();

    await pick(user, container, ["a.nii.gz"]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("heading", { name: "ePAI needs Pro" })).toBeInTheDocument();
    await settle();
    expect(sent()).toEqual([]);
  });
});
