import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VolumeViewport, type RenderingEngine, type Types } from "@cornerstonejs/core";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import { render } from "@cornerstonejs/tools/tools/displayTools/Labelmap/labelmapDisplay";
import { segmentationStyle } from "@cornerstonejs/tools/segmentation/SegmentationStyle";
import { addVolumeLabelmap } from "./addVolumeLabelmap";

const state = vi.hoisted(() => ({
  viewport: null as unknown,
  engine: null as unknown,
  register: vi.fn(),
}));
vi.mock("@cornerstonejs/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@cornerstonejs/core")>(),
  getEnabledElement: () => ({ viewport: state.viewport, renderingEngine: state.engine }),
  getEnabledElementByViewportId: () => ({ viewport: state.viewport, renderingEngine: state.engine }),
}));
vi.mock("@cornerstonejs/tools", () => ({
  Enums: { SegmentationRepresentations: { Labelmap: "Labelmap" } },
  segmentation: { addSegmentationRepresentations: state.register },
}));
vi.mock("@cornerstonejs/tools/segmentation/getSegmentation", () => ({
  getSegmentation: () => ({ representationData: { Labelmap: { volumeId: "mask", imageIds: ["mask:0"] } } }),
}));
vi.mock("@cornerstonejs/tools/segmentation/activeSegmentation", () => ({
  getActiveSegmentation: () => ({ segmentationId: "mask" }),
}));
vi.mock("@cornerstonejs/tools/segmentation/getColorLUT", () => ({
  getColorLUT: () => [[0, 0, 0, 0], [255, 0, 0, 255]],
}));
vi.mock("@cornerstonejs/tools/segmentation/helpers/internalGetHiddenSegmentIndices", () => ({
  internalGetHiddenSegmentIndices: () => new Set(),
}));

describe("volume labelmap loading", () => {
  const colorLUT: Types.ColorLUT = [[0, 0, 0, 0], [255, 0, 0, 255]];
  let actors: Types.ActorEntry[];
  let releaseLoad: () => void;
  let pendingRenders: Promise<unknown>[];
  let viewport: VolumeViewport;
  let engine: RenderingEngine;
  let ofun: ReturnType<typeof vtkPiecewiseFunction.newInstance>;

  beforeEach(async () => {
    state.register.mockReset();
    const { cache } = await import("@cornerstonejs/core");
    vi.spyOn(cache, "getVolume").mockReturnValue({} as never);
    actors = [];
    pendingRenders = [];
    const loading = new Promise<void>((resolve) => { releaseLoad = resolve; });
    // Exercise the real Cornerstone renderer and actor lookup. Only the GPU actor
    // construction is replaced, with a deferred NIfTI load spanning several frames.
    viewport = Object.create(VolumeViewport.prototype) as VolumeViewport;
    Object.assign(viewport, {
      id: "loading-test", element: document.createElement("div"),
      getActors: () => actors,
      addVolumes: vi.fn(async (inputs: Types.IVolumeInput[]) => {
        await loading;
        for (const input of inputs) {
          const uid = input.actorUID ?? `actor-${actors.length}`;
          if (actors.some((entry) => entry.uid === uid)) continue;
          actors.push({
            uid, representationUID: input.representationUID,
            actor: {
              getProperty: () => ({
                setRGBTransferFunction: vi.fn(), setScalarOpacity: vi.fn(),
                setInterpolationTypeToNearest: vi.fn(), setLabelOutlineThickness: vi.fn(),
              }),
              setVisibility: vi.fn(), modified: vi.fn(),
            },
          } as unknown as Types.ActorEntry);
        }
      }),
    });
    engine = { getViewport: () => viewport } as unknown as RenderingEngine;
    state.viewport = viewport;
    state.engine = engine;
    ofun = vtkPiecewiseFunction.newInstance();
    segmentationStyle.setStyle({ type: "Labelmap" as never, segmentationId: "mask" }, {
      fillAlpha: 0.5, renderFill: true, renderOutline: false,
    });
    state.register.mockImplementation(() => {
      // Representation-added, active-segmentation and loading events can each
      // schedule a render before asynchronous actor creation has completed.
      for (let frame = 0; frame < 4; frame++) {
        pendingRenders.push(render(viewport, {
          segmentationId: "mask", colorLUTIndex: 0,
          config: { cfun: vtkColorTransferFunction.newInstance(), ofun },
        } as Parameters<typeof render>[1]));
      }
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("adds a single colored layer even when renders overlap a slow NIfTI load", async () => {
    const ready = addVolumeLabelmap(engine, viewport.id, "mask", colorLUT);
    releaseLoad();
    await ready;
    await Promise.all(pendingRenders);
    expect(actors).toHaveLength(1);
    // Repeated source-over layers turn 50% into 94% with four copies. One
    // representation must retain the selected opacity instead of saturating.
    expect(1 - (1 - ofun.getValue(1)) ** actors.length).toBeCloseTo(0.5);
  });

  it("keeps one layer on repeat registration and after an HD actor rebuild", async () => {
    releaseLoad();
    await addVolumeLabelmap(engine, viewport.id, "mask", colorLUT);
    await Promise.all(pendingRenders);
    await addVolumeLabelmap(engine, viewport.id, "mask", colorLUT);
    await Promise.all(pendingRenders);
    expect(actors).toHaveLength(1);
    expect(viewport.addVolumes).toHaveBeenCalledTimes(1);

    actors = []; // setVolumes replaces actors when switching to HD CT.
    await addVolumeLabelmap(engine, viewport.id, "mask", colorLUT);
    await Promise.all(pendingRenders);
    expect(actors).toHaveLength(1);
    expect(viewport.addVolumes).toHaveBeenCalledTimes(2);
  });

  it("does not publish a representation before its actor is ready or after load failure", async () => {
    const ready = addVolumeLabelmap(engine, viewport.id, "mask", colorLUT);
    expect(state.register).not.toHaveBeenCalled();
    releaseLoad();
    await ready;
    await Promise.all(pendingRenders);
    expect(state.register).toHaveBeenCalledTimes(1);

    actors = [];
    state.register.mockClear();
    vi.mocked(viewport.addVolumes).mockRejectedValueOnce(new Error("NIfTI load failed"));
    await expect(addVolumeLabelmap(engine, viewport.id, "mask", colorLUT)).rejects.toThrow("NIfTI load failed");
    expect(state.register).not.toHaveBeenCalled();
  });
});
