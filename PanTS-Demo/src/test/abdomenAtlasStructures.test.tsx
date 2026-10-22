import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import OrganCheckbox, { systemOrganSlots } from "../components/OrganCheckbox";
import {
  ATLAS_ONLY_KEYS,
  AtlasOrganSystems,
  CANCERVERSE_TUMOR_IDS,
  HIDDEN_BY_DEFAULT_IDS,
  ORGAN_CLASS_COUNT,
  OrganSystems,
  segmentation_categories,
  segmentation_category_colors,
} from "../helpers/constants";
import type { OrganSystemsType, SegmentationCategories, SubSystemsType } from "../types";

// AbdomenAtlas structures are labels 45-58, appended after the CancerVerse tumor types. Their ids are baked into the
// masks and meshes the backend writes (label_scheme.py), so they must never move.

const NEW_KEYS: SegmentationCategories[] = [
  "esophagus", "rectum", "celiac_aa", "celiac_trunk", "portal_vein_and_splenic_vein", "hepatic_vessel",
  "liver_segment_1", "liver_segment_2", "liver_segment_3", "liver_segment_4",
  "liver_segment_5", "liver_segment_6", "liver_segment_7", "liver_segment_8",
];

const flatten = (systems: OrganSystemsType): string[] =>
  Object.values(systems).flatMap((entries) =>
    entries.flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry as SubSystemsType).flat())),
  );

describe("AbdomenAtlas structure ids", () => {
  it("are the ids the backend writes, in order, after the CancerVerse tumors", () => {
    expect(segmentation_categories.slice(44)).toEqual(NEW_KEYS);
    expect(ATLAS_ONLY_KEYS).toEqual(NEW_KEYS);
    NEW_KEYS.forEach((key, i) => expect(segmentation_categories.indexOf(key) + 1).toBe(45 + i));
  });

  it("each have a color, and the eight liver segments and the liver all differ", () => {
    for (let id = 45; id <= 58; id++) expect(segmentation_category_colors[id], `label ${id}`).toBeTruthy();
    const rgb = (id: number) => segmentation_category_colors[id].slice(0, 3).join(",");
    const liver = segmentation_categories.indexOf("liver") + 1;
    const liverFamily = [liver, 50, 51, 52, 53, 54, 55, 56, 57, 58].map(rgb);
    expect(new Set(liverFamily).size).toBe(liverFamily.length);
  });

  it("start hidden exactly for the nine structures inside the liver", () => {
    expect([...HIDDEN_BY_DEFAULT_IDS].sort((a, b) => a - b)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58]);
  });

  it("do not count as PanTS organ classes or as CancerVerse tumor types", () => {
    expect(ORGAN_CLASS_COUNT).toBe(35);
    for (const key of NEW_KEYS) expect(CANCERVERSE_TUMOR_IDS.has(segmentation_categories.indexOf(key) + 1)).toBe(false);
  });
});

describe("AbdomenAtlas organ groups", () => {
  it("list every one of the 14 new structures exactly once, and the PanTS panel none of them", () => {
    const atlas = flatten(AtlasOrganSystems);
    for (const key of NEW_KEYS) expect(atlas.filter((k) => k === key), key).toHaveLength(1);
    const pants = flatten(OrganSystems);
    for (const key of NEW_KEYS) expect(pants).not.toContain(key);
  });

  it("keep every PanTS organ (the liver moves into its own group) and add no other", () => {
    const atlas = new Set(flatten(AtlasOrganSystems));
    for (const organ of flatten(OrganSystems)) expect(atlas.has(organ), organ).toBe(true);
    expect([...atlas].sort()).toEqual([...new Set([...flatten(OrganSystems), ...NEW_KEYS])].sort());
  });

  it("give the liver a group of its own with its lesion, vessels and eight segments", () => {
    const entry = AtlasOrganSystems["Digestive System"].find((e) => typeof e !== "string" && "Liver" in e) as SubSystemsType;
    expect(entry.Liver).toEqual([
      "liver", "liver_lesion", "hepatic_vessel",
      "liver_segment_1", "liver_segment_2", "liver_segment_3", "liver_segment_4",
      "liver_segment_5", "liver_segment_6", "liver_segment_7", "liver_segment_8",
    ]);
    // the whole liver and its lesion are not repeated outside the group
    const outside = AtlasOrganSystems["Digestive System"].filter((e) => typeof e === "string");
    expect(outside).not.toContain("liver");
    expect(outside).not.toContain("liver_lesion");
  });

  it("put each new structure in its system, with slot numbers that follow the label ids", () => {
    const digestive = systemOrganSlots(AtlasOrganSystems, "Digestive System");
    const vascular = systemOrganSlots(AtlasOrganSystems, "Vascular System");
    for (const id of [45, 46, 50, 51, 52, 53, 54, 55, 56, 57, 58]) expect(digestive, `digestive ${id}`).toContain(id);
    for (const id of [47, 48, 49]) expect(vascular, `vascular ${id}`).toContain(id);
    expect(vascular).not.toContain(45);
  });

  function Panel() {
    const [checkState, setCheckState] = useState<boolean[]>(Array(segmentation_categories.length + 1).fill(false));
    return (
      <OrganCheckbox
        checkState={checkState}
        setCheckState={setCheckState}
        labelColorMap={segmentation_category_colors}
        sessionId={undefined}
        showOrganDetails
        setShowOrganDetails={() => {}}
        systemMap={AtlasOrganSystems}
      />
    );
  }

  it("show a Liver group whose segments toggle from the panel", () => {
    render(<Panel />);
    fireEvent.click(screen.getByRole("button", { name: "Digestive System" }));
    fireEvent.click(screen.getByRole("button", { name: "Liver organs" }));
    const segment = screen.getByRole("checkbox", { name: "liver segment 4" });
    const group = screen.getByRole("checkbox", { name: "Liver" });
    expect(segment).toHaveAttribute("aria-checked", "false");
    fireEvent.click(segment);
    expect(segment).toHaveAttribute("aria-checked", "true");
    expect(group).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(group);                                   // mixed turns everything in the group on
    for (let i = 1; i <= 8; i++) {
      expect(screen.getByRole("checkbox", { name: `liver segment ${i}` })).toHaveAttribute("aria-checked", "true");
    }
    expect(within(document.body).getByRole("checkbox", { name: "hepatic vessel" })).toHaveAttribute("aria-checked", "true");
    // the group header is the whole liver's own toggle (a sub-group does not repeat it as a row), and it now reads fully on
    expect(group).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("checkbox", { name: "liver" })).toBeNull();
  });
});
