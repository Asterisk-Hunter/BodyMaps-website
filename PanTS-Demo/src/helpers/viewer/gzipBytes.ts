/** Gzip bytes without deadlocking the TransformStream on writable backpressure. */
export async function gzipBytes(data: Uint8Array): Promise<ArrayBuffer> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
	const compressed = source.pipeThrough(new CompressionStream("gzip"));
	return await new Response(compressed).arrayBuffer();
}
