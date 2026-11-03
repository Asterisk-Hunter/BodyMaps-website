import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Volume = { load: () => Promise<void>; cancelLoading: () => void; metadata: object; voxels: Uint8Array };
const gpu = vi.hoisted(() => ({
  volumes: new Map<string, Volume>(),
  currentCtId: "",
  currentMaskId: "",
  metadata: vi.fn<(url: string) => Promise<string[]>>(),
  createVolume: vi.fn<(id: string) => Promise<Volume>>(),
  attachCt: vi.fn<(id: string) => Promise<void>>(),
  attachMask: vi.fn<(id: string) => Promise<void>>(),
  removeVolume: vi.fn<(id: string) => void>(),
  removeImage: vi.fn(),
}));

// Keep the real viewer resource ownership and upgrade code. Replace only the
// GPU/Cornerstone adapters and NIfTI boundary, whose promises we can stall.
vi.mock("@cornerstonejs/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cornerstonejs/core")>();
  return {
    ...actual,
    init: vi.fn(),
    getRenderingEngine: vi.fn(),
    RenderingEngine: class {
      setViewports() {}
      renderViewports() {}
      destroy() {}
      getViewport() {
        return {
          getCamera: () => ({ parallelScale: 42 }), setCamera: vi.fn(),
          getActors: () => [],
          addVolumes: async (volumes: { volumeId: string }[]) => {
            await gpu.attachMask(volumes[0].volumeId);
          },
        };
      }
    },
    cache: {
      getVolume: (id: string) => gpu.volumes.get(id),
      removeVolumeLoadObject: (id: string) => { gpu.removeVolume(id); gpu.volumes.delete(id); },
      removeImageLoadObject: gpu.removeImage,
    },
    imageLoader: { registerImageLoader: vi.fn(), cancelLoadImage: vi.fn() },
    volumeLoader: { createAndCacheVolume: (id: string) => gpu.createVolume(id) },
    setVolumesForViewports: async (_engine: unknown, volumes: { volumeId: string }[]) => {
      await gpu.attachCt(volumes[0].volumeId);
      gpu.currentCtId = volumes[0].volumeId;
    },
  };
});

vi.mock("@cornerstonejs/nifti-volume-loader", () => ({ init: vi.fn(), cornerstoneNiftiImageLoader: vi.fn() }));
vi.mock("./loadNiftiImageIds", () => ({
  createNiftiImageIdsAndCacheMetadata: ({ url }: { url: string }) => gpu.metadata(url),
}));

vi.mock("@cornerstonejs/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cornerstonejs/tools")>();
  const group = {
    addTool: vi.fn(), addToolInstance: vi.fn(), addViewport: vi.fn(),
    setToolActive: vi.fn(), setToolPassive: vi.fn(), setToolDisabled: vi.fn(),
  };
  return {
    ...actual,
    init: vi.fn(), addTool: vi.fn(),
    ToolGroupManager: { createToolGroup: () => group, destroyToolGroup: vi.fn() },
    annotation: {
      config: { style: {
        getDefaultToolStyles: () => ({}), setDefaultToolStyles: vi.fn(),
        getToolGroupToolStyles: () => ({}), setToolGroupToolStyles: vi.fn(),
      } },
      state: { getAllAnnotations: () => [] },
    },
    segmentation: {
      segmentationStyle: { setStyle: vi.fn() },
      activeSegmentation: { setActiveSegmentation: vi.fn() },
      removeAllSegmentations: vi.fn(), removeSegmentation: vi.fn(),
      removeSegmentationRepresentations: vi.fn(), addSegmentationRepresentations: vi.fn(),
      addSegmentations: (items: { segmentationId: string }[]) => { gpu.currentMaskId = items[0].segmentationId; },
    },
  };
});

import { disposeVisualization, renderVisualization, upgradeCtVolume, upgradeSegmentationVolume } from "../CornerstoneNifti2";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function volume(): Volume {
  return { metadata: {}, load: vi.fn(async () => {}), cancelLoading: vi.fn(), voxels: new Uint8Array([0, 80, 80]) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  gpu.volumes.clear();
  gpu.metadata.mockReset().mockImplementation(async (url) => [`nifti:${url}?frame=0`]);
  gpu.createVolume.mockReset().mockImplementation(async (id) => {
    const result = volume();
    gpu.volumes.set(id, result);
    return result;
  });
  gpu.attachCt.mockReset().mockResolvedValue(undefined);
  gpu.attachMask.mockReset().mockResolvedValue(undefined);
  await renderVisualization(
    document.createElement("div"), document.createElement("div"), document.createElement("div"),
    [[0, 0, 0, 0]], "/ct-low", "/mask-low", vi.fn(),
  );
  vi.clearAllMocks();
});

