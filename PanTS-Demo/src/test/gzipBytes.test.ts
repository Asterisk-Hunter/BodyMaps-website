import { describe, expect, it } from "vitest";
import { gzipBytes } from "../helpers/viewer/gzipBytes";

describe("gzipBytes", () => {
	it("compresses a full-volume buffer without blocking on stream backpressure", async () => {
		const source = new Uint8Array(8 * 1024 * 1024);
		source[0] = 1;
		source[source.length - 1] = 255;

		const compressed = await gzipBytes(source);
		const bytes = new Uint8Array(compressed);
		expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b]);
		expect(bytes.length).toBeLessThan(source.length);
	});
});
