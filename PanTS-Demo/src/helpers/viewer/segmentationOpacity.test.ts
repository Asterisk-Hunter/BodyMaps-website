import { beforeEach, describe, expect, it, vi } from "vitest";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import { render } from "@cornerstonejs/tools/tools/displayTools/Labelmap/labelmapDisplay";
import { segmentationStyle } from "@cornerstonejs/tools/segmentation/SegmentationStyle";
import { setFillOpacity, setOutlineOpacity } from "../CornerstoneNifti2";

const { actor, hiddenSegments, activeSegmentation } = vi.hoisted(() => ({
  actor: {
    getProperty: vi.fn(),
    getMapper: vi.fn(() => ({ modified: vi.fn() })),
    modified: vi.fn(),
    setVisibility: vi.fn(),
  },
  hiddenSegments: new Set<number>(),
  activeSegmentation: { segmentationId: "opacity-test" },
}));

// Exercise Cornerstone's real labelmap renderer and opacity transfer function, with
// only the viewport/state lookups replaced so the test needs no browser WebGL context.
vi.mock("@cornerstonejs/tools/segmentation/getSegmentation", () => ({
  getSegmentation: () => ({ representationData: { Labelmap: { imageIds: ["mask"] } } }),
}));
vi.mock("@cornerstonejs/tools/segmentation/activeSegmentation", () => ({
  getActiveSegmentation: () => activeSegmentation,
}));
vi.mock("@cornerstonejs/tools/segmentation/getColorLUT", () => ({
  getColorLUT: () => [[0, 0, 0, 0], [255, 0, 0, 255], [0, 255, 0, 128]],
}));
vi.mock("@cornerstonejs/tools/segmentation/getCurrentLabelmapImageIdForViewport", () => ({
  getCurrentLabelmapImageIdsForViewport: () => ["mask"],
}));
vi.mock("@cornerstonejs/tools/segmentation/getActiveSegmentIndex", () => ({
  getActiveSegmentIndex: () => 1,
}));
vi.mock("@cornerstonejs/tools/segmentation/helpers/internalGetHiddenSegmentIndices", () => ({
  internalGetHiddenSegmentIndices: () => hiddenSegments,
}));
vi.mock("@cornerstonejs/tools/segmentation/helpers/getSegmentationActor", () => ({
  getLabelmapActorEntries: () => [{ actor }],
}));

describe("segmentation opacity in the CT renderer", () => {
  const viewport = { id: "opacity-test-viewport" } as Parameters<typeof render>[0];
  let ofun: ReturnType<typeof vtkPiecewiseFunction.newInstance>;
  let property: {
    setRGBTransferFunction: ReturnType<typeof vi.fn>;
    setScalarOpacity: ReturnType<typeof vi.fn>;
    setInterpolationTypeToNearest: ReturnType<typeof vi.fn>;
    setUseLabelOutline: ReturnType<typeof vi.fn>;
    setLabelOutlineOpacity: ReturnType<typeof vi.fn>;
    setLabelOutlineThickness: ReturnType<typeof vi.fn>;
    modified: ReturnType<typeof vi.fn>;
  };

  const draw = async () => render(viewport, {
    segmentationId: "opacity-test",
    colorLUTIndex: 0,
    config: { cfun: { addRGBPoint: vi.fn(), getMTime: () => 0 }, ofun },
  } as unknown as Parameters<typeof render>[1]);

  beforeEach(() => {
    hiddenSegments.clear();
    activeSegmentation.segmentationId = "opacity-test";
    ofun = vtkPiecewiseFunction.newInstance();
    property = {
      setRGBTransferFunction: vi.fn(), setScalarOpacity: vi.fn(),
      setInterpolationTypeToNearest: vi.fn(), setUseLabelOutline: vi.fn(),
      setLabelOutlineOpacity: vi.fn(), setLabelOutlineThickness: vi.fn(),
      modified: vi.fn(),
    };
    actor.getProperty.mockReturnValue(property);
    setOutlineOpacity(0);
    setFillOpacity(0.6);
  });

  it("removes all color at 0% and restores the selected opacity afterward", async () => {
    await draw();
    expect(ofun.getValue(1)).toBeCloseTo(0.6);

    setFillOpacity(0);
    await draw();
    expect(ofun.getValue(0)).toBe(0);
    expect(ofun.getValue(1)).toBe(0);
    expect(ofun.getValue(2)).toBe(0);
    expect(property.setLabelOutlineThickness).toHaveBeenLastCalledWith([0, 0]);

    hiddenSegments.add(2);
    setFillOpacity(0.75);
    await draw();
    expect(ofun.getValue(1)).toBeCloseTo(0.75);
    expect(ofun.getValue(2)).toBe(0);
  });

  it("keeps borders independently adjustable while the fill is fully transparent", async () => {
    setFillOpacity(0);
    setOutlineOpacity(0.8);
    await draw();
    expect(ofun.getValue(1)).toBe(0);
    expect(property.setLabelOutlineOpacity).toHaveBeenLastCalledWith(0.8);
  });

  it("also renders inactive labels with exactly zero fill", async () => {
    activeSegmentation.segmentationId = "another-segmentation";
    segmentationStyle.setRenderInactiveSegmentations(viewport.id, true);
    setFillOpacity(0);
    await draw();
    expect(ofun.getValue(1)).toBe(0);
    expect(ofun.getValue(2)).toBe(0);
  });
});
