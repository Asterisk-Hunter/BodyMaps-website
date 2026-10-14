import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// A file picked with a model selected starts uploading at once, before Run.
// When it is taken back before Run, what it sent is nobody's, so the page asks
// the server to delete it. An ask the server could not answer waits in this
// browser for the account that made it, and is sent again when it signs in.

const ONE = { id: "u1", email: "one@example.com", name: null, plan: "pro" };
const TWO = { id: "u2", email: "two@example.com", name: null, plan: "pro" };
const CHUNK_SIZE = 512 * 1024;

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

type Call = { url: string; owner: string | null };
let calls: Call[];
/** The account /api/auth/login signs in. */
let signsIn: typeof ONE;
/** Session id of each pre-upload, with the account that sent it. */
let uploads: Map<string, string>;
/** What /api/discard-upload answers the upload's own account. */
let ownersDiscard: () => ReturnType<typeof json>;
/** While set, chunk requests wait for it, whatever happens to the page. */
let chunkGate: Promise<void> | null;

beforeEach(() => {
  calls = [];
  signsIn = ONE;
  uploads = new Map();
  ownersDiscard = () => json({ status: "discarded" });
  chunkGate = null;
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const owner = (init?.headers as Record<string, string> | undefined)?.["X-Upload-Owner"] ?? null;
    calls.push({ url: u, owner });
    if (u.includes("/api/auth/me")) return json({ user: ONE });
    if (u.includes("/api/auth/login")) return json({ user: signsIn });
    if (u.includes("/api/auth/logout")) return json({ ok: true });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      uploads.set(String((init?.body as FormData).get("session_id")), owner ?? "");
      await chunkGate;
      return json({ ok: true });
    }
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "scan.nii.gz" });
    if (u.includes("/api/discard-upload/")) {
      // The server deletes an upload only for the account that sent it.
      const sid = u.slice(u.lastIndexOf("/") + 1);
      return uploads.get(sid) === owner ? ownersDiscard() : json({ error: "You don't have access to this upload." }, false, 403);
    }
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const discards = (sid: string) => calls.filter((c) => c.url.endsWith(`/api/discard-upload/${sid}`));

// Stand-ins for the header's sign-in and sign-out, and the sidebar's New run.
const Controls = () => {
  const { signIn, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => void signIn("someone@example.com", "pw")}>test sign in</button>
      <button type="button" onClick={() => void signOut()}>test sign out</button>
      <button type="button" onClick={() => navigate("/upload#scan-composer", { state: { newWorkspaceRun: crypto.randomUUID() } })}>
        test new run
      </button>
    </>
  );
};

const pickScan = async () => {
  const user = userEvent.setup();
  const { container } = render(
    <AuthProvider>
      <MemoryRouter>
        <Controls />
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );
  await screen.findByRole("button", { name: /^ePAI$/ });
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE)], "scan.nii.gz"));
  await waitFor(() => expect(uploads.size).toBe(1));
  const [sid] = uploads.keys();
  return { user, sid };
};

describe("a scan uploaded before Run and taken back", () => {
  it("is deleted on the server when New run clears it", async () => {
    const { user, sid } = await pickScan();
    await screen.findByText("Uploaded");

    await user.click(screen.getByRole("button", { name: "test new run" }));

    expect(screen.queryByRole("button", { name: "Remove scan.nii.gz" })).not.toBeInTheDocument();
    await waitFor(() => expect(discards(sid)).toHaveLength(1));
    expect(discards(sid)[0].owner).toBe("u1");
  });

  it("is deleted at the next sign-in of its account when it stopped only after that account signed out", async () => {
    let openChunks!: () => void;
    chunkGate = new Promise((resolve) => { openChunks = resolve; });
    const { user, sid } = await pickScan();

    await user.click(screen.getByRole("button", { name: "Remove scan.nii.gz" }));
    await user.click(screen.getByRole("button", { name: "test sign out" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/auth/logout"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    openChunks();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discards(sid)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(1));
    expect(discards(sid)[0].owner).toBe("u1");
  });

  it("is asked for again only by its own account when the first ask met a lapsed sign-in", async () => {
    const { user, sid } = await pickScan();
    await screen.findByText("Uploaded");
    ownersDiscard = () => json({ error: "Sign in" }, false, 401);
    await user.click(screen.getByRole("button", { name: "Remove scan.nii.gz" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(1));

    // Someone else signs in on this browser: it is not theirs to delete.
    signsIn = TWO;
    ownersDiscard = () => json({ status: "discarded" });
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByRole("button", { name: /^ePAI$/ });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discards(sid)).toHaveLength(1);

    // Its own account signs in again: it is sent, once.
    signsIn = ONE;
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(2));
    expect(discards(sid)[1].owner).toBe("u1");
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discards(sid)).toHaveLength(2);
  });

  it("is asked for again at its account's next sign-in when another tab had changed the account", async () => {
    const { user, sid } = await pickScan();
    await screen.findByText("Uploaded");
    // Another tab signed in to another account, so the server sees that account's cookie.
    ownersDiscard = () => json({ error: "Your signed-in account changed.", code: "account_changed" }, false, 409);
    await user.click(screen.getByRole("button", { name: "Remove scan.nii.gz" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    ownersDiscard = () => json({ status: "discarded" });
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(2));
    expect(discards(sid)[1].owner).toBe("u1");
  });

  it("is not asked for again once the server says the scan belongs to a run", async () => {
    const { user, sid } = await pickScan();
    await screen.findByText("Uploaded");
    ownersDiscard = () => json({ error: "This scan has already been run." }, false, 409);
    await user.click(screen.getByRole("button", { name: "Remove scan.nii.gz" }));
    await waitFor(() => expect(discards(sid)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByRole("button", { name: /^ePAI$/ });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discards(sid)).toHaveLength(1);
  });
});
