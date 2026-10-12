import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ProcessingSummaryBar from "../components/ProcessingSummaryBar";

describe("batch outcome summary", () => {
  it("retains every scan in the denominator as a mixed batch finishes", () => {
    const { rerender, container } = render(<ProcessingSummaryBar running={2} done={0} failed={1} cancelled={1} statusLabel="Running" />);
    expect(screen.getByRole("img", { name: "0 of 4 scans completed successfully" })).toBeInTheDocument();
    expect(screen.getByText("0/4 successful")).toBeInTheDocument();
    expect(screen.getByText(/2 in progress · 1 failed · 1 cancelled/)).toBeInTheDocument();
    expect(container.querySelector(".proc-spinner")).not.toBeNull();

    rerender(<ProcessingSummaryBar running={1} done={1} failed={1} cancelled={1} statusLabel="Running" />);
    expect(screen.getByRole("img", { name: "1 of 4 scans completed successfully" })).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();

    rerender(<ProcessingSummaryBar running={0} done={2} failed={1} cancelled={1} statusLabel="Finished" />);
    expect(screen.getByRole("img", { name: "2 of 4 scans completed successfully" })).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(container.querySelector(".proc-spinner")).toBeNull();
    expect(container.querySelector(".proc-done-icon")).toBeNull();
    expect(container.querySelector(".proc-attention-icon")).not.toBeNull();
  });

  it.each([
    { failed: 2, cancelled: 0, outcome: "2 failed" },
    { failed: 0, cancelled: 2, outcome: "2 cancelled" },
  ])("does not show a success check when every scan is $outcome", ({ failed, cancelled, outcome }) => {
    const { container } = render(<ProcessingSummaryBar running={0} done={0} failed={failed} cancelled={cancelled} statusLabel="Finished" />);
    expect(screen.getByText("0/2 successful")).toBeInTheDocument();
    expect(screen.getByText(`Finished · ${outcome}`)).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(container.querySelector(".proc-done-icon")).toBeNull();
    expect(container.querySelector(".proc-attention-icon")).not.toBeNull();
  });

  it("preserves successful callers that omit the optional outcome counts", () => {
    const { container } = render(<ProcessingSummaryBar running={0} done={2} statusLabel="Inference complete" />);
    expect(screen.getByText("2/2 successful")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(container.querySelector(".proc-done-icon")).not.toBeNull();
    expect(container.querySelector(".proc-attention-icon")).toBeNull();
  });

  it("does not mark an empty batch successful", () => {
    const { container } = render(<ProcessingSummaryBar running={0} done={0} statusLabel="No scans" />);
    expect(screen.getByRole("img", { name: "0 of 0 scans completed successfully" })).toBeInTheDocument();
    expect(container.querySelector(".proc-done-icon")).toBeNull();
    expect(container.querySelector(".proc-attention-icon")).toBeNull();
  });

  it("keeps details and cancellation controls operational", async () => {
    const user = userEvent.setup();
    const details = vi.fn(), cancel = vi.fn();
    render(<ProcessingSummaryBar running={1} done={1} failed={1} statusLabel="Queued" onViewDetails={details} onCancelAll={cancel} />);
    await user.click(screen.getByRole("button", { name: "View details" }));
    await user.click(screen.getByRole("button", { name: "Cancel all" }));
    expect(details).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
