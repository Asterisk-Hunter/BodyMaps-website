import {
  clearMeasurements as csClearMeasurements,
  LENGTH_TOOL,
  PROBE_TOOL,
  ROI_TOOL,
  moveCornerstoneCrosshairToMm,
  getOrganCentroids,
  setFillOpacity,
  MAX_ZOOM,
  MIN_ZOOM,
  setZoom as csSetZoom,
  zoomToFit as csZoomToFit,
} from "../../helpers/CornerstoneNifti2";
import type { MeasurementToolName } from "../../helpers/CornerstoneNifti2";
import { segmentation_categories } from "../../helpers/constants";
import { CT_WINDOWS } from "../../helpers/ctWindows";
import type { CheckBoxData } from "../../types";
import type { ViewerActions } from "./types";

function normalizeName(value: string) {
  return value.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function organKeyToId(key: string, checkBoxData: CheckBoxData[]): number | null {
  const normalizedKey = normalizeName(key);
  const found = checkBoxData.find((item) => normalizeName(item.label) === normalizedKey);
  if (found) return found.id;
  const index = segmentation_categories.findIndex((category) => normalizeName(category) === normalizedKey);
  if (index === -1) return null;
  return index + 1;
}

export function buildViewerActions(opts: {
  checkBoxData: CheckBoxData[];
  setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
  setOpacityValue: React.Dispatch<React.SetStateAction<number>>;
  handleWindowChange: (width: number | null, center: number | null) => void;
  setViewModeFn: (view: "mpr" | "axial" | "sagittal" | "coronal" | "3d") => void;
  setActiveMeasureToolFn: React.Dispatch<React.SetStateAction<MeasurementToolName | null>>;
  /** The viewer's zoom state, which the toolbar's Zoom slider and readout
   *  show and which drives the panes. Zoom commands go through it so they
   *  stay in step with the slider. */
  setZoomLevel?: (value: number) => void;
}): ViewerActions {
  const {
    checkBoxData,
    setCheckState,
    setOpacityValue,
    handleWindowChange,
    setViewModeFn,
    setActiveMeasureToolFn,
    setZoomLevel,
  } = opts;

  const windowPresets: Record<string, { width: number; center: number }> = {
    soft_tissue: CT_WINDOWS.softTissue,
    bone: CT_WINDOWS.bone,
    lung: CT_WINDOWS.lung,
    liver: CT_WINDOWS.liver,
  };

  const toolMap: Record<string, MeasurementToolName> = {
    distance: LENGTH_TOOL,
    probe: PROBE_TOOL,
    roi: ROI_TOOL,
  };

  return {
    isolateOrgans(organKeys) {
      setCheckState((previous) => {
        const next = new Array(previous.length).fill(false);
        next[0] = true;
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = true;
        }
        return next;
      });
    },

    showOrgans(organKeys) {
      setCheckState((previous) => {
        const next = [...previous];
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = true;
        }
        return next;
      });
    },

    hideOrgans(organKeys) {
      setCheckState((previous) => {
        const next = [...previous];
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = false;
        }
        return next;
      });
    },

    focusOrgan(organKey) {
      const id = organKeyToId(organKey, checkBoxData);
      if (id !== null) {
        setCheckState((previous) => {
          const next = [...previous];
          next[id] = true;
          return next;
        });
      }
      const centroids = getOrganCentroids();
      if (centroids && id !== null && centroids[id]) moveCornerstoneCrosshairToMm(centroids[id]);
    },

    setOpacity(value) {
      const clamped = Math.max(0, Math.min(100, value));
      setOpacityValue(clamped);
      setFillOpacity(clamped / 100);
    },

    setWindow(width, center) {
      handleWindowChange(width, center);
    },

    setWindowPreset(preset) {
      const selectedPreset = windowPresets[preset];
      if (selectedPreset) handleWindowChange(selectedPreset.width, selectedPreset.center);
    },

    // The same range as the toolbar's slider, so a request for 15x cannot push
    // the panes past what the readout can show.
    setZoom(value) {
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
      csSetZoom(clamped);
      setZoomLevel?.(clamped);
    },

    zoomToFit() {
      csZoomToFit();
      setZoomLevel?.(1);
    },

    setViewMode(view) {
      setViewModeFn(view);
    },

    activateMeasurementTool(tool) {
      setActiveMeasureToolFn(toolMap[tool] ?? null);
    },

    // No Keep / Clear question here on purpose: the person typed the request to the
    // assistant, so that typed request is the confirmation the buttons ask for.
    clearMeasurements() {
      csClearMeasurements();
    },
  };
}
