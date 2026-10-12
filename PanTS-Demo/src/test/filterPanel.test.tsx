import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import FilterPanel from "../routes/Homepage/components/FilterPanel";
import { EMPTY_FILTERS, type SearchFilters } from "../helpers/search";
import type { FacetData } from "../routes/Homepage/types";

// PanTS and CancerVerse are one collection to the user: there is no Dataset picker, and
// the tumor organ is a filter like any other facet.
const facetData: FacetData = {
  counts: {
    tumor: [
      { value: 1, count: 9000 },
      { value: 0, count: 20000 },
    ],
    tumor_type: [
      { value: "liver", label: "Liver", count: 6540 },
      { value: "pancreas", label: "Pancreas", count: 2100 },
      { value: "adrenal gland", label: "Adrenal gland", count: 683 },
    ],
    ct_phase: [{ value: "Venous", count: 14000 }],
  },
  unknown: {},
  total: 34323,
};

const renderPanel = (overrides: Partial<React.ComponentProps<typeof FilterPanel>> = {}) => {
  const toggleMulti = vi.fn();
  const setFilters = vi.fn();
  render(
    <FilterPanel
      filters={EMPTY_FILTERS}
      setFilters={setFilters}
      facetData={facetData}
      toggleMulti={toggleMulti}
      {...overrides}
    />,
  );
  return { toggleMulti, setFilters };
};

describe("FilterPanel", () => {
  it("has no dataset picker", () => {
    renderPanel();
    expect(screen.queryByText("Dataset")).toBeNull();
    expect(screen.queryByRole("button", { name: /CancerVerse/ })).toBeNull();
  });

  it("lists each tumor organ with its count and selects it by its filter value", () => {
    const { toggleMulti } = renderPanel();
    const group = screen.getByText("Tumor Type").parentElement as HTMLElement;
    expect(within(group).getByRole("button", { name: /^Liver/ })).toBeTruthy();
    expect(within(group).getByText("6,540")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: /Adrenal gland/ }));
    expect(toggleMulti).toHaveBeenCalledWith("tumorType", "adrenal gland");
  });

  it("marks the selected tumor types as active", () => {
    renderPanel({ filters: { ...EMPTY_FILTERS, tumorType: ["pancreas"] } });
    const group = screen.getByText("Tumor Type").parentElement as HTMLElement;
    const active = within(group).getByRole("button", { name: /^Pancreas/ });
    const inactive = within(group).getByRole("button", { name: /^Liver/ });
    expect(active.className).not.toBe(inactive.className);
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(inactive).toHaveAttribute("aria-pressed", "false");
  });

  it("announces selected filters and restores Any when a selection is cleared", async () => {
    function FilterHarness() {
      const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
      return <FilterPanel filters={filters} setFilters={setFilters} facetData={facetData}
        toggleMulti={(key, value) => setFilters((previous) => ({
          ...previous,
          [key]: previous[key].includes(value)
            ? previous[key].filter((selected) => selected !== value)
            : [...previous[key], value],
        }))} />;
    }
    const user = userEvent.setup();
    render(<FilterHarness />);
    const group = (label: string) => within(screen.getByText(label, { selector: "span" }).parentElement as HTMLElement);
    const sex = group("Sex"), age = group("Age"), tumorType = group("Tumor Type"), tumor = group("Tumor");

    expect(sex.getByRole("button", { name: "Any", pressed: true })).toBeInTheDocument();
    await user.click(sex.getByRole("button", { name: "Female" }));
    expect(sex.getByRole("button", { name: "Female", pressed: true })).toBeInTheDocument();
    expect(sex.getByRole("button", { name: "Any", pressed: false })).toBeInTheDocument();

    await user.click(age.getByRole("button", { name: "40-49" }));
    expect(age.getByRole("button", { name: "40-49", pressed: true })).toBeInTheDocument();
    await user.click(tumorType.getByRole("button", { name: /^Liver/ }));
    expect(tumorType.getByRole("button", { name: /^Liver/, pressed: true })).toBeInTheDocument();
    await user.click(tumor.getByRole("button", { name: /^No tumor/ }));
    expect(tumor.getByRole("button", { name: /^No tumor/, pressed: true })).toBeInTheDocument();
    expect(tumor.getByRole("button", { name: "Any", pressed: false })).toBeInTheDocument();

    await user.click(sex.getByRole("button", { name: "Female" }));
    expect(sex.getByRole("button", { name: "Any", pressed: true })).toBeInTheDocument();
    await user.click(tumorType.getByRole("button", { name: "Any" }));
    expect(tumorType.getByRole("button", { name: "Any", pressed: true })).toBeInTheDocument();
    expect(tumorType.getByRole("button", { name: /^Liver/, pressed: false })).toBeInTheDocument();
  });

  it("shows a placeholder until the facet options arrive", () => {
    renderPanel({ facetData: null });
    const group = screen.getByText("Tumor Type").parentElement as HTMLElement;
    expect(within(group).getByText("Loading…")).toBeTruthy();
  });
});
