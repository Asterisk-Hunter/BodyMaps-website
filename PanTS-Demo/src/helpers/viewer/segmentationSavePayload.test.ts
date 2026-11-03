import { describe, expect, it } from "vitest";
import { encodeSegmentationSavePayload } from "./segmentationSavePayload";

async function gunzip(bytes: ArrayBuffer): Promise<number[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("gzip"));
  return Array.from(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe("segmentation save payload", () => {
  it("encodes numeric labels from wider typed arrays as one byte per voxel", async () => {
    const backing = new Int16Array([99, 0, 1, 255, 99]);
    const source = backing.subarray(1, 4);

    const compressed = await encodeSegmentationSavePayload(source, [3, 1, 1]);

    expect(await gunzip(compressed)).toEqual([0, 1, 255]);
  });

  it("copies labels before asynchronous compression starts", async () => {
    const source = new Float32Array([4, 5]);

    const pending = encodeSegmentationSavePayload(source, [2, 1, 1]);
    source[0] = 200;

    expect(await gunzip(await pending)).toEqual([4, 5]);
  });

  it.each([
    [new Int16Array([-1]), [1, 1, 1]],
    [new Float32Array([1.5]), [1, 1, 1]],
    [new Uint16Array([256]), [1, 1, 1]],
    [new Uint8Array([1]), [2, 1, 1]],
  ])("rejects invalid labels or a voxel count mismatch", async (data, dimensions) => {
    await expect(encodeSegmentationSavePayload(data, dimensions)).rejects.toThrow();
  });
});
