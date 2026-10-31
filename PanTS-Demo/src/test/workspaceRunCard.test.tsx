import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WorkspaceRunCard from "../components/WorkspaceRunCard";
import type { RecentUpload } from "../helpers/recentUploads";
import { loadRecentUploads, setRecentUploadsAccount } from "../helpers/recentUploads";
import { mergeServerHistory } from "../helpers/serverHistory";

const run: RecentUpload = { sessionId: "test", label: "My scan", model: "ePAI", status: "Processing", timestamp: Date.now() };

describe("observed pipeline stages", () => {
  it("retains executed pipeline and reconstructed-CT warning when restored on another device", () => {
    localStorage.clear();
    setRecentUploadsAccount('restored-owner');
    mergeServerHistory('restored-owner', [{ session_id: 'restored-pipeline', model: 'LesionSegmenter', status: 'completed', created_at: '2026-10-23T12:00:00',
      pipeline: { preprocessing: 'OpenVAE', postprocessing: 'ShapeKit' },
      pipeline_stages: [{ id: 'segmentation', model: 'LesionSegmenter', status: 'completed', error: null }],
    }]);
    render(<WorkspaceRunCard upload={loadRecentUploads()[0]} />);
    expect(screen.getByText('Segmentation used the reconstructed CT; the viewer retains the original CT.')).toBeInTheDocument();
    expect(screen.getAllByText(/OpenVAE/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ShapeKit/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not selected')).not.toBeInTheDocument();
  });
  it("does not invent running state, completion or percentage before status arrives", () => {
    render(<WorkspaceRunCard upload={run} />);
    expect(screen.getByRole("heading", { name: "Checking run status" })).toBeInTheDocument();
    expect(screen.queryByText("Done", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("reports the real queue position without marking inference complete", () => {
    render(<WorkspaceRunCard upload={run} phase="queued" queuePosition={3} />);
    expect(screen.getByRole("heading", { name: "Number 3 in the GPU queue" })).toBeInTheDocument();
    const stages = within(screen.getByRole("list", { name: "Pipeline progress" })).getAllByRole("listitem");
    expect(stages[0]).toHaveTextContent("Scan received");
    expect(stages).toHaveLength(5);
    expect(stages[1]).toHaveTextContent("PreprocessingNot selectedSkipped");
    expect(stages[2]).toHaveAttribute("aria-current", "step");
    expect(stages[2]).toHaveTextContent("Queued");
    expect(stages[3]).toHaveTextContent("PostprocessingNot selectedSkipped");
    expect(stages[4]).toHaveTextContent("Pending");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it.each([
    ["admitting", "Starting your run"],
    ["admission-pending", "Waiting for server confirmation"],
  ])("marks the scan received during %s without claiming model execution", (phase, headline) => {
    render(<WorkspaceRunCard upload={run} phase={phase} />);
    expect(screen.getByRole("heading", { name: headline })).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Pipeline progress" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Uploading scanScan receivedDone");
    expect(rows[2]).toHaveTextContent("Segmenting with ePAIWaiting for model statusPending");
    expect(rows[4]).toHaveTextContent("Pending");
    expect(screen.getAllByText("Done", { exact: true })).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(rows[2]).not.toHaveAttribute("aria-current");
  });
  it.each(["waiting", "uploading"])("does not mark the scan received during %s", (phase) => {
    render(<WorkspaceRunCard upload={run} phase={phase} />);
    const row = screen.getByText("Uploading scan").closest("li")!;
    expect(within(row).queryByText("Scan received")).not.toBeInTheDocument();
    expect(within(row).queryByText("Done", { exact: true })).not.toBeInTheDocument();
  });
  it.each(["Failed", "Cancelled"] as const)("lets %s override a stale running state", (status) => {
    render(<WorkspaceRunCard upload={{ ...run, status }} phase="running" estimate="2 minutes" />);
    expect(screen.queryByText("Running the selected pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated timing/)).not.toBeInTheDocument();
    expect(screen.queryByText("Done", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument();
    expect(screen.getByText("Uploading scan").closest("li")).toHaveTextContent("Scan transfer not confirmedNot confirmed");
    expect(screen.getByText("Segmenting with ePAI").closest("li")).toHaveTextContent("Completion not confirmedNot completed");
    expect(screen.getByText("Preparing results").closest("li")).toHaveTextContent("No completed resultUnavailable");
  });
  it("shows the five vertical stages with an indeterminate real-model bar", () => {
    const view = render(<WorkspaceRunCard upload={run} phase="running" />);
    const list = screen.getByRole("list", { name: "Pipeline progress" });
    expect(within(list).getAllByRole("listitem").map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "Uploading scan", "Preprocessing", "Segmenting with ePAI", "Postprocessing", "Preparing results",
    ]);
    const bar = screen.getByRole("progressbar", { name: "Segmenting with ePAI: processing" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuetext");
    expect(bar.closest("li")).toHaveTextContent("Processing");
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    const chips = view.container.querySelector(".workspace-run-chips")!;
    expect(chips.children).toHaveLength(3);
    expect(chips.children[0]).toHaveTextContent("PreNone");
    expect(chips.children[2]).toHaveTextContent("PostNone");
    view.rerender(<WorkspaceRunCard upload={{ ...run, status: "Completed" }} phase="running" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(list).getAllByText("Done", { exact: true })).toHaveLength(3);
    expect(within(list).getAllByText("Skipped", { exact: true })).toHaveLength(2);
  });
  it("uses observed stage order and does not animate later pending stages", () => {
    render(<WorkspaceRunCard upload={{ ...run, pipeline: { preprocessing: "OpenVAE", postprocessing: "ShapeKit" }, pipelineStages: [
      { id: "postprocessing", model: "ShapeKit", status: "queued", started_at: null, completed_at: null, error: null },
      { id: "preprocessing", model: "OpenVAE", status: "running", started_at: null, completed_at: null, error: null },
      { id: "packaging", model: null, status: "queued", started_at: null, completed_at: null, error: null },
      { id: "segmentation", model: "ePAI", status: "queued", started_at: null, completed_at: null, error: null },
    ] }} phase="running" />);
    const rows = within(screen.getByRole("list", { name: "Pipeline progress" })).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent("Preprocessing with OpenVAE");
    expect(rows[2]).toHaveTextContent("Segmenting with ePAIWaiting for this stepPending");
    expect(rows[3]).toHaveTextContent("Postprocessing with ShapeKitWaiting for this stepPending");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "Preprocessing with OpenVAE: processing" })).not.toHaveAttribute("aria-valuenow");
  });
  it("does not guess the active stage when a selected pipeline has no stage telemetry", () => {
    render(<WorkspaceRunCard upload={{ ...run, pipeline: { preprocessing: "OpenVAE", postprocessing: "ShapeKit" } }} phase="running" />);
    expect(screen.getByRole("heading", { name: "Running ePAI on your scan." })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Segmenting with ePAI").closest("li")).toHaveTextContent("Waiting for model statusPending");
  });
  it("stops the actual-stage bar when completion precedes refreshed stage telemetry", () => {
    render(<WorkspaceRunCard upload={{ ...run, status: "Completed", pipelineStages: [
      { id: "segmentation", model: "ePAI", status: "running", started_at: null, completed_at: null, error: null },
      { id: "packaging", model: null, status: "queued", started_at: null, completed_at: null, error: null },
    ] }} phase="running" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Segmenting with ePAI").closest("li")).toHaveTextContent("Done");
    expect(screen.getByText("Preparing results").closest("li")).toHaveTextContent("Done");
  });
  it("exposes the real completed result action", async () => {
    const open = vi.fn();
    render(<WorkspaceRunCard upload={{ ...run, status: "Completed" }} actions={<button onClick={open}>Open result</button>} />);
    expect(screen.getByRole("heading", { name: "Your results are ready" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open result" }));
    expect(open).toHaveBeenCalledOnce();
  });
});
