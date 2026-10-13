import { describe, expect, it, vi } from "vitest";
import {
	isPanTSMirrorCombinedMaskUrl,
	remapPanTSMirrorLabels,
	remapPanTSMirrorMaskVolume,
} from "./pantsMirrorLabels";

const mirrorUrl =
	"https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/PanTS_00000035/combined_labels.nii.gz?download=true";

describe("PanTS mirror label compatibility", () => {
	it("recognizes only the exact Hugging Face combined-mask path", () => {
		expect(isPanTSMirrorCombinedMaskUrl(mirrorUrl)).toBe(true);
		expect(isPanTSMirrorCombinedMaskUrl(
			"https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/v1/mask_only/PanTS_00000035/combined_labels.nii.gz"
		)).toBe(true);
		expect(isPanTSMirrorCombinedMaskUrl(
			"https://huggingface.co.evil.example/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/PanTS_00000035/combined_labels.nii.gz"
		)).toBe(false);
		expect(isPanTSMirrorCombinedMaskUrl(
			"https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/PanTS_00000035/ct.nii.gz"
		)).toBe(false);
		expect(isPanTSMirrorCombinedMaskUrl(
			"https://example.org/api/get-segmentations/35.nii.gz?labels=viewer-v1"
		)).toBe(false);
	});

	it("permutes only labels 22–28 in one raw-to-viewer mapping", () => {
		expect(remapPanTSMirrorLabels(Uint8Array.from({ length: 29 }, (_, i) => i)))
			.toEqual(Uint8Array.from([0, ...Array.from({ length: 21 }, (_, i) => i + 1), 23, 24, 25, 26, 27, 28, 22]));
	});

	it("rejects unsupported or fractional labels before callers can install them", () => {
		expect(() => remapPanTSMirrorLabels([0, 1, 29])).toThrow(/Unsupported PanTS mirror label 29/);
		expect(() => remapPanTSMirrorLabels([1, 2.5])).toThrow(/Unsupported PanTS mirror label 2.5/);
		expect(() => remapPanTSMirrorLabels([Number.NaN])).toThrow(/Unsupported PanTS mirror label NaN/);
	});

	it("writes the converted scalar array once per volume and ignores other sources", () => {
		const values = Uint8Array.from([0, 22, 23, 28]);
		const setCompleteScalarDataArray = vi.fn((data: Uint8Array) => {
			volume.voxelManager!.getCompleteScalarDataArray = () => data;
		});
		const volume = {
			voxelManager: {
				getCompleteScalarDataArray: () => values,
				setCompleteScalarDataArray,
			},
		};

		expect(remapPanTSMirrorMaskVolume(volume, "https://app.example/mask.nii.gz")).toBe(false);
		expect(remapPanTSMirrorMaskVolume(volume, mirrorUrl)).toBe(true);
		expect(setCompleteScalarDataArray).toHaveBeenCalledOnce();
		expect(volume.voxelManager.getCompleteScalarDataArray?.()).toEqual(Uint8Array.from([0, 23, 24, 22]));
		expect(remapPanTSMirrorMaskVolume(volume, mirrorUrl)).toBe(false);
		expect(setCompleteScalarDataArray).toHaveBeenCalledOnce();
	});
});
