import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BatchDetailsModal from "../components/BatchDetailsModal";
import type { RecentUpload } from "../helpers/recentUploads";

const completed: RecentUpload = { sessionId: "local-test", label: "Synthetic scan", status: "Completed", model: "ePAI", timestamp: Date.now() };
const handlers = () => ({ onClose: vi.fn(), onView: vi.fn(), onDownloadScan: vi.fn(), onDownloadAll: vi.fn() });

describe("batch download controls", () => {
  it("prevents duplicate batch/individual requests while bundling and exposes progress in the dialog", async () => {
    const user = userEvent.setup();
    const callbacks = handlers();
    render(<BatchDetailsModal {...callbacks} label="Test batch" uploads={[completed]} downloadBusy downloadMessage="Preparing batch: 1 of 2 completed results received." />);
    const all = screen.getByRole("button", { name: "Preparing..." });
    const single = screen.getByRole("button", { name: "Download", exact: true });
    expect(all).toBeDisabled();
    expect(single).toBeDisabled();
    await user.click(all);
    await user.click(single);
    expect(callbacks.onDownloadAll).not.toHaveBeenCalled();
    expect(callbacks.onDownloadScan).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2 completed results");
  });

  it("leaves individual downloads available after a size error and never offers a batch with no completed scans", async () => {
    const callbacks = handlers();
    const { rerender } = render(<BatchDetailsModal {...callbacks} label="Test batch" uploads={[completed]} downloadMessage="Download failed: This batch is too large. Download each completed scan individually." />);
    expect(screen.getByRole("status")).toHaveTextContent("Download each completed scan individually");
    await userEvent.setup().click(screen.getByRole("button", { name: "Download", exact: true }));
    expect(callbacks.onDownloadScan).toHaveBeenCalledWith(completed);
    rerender(<BatchDetailsModal {...callbacks} label="Test batch" uploads={[{ ...completed, status: "Failed" }]} />);
    expect(screen.getByRole("button", { name: "Download completed" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Download", exact: true })).not.toBeInTheDocument();
  });
});
