/** Convert the live scalar array to a validated, one-byte-per-voxel gzip payload. */
export async function encodeSegmentationSavePayload(
  source: ArrayLike<number>,
  dimensions: readonly number[],
): Promise<ArrayBuffer> {
  if (dimensions.length !== 3 || dimensions.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)) {
    throw new Error("Segmentation has invalid dimensions.");
  }

  const voxelCount = dimensions[0] * dimensions[1] * dimensions[2];
  if (!Number.isSafeInteger(voxelCount) || source.length !== voxelCount) {
    throw new Error("Segmentation data length does not match its dimensions.");
  }

  // Copy numeric labels, not the underlying typed-array bytes. This also makes
  // the payload stable if Cornerstone changes the live volume during compression.
  const snapshot = new Uint8Array(voxelCount);
  for (let index = 0; index < voxelCount; index++) {
    const label = source[index];
    if (!Number.isInteger(label) || label < 0 || label > 255) {
      throw new Error(`Segmentation contains an invalid label at voxel ${index}.`);
    }
    snapshot[index] = label;
  }

  const sourceStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(snapshot);
      controller.close();
    },
  });
  const compressedStream = sourceStream.pipeThrough(new CompressionStream("gzip"));
  return new Response(compressedStream).arrayBuffer();
}
