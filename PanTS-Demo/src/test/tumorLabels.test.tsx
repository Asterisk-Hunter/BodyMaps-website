import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import OrganCheckbox from "../components/OrganCheckbox";
import {
  CANCERVERSE_TUMOR_IDS,
  CANCERVERSE_TUMOR_KEYS,
  ORGAN_CLASS_COUNT,
  segmentation_categories,
  segmentation_category_colors,
} from "../helpers/constants";
import type { OrganSystemsAllType } from "../types";

// CancerVerse tumor types are labels 36-44, appended to the list the viewer, the meshes and the
// backend share. The ids are baked into the mask files, so they must never move.

describe("tumor label ids", () => {
  it("are the ids the backend writes into the masks", () => {
    const id = (key: (typeof segmentation_categories)[number]) => segmentation_categories.indexOf(key) + 1;
    expect(Object.fromEntries(CANCERVERSE_TUMOR_KEYS.map((key) => [key, id(key)]))).toEqual({
      pancreatic_lesion: 22,
      liver_lesion: 33,
      kidney_lesion: 34,
      colon_lesion: 35,
      stomach_lesion: 36,
      adrenal_gland_lesion: 37,
      bladder_lesion: 38,
      prostate_lesion: 39,
      esophagus_lesion: 40,
      spleen_lesion: 41,
      uterus_lesion: 42,
      duodenum_lesion: 43,
      gallbladder_lesion: 44,
    });
    expect([...CANCERVERSE_TUMOR_IDS].sort((a, b) => a - b)).toEqual([22, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
  });

  it("leave every existing label where it was", () => {
    expect(segmentation_categories.slice(0, 35)).toEqual([
      "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder", "celiac_artery", "colon",
      "common_bile_duct", "duodenum", "femur_left", "femur_right", "gall_bladder", "kidney_left",
      "kidney_right", "liver", "lung_left", "lung_right", "pancreas", "pancreas_body", "pancreas_head",
      "pancreas_tail", "pancreatic_duct", "pancreatic_lesion", "postcava", "prostate", "spleen",
      "stomach", "superior_mesenteric_artery", "veins", "intestine", "renal_vein_left",
      "renal_vein_right", "cbd_stent", "liver_lesion", "kidney_lesion", "colon_lesion",
    ]);
    expect(segmentation_categories.length).toBe(44);
  });

  it("each have a color, and no two tumor types share one", () => {
    for (let id = 1; id <= segmentation_categories.length; id++) {
      expect(segmentation_category_colors[id], `label ${id}`).toBeTruthy();
    }
    const tumorColors = [...CANCERVERSE_TUMOR_IDS].map((id) => segmentation_category_colors[id].slice(0, 3).join(","));
    expect(new Set(tumorColors).size).toBe(tumorColors.length);
  });

  it("do not change the number of organ classes the landing page quotes", () => {
    expect(ORGAN_CLASS_COUNT).toBe(35);
  });
});

describe("organ panel", () => {
  const colors = segmentation_category_colors;

  function Panel(props: { systemMap?: OrganSystemsAllType; tumors?: boolean; emptyNote?: string; probe?: (s: boolean[]) => void }) {
    const [checkState, setCheckState] = useState<boolean[]>(
      Array.from({ length: segmentation_categories.length + 1 }, () => true),
    );
    props.probe?.(checkState);
    return (
      <OrganCheckbox
        setCheckState={setCheckState}
        checkState={checkState}
        labelColorMap={colors}
        sessionId={undefined}
        setShowOrganDetails={() => {}}
        showOrganDetails
        {...(props.tumors
          ? { systemList: ["Tumors" as const], systemMap: props.systemMap, title: "Tumors", emptyNote: props.emptyNote }
          : {})}
      />
    );
  }

  it("is the PanTS organ list, unchanged, for every case but CancerVerse", () => {
    render(<Panel />);
    expect(screen.getByText("Organs")).toBeTruthy();
    expect(screen.getByText("Digestive System")).toBeTruthy();
    expect(screen.getByText("Vascular System")).toBeTruthy();
    expect(screen.queryByText("Tumors")).toBeNull();
    expect(screen.queryByText("stomach lesion")).toBeNull();      // the new tumor types never clutter a PanTS case
  });

  it("shows a CancerVerse case one Tumors group of the types its scan has", () => {
    render(<Panel tumors systemMap={{ Tumors: ["liver_lesion", "stomach_lesion"] }} />);
    expect(screen.getAllByText("Tumors").length).toBeGreaterThan(0);
    expect(screen.queryByText("Organs")).toBeNull();
    expect(screen.getByText("liver lesion")).toBeTruthy();
    expect(screen.getByText("stomach lesion")).toBeTruthy();
    expect(screen.queryByText("kidney lesion")).toBeNull();
    expect(screen.queryByText("Digestive System")).toBeNull();
  });

  it("toggles a tumor by its label id", () => {
    let seen: boolean[] = [];
    render(<Panel tumors systemMap={{ Tumors: ["liver_lesion", "stomach_lesion"] }} probe={(s) => (seen = s)} />);
    expect(seen[33]).toBe(true);
    fireEvent.click(screen.getByText("liver lesion"));
    expect(seen[33]).toBe(false);          // liver_lesion is label 33
    expect(seen[36]).toBe(true);           // the other tumor is untouched
    fireEvent.click(screen.getByText("stomach lesion"));
    expect(seen[36]).toBe(false);          // stomach_lesion is label 36
  });

  it("says so when the scan has no tumor mask", () => {
    render(<Panel tumors systemMap={{ Tumors: [] }} emptyNote="No tumor mask for this scan." />);
    expect(screen.getByText("No tumor mask for this scan.")).toBeTruthy();
    expect(screen.queryByText("liver lesion")).toBeNull();
  });
});
