import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WorkspaceRunCard from "../components/WorkspaceRunCard";
import type { RecentUpload } from "../helpers/recentUploads";

const upload: RecentUpload = {
  sessionId: "preview-run", label: "Previewed scan", model: "ePAI", status: "Processing", timestamp: 1,
  pipeline: { preprocessing: null, postprocessing: null }, preprocessingPreview: "OpenVAE", postprocessingPreview: "ShapeKit",
};
const progress = (model: string) => screen.getByRole("progressbar", { name: `${model} preview animation` });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("animates labelled previews in order while exposing the real result immediately", () => {
  const view = render(<WorkspaceRunCard upload={upload} phase="queued" />);
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "0");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  act(() => vi.advanceTimersByTime(1000));
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "50");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  expect(screen.getByRole("heading", { name: "Queued for GPU" })).toBeInTheDocument();
  view.rerender(<WorkspaceRunCard upload={{ ...upload, status: "Completed" }} actions={<button>View result</button>} />);
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "100");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  expect(screen.getByRole("heading", { name: "Your results are ready" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View result" })).toBeEnabled();
  act(() => vi.advanceTimersByTime(1000));
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "50");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuetext", "50% of UI preview animation. No ShapeKit processing applied.");
  act(() => vi.advanceTimersByTime(1000));
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getAllByText("Not run")).toHaveLength(2);
  expect(screen.getAllByText("Preview animation finished. No processing applied.")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a finished frame for reloaded completed history without replaying timers", () => {
  const view = render(<WorkspaceRunCard upload={{ ...upload, status: "Completed" }} />);
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "100");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "100");
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<WorkspaceRunCard upload={{ ...upload, status: "Completed", label: "Renamed scan" }} />);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getAllByText("Not run")).toHaveLength(2);
});

it("does not carry animation state between different runs in the same card", () => {
  const view = render(<WorkspaceRunCard upload={upload} phase="queued" />);
  act(() => vi.advanceTimersByTime(500));
  view.rerender(<WorkspaceRunCard upload={{ ...upload, sessionId: "older-result", status: "Completed" }} />);
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "100");
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<WorkspaceRunCard upload={{ ...upload, sessionId: "new-run" }} phase="queued" />);
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "0");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
});

it.each(["Failed", "Cancelled"] as const)("stops preview timers on %s without claiming completion", (status) => {
  const view = render(<WorkspaceRunCard upload={upload} phase="running" />);
  act(() => vi.advanceTimersByTime(500));
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "25");
  view.rerender(<WorkspaceRunCard upload={{ ...upload, status }} phase="running" />);
  act(() => vi.advanceTimersByTime(5000));
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "25");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  expect(screen.getAllByText("Not run")).toHaveLength(2);
  expect(screen.getByRole("heading", { name: `Run ${status.toLowerCase()}` })).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears animation timers on unmount", () => {
  const view = render(<WorkspaceRunCard upload={upload} />);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("respects reduced motion without changing the actual inference state", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const view = render(<WorkspaceRunCard upload={upload} phase="queued" />);
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "100");
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "0");
  expect(screen.getByRole("heading", { name: "Queued for GPU" })).toBeInTheDocument();
  view.rerender(<WorkspaceRunCard upload={{ ...upload, status: "Completed" }} />);
  expect(progress("ShapeKit")).toHaveAttribute("aria-valuenow", "100");
  expect(vi.getTimerCount()).toBe(0);
});

it("finishes only the UI frame if reduced motion is enabled during animation", () => {
  let listener!: () => void;
  const motion = { matches: false, addEventListener: vi.fn((_event, callback) => { listener = callback; }), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", vi.fn(() => motion));
  const view = render(<WorkspaceRunCard upload={upload} phase="queued" />);
  act(() => { motion.matches = true; listener(); });
  expect(progress("OpenVAE")).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getByRole("heading", { name: "Queued for GPU" })).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(motion.removeEventListener).toHaveBeenCalled();
});
