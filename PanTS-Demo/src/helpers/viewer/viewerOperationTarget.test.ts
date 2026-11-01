import { describe, expect, it, vi } from "vitest";
import { assertCurrentViewerTarget, type ViewerOperationTarget } from "./viewerOperationTarget";

describe("viewer operation targets", () => {
	it("rejects a response captured for a replaced same-shape volume before applying it", () => {
		const oldVolume = { dimensions: [4, 4, 4], scalarData: new Uint8Array(64) };
		const newVolume = { dimensions: [4, 4, 4], scalarData: new Uint8Array(64) };
		const captured: ViewerOperationTarget = {
			generation: 7,
			segmentationId: "case-a-seg",
			volume: oldVolume,
		};
		const current: ViewerOperationTarget = {
			generation: 8,
			segmentationId: "case-b-seg",
			volume: newVolume,
		};
		const applyProposal = vi.fn(() => {
			assertCurrentViewerTarget(captured, current);
			newVolume.scalarData.fill(9);
		});

		expect(applyProposal).toThrow(/viewer changed/i);
		expect(applyProposal).toHaveBeenCalledOnce();
		expect([...newVolume.scalarData]).toEqual(Array(64).fill(0));
	});

	it("rejects a replaced volume even when the resource id and generation are unchanged", () => {
		const captured: ViewerOperationTarget = {
			generation: 7,
			segmentationId: "case-a-seg",
			volume: { dimensions: [4, 4, 4] },
		};
		const current: ViewerOperationTarget = {
			generation: 7,
			segmentationId: "case-a-seg",
			volume: { dimensions: [4, 4, 4] },
		};

		expect(() => assertCurrentViewerTarget(captured, current)).toThrow(/viewer changed/i);
	});
});
