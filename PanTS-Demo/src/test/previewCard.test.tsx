import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Preview from "../components/Preview";
import type { PreviewType } from "../types";

vi.mock("../helpers/prefetchViewer", () => ({ prefetchViewer: vi.fn() }));

// The library card tells the user what kind of tumor a case has, whichever dataset it is from.
const renderCard = (id: number | string, meta: PreviewType) =>
  render(
    <MemoryRouter>
      <Preview id={id} previewMetadata={meta} />
    </MemoryRouter>,
  );

describe("Preview card tumor badge", () => {
  it("names the organ of a PanTS tumor", () => {
    renderCard(12, { sex: "M", age: 60, tumor: 1, tumorLabel: "Pancreas" });
    expect(screen.getByText("PanTS_00000012")).toBeTruthy();
    expect(screen.getByText("Pancreas tumor")).toBeTruthy();
  });

  it("names the organs of a CancerVerse tumor and keeps a long list short", () => {
    renderCard("CV_00000012", { sex: "F", age: 55, tumor: 1, tumorLabel: "Liver, Kidney, Colon, Spleen" });
    expect(screen.getByText("CV_00000012")).toBeTruthy();
    expect(screen.getByText("Liver, Kidney +2 tumor")).toBeTruthy();
  });

  it("says No Tumor, Unknown, or a plain Tumor when the organ is not known", () => {
    const none = renderCard(1, { sex: "M", age: 40, tumor: 0 });
    expect(screen.getByText("No Tumor")).toBeTruthy();
    none.unmount();
    const unknown = renderCard("CV_00000003", { sex: "M", age: 40, tumor: null });
    expect(screen.getByText("Unknown")).toBeTruthy();
    unknown.unmount();
    renderCard(2, { sex: "M", age: 40, tumor: 1 });
    expect(screen.getByText("Tumor")).toBeTruthy();
  });

  it("lets the sex / age / tumor row wrap instead of overflowing a narrow card", () => {
    const { container } = renderCard("CV_00000012", { sex: "F", age: 55, tumor: 1, tumorLabel: "Adrenal gland, Gallbladder" });
    const row = screen.getByText("Adrenal gland, Gallbladder tumor").parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(container.contains(row)).toBe(true);
  });

  it("keeps the full CancerVerse ID in a real viewer link", () => {
    renderCard("CV_00000012", { sex: "F", age: 55, tumor: 1 });
    expect(screen.getByRole("link", { name: "Open case CV_00000012" }))
      .toHaveAttribute("href", "/case/CV_00000012");
  });

  it("makes save and compare accessible by keyboard without opening the case", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const compare = vi.fn();
    render(<MemoryRouter><Preview id={35} previewMetadata={{ sex: "F", age: 55, tumor: 0 }} onToggleSave={save} onToggleCompare={compare} /></MemoryRouter>);
    const link = screen.getByRole("link", { name: "Open case PanTS_00000035" });
    const bookmark = screen.getByRole("button", { name: "Save case 35" });
    const compareButton = screen.getByRole("button", { name: "Add case 35 to comparison" });
    await user.tab();
    expect(link).toHaveFocus();
    await user.tab();
    expect(bookmark).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(save).toHaveBeenCalledOnce();
    expect(link).toBeInTheDocument();
    await user.tab();
    expect(compareButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(compare).toHaveBeenCalledOnce();
    expect(link).toBeInTheDocument();
  });
});
