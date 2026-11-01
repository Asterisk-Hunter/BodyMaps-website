/**
 * The first target pick captures the pre-edit baseline used by the live 3D
 * mesh. It is one snapshot per class, taken before that class is edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "@cornerstonejs/core";
import {
	clearEditedSegments,
  consumePreEditSegmentSnapshot,
	markSegmentEdited,
	setActiveEditSegment,
} from "../helpers/CornerstoneNifti2";
import { segmentation_categories } from "../helpers/constants";

const N = 4 * 4 * 4;
const CUSTOM_A = segmentation_categories.length + 1;
const CUSTOM_B = segmentation_categories.length + 2;

let read: ReturnType<typeof vi.fn>;
let data: Uint8Array;

beforeEach(() => {
	clearEditedSegments();
	data = new Uint8Array(N);
	read = vi.fn(() => data);
	vi.spyOn(cache, "getVolume").mockReturnValue({
		loadStatus: { loaded: true },
		voxelManager: { dimensions: [4, 4, 4], getCompleteScalarDataArray: read },
	} as never);
	setActiveEditSegment(0); // start from no target
	read.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("pre-edit snapshots", () => {
	it("capture each catalog organ before its first edit", () => {
		setActiveEditSegment(1);
		const first = consumePreEditSegmentSnapshot(1);
		expect(first).not.toBeNull();
		expect(first?.mask.every((value) => value === 0)).toBe(true);
		data[0] = 1;
		markSegmentEdited(1);
		setActiveEditSegment(2);
		const second = consumePreEditSegmentSnapshot(2);

		expect(second).not.toBeNull();
		expect(read).toHaveBeenCalledTimes(2);
		expect(consumePreEditSegmentSnapshot(1)).toBeNull();
	});

	it("preserves a custom class baseline after its first edit", () => {
		setActiveEditSegment(CUSTOM_A);
		const first = consumePreEditSegmentSnapshot(CUSTOM_A);
		expect(first).not.toBeNull();
		data[0] = CUSTOM_A;
		markSegmentEdited(CUSTOM_A);
		setActiveEditSegment(CUSTOM_B);
		const second = consumePreEditSegmentSnapshot(CUSTOM_B);

		expect(second).not.toBeNull();
		expect(read).toHaveBeenCalledTimes(2);
		expect(first?.mask[0]).toBe(0);
	});
});
