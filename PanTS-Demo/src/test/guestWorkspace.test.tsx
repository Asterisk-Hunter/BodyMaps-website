import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UploadPage from "../routes/UploadPage";
import { setRecentUploadsAccount } from "../helpers/recentUploads";

const auth = vi.hoisted(() => ({ isAuthenticated: false, user: null, promptAuth: vi.fn(), refreshUsage: vi.fn(), redeemAdminCoupon: vi.fn() }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => auth }));
vi.mock("../components/CtPreview/CtPreview", () => ({ default: () => <div>Local preview</div> }));
vi.mock("../helpers/pendingUploads", async () => ({ ...(await vi.importActual<object>("../helpers/pendingUploads")), loadPendingUploads: async () => [] }));
const show = () => render(<MemoryRouter initialEntries={["/upload"]}><Routes>
  <Route path="/upload" element={<UploadPage />} /><Route path="/local-nifti" element={<h1>Local NIfTI viewer</h1>} />
  <Route path="/dicom" element={<h1>Local DICOM viewer</h1>} />
</Routes></MemoryRouter>);
beforeEach(() => {
  localStorage.clear(); setRecentUploadsAccount(null); vi.clearAllMocks();
  global.fetch = vi.fn(async () => { throw new Error("Guest workspace must not request a protected API"); });
});

describe("public workspace", () => {
  it("allows selecting and viewing a local scan without login or any upload", async () => {
    const user = userEvent.setup(); const { container } = show();
    await user.upload(container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, new File(["scan"], "private.nii.gz"));
    await user.click(screen.getByRole("button", { name: "View", exact: true }));
    expect(screen.getByRole("heading", { name: "Local NIfTI viewer" })).toBeInTheDocument();
    expect(auth.promptAuth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("allows local DICOM selection and view without server conversion", async () => {
    const user = userEvent.setup(); const { container } = show();
    fireEvent.change(container.querySelector<HTMLInputElement>('input[webkitdirectory]')!, { target: { files: [new File(["dicom"], "1.dcm")] } });
    await user.click(screen.getByRole("button", { name: "View", exact: true }));
    expect(screen.getByRole("heading", { name: "Local DICOM viewer" })).toBeInTheDocument();
    expect(auth.promptAuth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for sign-in on inference Run and sends no guest bytes before or after the prompt", async () => {
    const user = userEvent.setup(); const { container } = show();
    await user.click(screen.getByRole("button", { name: "None (view scan)", exact: true }));
    await user.click(within(document.getElementById("segmentation-options")!).getByText("ePAI", { exact: true }));
    expect(screen.getAllByText("Sign in to check availability")).toHaveLength(2);
    expect(screen.queryByText("Server availability could not be checked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Postprocessing: None (skip)" })).toBeDisabled();
    await user.upload(container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!, new File(["scan"], "private.nii.gz"));
    expect(auth.promptAuth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run", exact: true }));
    expect(auth.promptAuth).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("private.nii.gz")).toBeInTheDocument();
  });

  it("asks for sign-in before downloading the protected sample", async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole("button", { name: "Sample case" }));
    expect(auth.promptAuth).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});
