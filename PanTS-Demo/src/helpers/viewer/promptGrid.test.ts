import { describe, expect, it } from "vitest";
import { boxSamplesTouchGrid, isIndexInsideGrid, hasThickSliceSpacing } from "./promptGrid";

describe("interactive prompt grid safety", () => {
	it("rejects a prompt outside the loaded labelmap dimensions", () => {
		expect(isIndexInsideGrid([10, 4, 2], [10, 8, 6])).toBe(false);
		expect(isIndexInsideGrid([9, 7, 5], [10, 8, 6])).toBe(true);
	});

	it("flags scans whose thickest voxel spacing is at least three times the thinnest", () => {
		expect(hasThickSliceSpacing([0.8, 0.8, 5])).toBe(true);
		expect(hasThickSliceSpacing([1, 1, 2])).toBe(false);
		expect(hasThickSliceSpacing(null)).toBe(false);
	});

	it("accepts a box drawn from black margins when sampled points intersect the scan", () => {
		const intersects = boxSamplesTouchGrid([-10, -10, 0], [10, 10, 0], ([x, y]) =>
			x >= 0 && x < 4 && y >= 0 && y < 4,
		);
		expect(intersects).toBe(true);
	});
});
