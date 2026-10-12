import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WorkspaceRunCard from "../components/WorkspaceRunCard";
import type { RecentUpload } from "../helpers/recentUploads";

const run: RecentUpload = { sessionId: "test", label: "My scan", model: "ePAI", status: "Processing", timestamp: Date.now() };

describe("observed pipeline stages", () => {
  it("does not invent running state, completion or percentage before status arrives", () => {
    render(<WorkspaceRunCard upload={run} />);
    expect(screen.getByRole("heading", { name: "Checking run status" })).toBeInTheDocument();
    expect(screen.queryByText("Complete", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("reports the real queue position without marking inference complete", () => {
    render(<WorkspaceRunCard upload={run} phase="queued" queuePosition={3} />);
    expect(screen.getByRole("heading", { name: "Number 3 in the GPU queue" })).toBeInTheDocument();
    const stages = within(screen.getByRole("list", { name: "Pipeline progress" })).getAllByRole("listitem");
    expect(stages[0]).toHaveTextContent("Scan received");
    expect(stages[1]).toHaveAttribute("aria-current", "step");
    expect(stages[2]).toHaveTextContent("Pending");
  });
  it.each(["Failed", "Cancelled"] as const)("lets %s override a stale running state", (status) => {
    render(<WorkspaceRunCard upload={{ ...run, status }} phase="running" estimate="2 minutes" />);
    expect(screen.queryByText("Running the selected pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated timing/)).not.toBeInTheDocument();
    expect(screen.queryByText("Complete", { exact: true })).not.toBeInTheDocument();
  });
  it("exposes the real completed result action", async () => {
    const open = vi.fn();
    render(<WorkspaceRunCard upload={{ ...run, status: "Completed" }} actions={<button onClick={open}>Open result</button>} />);
    expect(screen.getByRole("heading", { name: "Your results are ready" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open result" }));
    expect(open).toHaveBeenCalledOnce();
  });
});