afterEach(() => disposeVisualization());

describe("real CT upgrade cancellation", () => {
  it.each(["metadata", "creation", "load", "attachment", "labelmap rebuild"] as const)("keeps the old CT and releases the replacement when cancelled during %s", async (stage) => {
    const previousId = gpu.currentCtId;
    const previous = gpu.volumes.get(previousId);
    const paused = deferred<void>();
    const replacement = volume();
    if (stage === "metadata") gpu.metadata.mockImplementationOnce(async () => { await paused.promise; return ["nifti:/ct-full?frame=0"]; });
    if (stage === "creation") gpu.createVolume.mockImplementationOnce(async (id) => {
      await paused.promise;
      gpu.volumes.set(id, replacement);
      return replacement;
    });
    if (stage === "load") {
      replacement.load = vi.fn(() => paused.promise);
      gpu.createVolume.mockImplementationOnce(async (id) => { gpu.volumes.set(id, replacement); return replacement; });
    }
    if (stage === "attachment") gpu.attachCt.mockImplementationOnce(() => paused.promise);
    if (stage === "labelmap rebuild") gpu.attachMask.mockImplementationOnce(() => paused.promise);
    const controller = new AbortController();
    const upgrade = upgradeCtVolume("/ct-full", controller.signal);
    const entered = stage === "metadata" ? gpu.metadata : stage === "creation" ? gpu.createVolume : stage === "load" ? replacement.load : stage === "attachment" ? gpu.attachCt : gpu.attachMask;
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    controller.abort();
    paused.resolve();
    await expect(upgrade).resolves.toBeNull();
    expect(gpu.currentCtId).toBe(previousId);
    expect(gpu.volumes.get(previousId)).toBe(previous);
    expect([...gpu.volumes.keys()].filter((id) => id.includes("-hd"))).toEqual([]);
    expect(gpu.removeVolume).not.toHaveBeenCalledWith(previousId);
    if (stage === "creation") expect(replacement.load).not.toHaveBeenCalled();
    if (stage === "attachment" || stage === "labelmap rebuild") expect(gpu.attachCt).toHaveBeenLastCalledWith(previousId);
    // The same viewer remains usable for a fresh attempt after rollback.
    await expect(upgradeCtVolume("/ct-retry")).resolves.toEqual(expect.any(String));
    expect(gpu.currentCtId).not.toBe(previousId);
  });
});

describe("real mask upgrade cancellation", () => {
  it.each(["metadata", "creation", "load", "attachment"] as const)("retains the edited mask when cancelled during %s", async (stage) => {
    const previousId = gpu.currentMaskId;
    const previous = gpu.volumes.get(previousId);
    const paused = deferred<void>();
    const replacement = volume();
    if (stage === "metadata") gpu.metadata.mockImplementationOnce(async () => { await paused.promise; return ["nifti:/mask-full?frame=0"]; });
    if (stage === "creation") gpu.createVolume.mockImplementationOnce(async (id) => {
      await paused.promise;
      gpu.volumes.set(id, replacement);
      return replacement;
    });
    if (stage === "load") {
      replacement.load = vi.fn(() => paused.promise);
      gpu.createVolume.mockImplementationOnce(async (id) => { gpu.volumes.set(id, replacement); return replacement; });
    }
    if (stage === "attachment") gpu.attachMask.mockImplementationOnce(() => paused.promise);
    const controller = new AbortController();
    const upgrade = upgradeSegmentationVolume("/mask-full", controller.signal);
    const entered = stage === "metadata" ? gpu.metadata : stage === "creation" ? gpu.createVolume : stage === "load" ? replacement.load : gpu.attachMask;
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    controller.abort();
    paused.resolve();
    await expect(upgrade).resolves.toBe(false);
    expect(gpu.volumes.get(previousId)).toBe(previous);
    expect(previous?.voxels).toEqual(new Uint8Array([0, 80, 80]));
    expect([...gpu.volumes.keys()].filter((id) => id.includes("-hd"))).toEqual([]);
    expect(gpu.removeVolume).not.toHaveBeenCalledWith(previousId);
    if (stage === "creation") expect(replacement.load).not.toHaveBeenCalled();
    if (stage === "attachment") expect(gpu.attachMask).toHaveBeenLastCalledWith(previousId);
    await expect(upgradeSegmentationVolume("/mask-retry")).resolves.toBe(true);
    expect(gpu.currentMaskId).not.toBe(previousId);
  });
});
