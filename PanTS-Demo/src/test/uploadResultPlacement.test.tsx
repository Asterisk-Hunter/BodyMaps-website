import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };
const CHUNK_SIZE = 512 * 1024;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const makeFile = (name: string) =>
  new File([new Uint8Array(CHUNK_SIZE)], name, { type: "application/gzip" });

describe("completed inference actions", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(url);
      if (endpoint.includes("/api/auth/me")) return json({ user: USER });
      if (endpoint.includes("/api/auth/oauth/providers")) return json({ google: true });
      if (endpoint.includes("/api/upload-inference-chunk")) return json({ ok: true });
      if (endpoint.includes("/api/finalize-upload")) {
        return json({ uploaded_filename: "scan.nii.gz" });
      }
      if (endpoint.includes("/api/run-epai-inference")) {
        const sessionId = String((init?.body as FormData).get("session_id"));
        return json({ message: "Segmentation started", session_id: sessionId });
      }
      if (endpoint.includes("/api/inference-status/")) {
        return json({ status: "completed" });
      }
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  // V6 keeps results in the conversation above a reusable upload composer.
  // A completed run must not consume or resize the next scan's dropzone.
  it("keeps a completed run above the composer while another scan is selected", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );

    const dropzone = container.querySelector(".dropzone")!;
    const dropzoneClassBefore = dropzone.className;

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "scan.nii.gz"));
    await waitFor(() => expect(within(dropzone).getByRole("status")).toHaveTextContent(/^Uploaded$/));
    await user.click(screen.getByRole("button", { name: "Run" }));

    const completedHeading = await screen.findByRole("heading", { name: "Your results are ready" });
    const currentRuns = screen.getByRole("region", { name: "Current runs" });
    expect(currentRuns).toContainElement(completedHeading);
    expect(completedHeading.closest(".dropzone")).toBeNull();
    expect(currentRuns.compareDocumentPosition(dropzone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(currentRuns).getByRole("button", { name: "View Visualization" })).toBeEnabled();
    expect(dropzone.className).toBe(dropzoneClassBefore);
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "next.nii.gz"));
    expect(await screen.findByText("next.nii.gz")).toBeInTheDocument();
    expect(completedHeading).toBeInTheDocument();
  });

  it("keeps a finished batch in the run thread with working details and no active spinner", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );

    const dropzone = container.querySelector(".dropzone")!;
    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await waitFor(() => {
      const statuses = within(dropzone).getAllByRole("status");
      expect(statuses).toHaveLength(2);
      for (const status of statuses) expect(status).toHaveTextContent(/^Uploaded$/);
    });
    await user.click(screen.getByRole("button", { name: "Run" }));

    const doneBar = await screen.findByText("Inference complete", {}, { timeout: 5000 });
    const currentRuns = screen.getByRole("region", { name: "Current runs" });
    expect(currentRuns).toContainElement(doneBar);
    expect(doneBar.closest(".dropzone")).toBeNull();
    expect(within(dropzone).getByRole("button", { name: "Select NIfTI file" })).toBeEnabled();
    // No Cancel button left once there's nothing to cancel.
    expect(screen.queryByRole("button", { name: "Cancel all" })).not.toBeInTheDocument();
    // The spinning icon next to the status line stops once nothing is running -
    // it was previously left spinning forever alongside "Inference complete".
    expect(currentRuns.querySelector(".upload-spinner")).toBeNull();
    expect(currentRuns.querySelector(".proc-done-icon")).not.toBeNull();

    // Viewing it releases the slot - the box goes back to normal instead of
    // holding onto a finished batch forever.
    await user.click(screen.getByRole("button", { name: "View details" }));
    await waitFor(() =>
      expect(screen.queryByText("Inference complete")).not.toBeInTheDocument(),
    );
  });
});
