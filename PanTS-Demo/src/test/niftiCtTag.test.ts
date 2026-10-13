/**
 * NIfTI volumes carry no DICOM Modality, and the ROI tools only print "HU" for CT, so
 * dataset and local NIfTI scans are tagged CT when they load; a volume that already
 * names its modality (local DICOM) keeps it.
 */
import { describe, expect, it } from "vitest";
import { _tagNiftiVolumeAsCt } from "../helpers/CornerstoneNifti2";

describe("_tagNiftiVolumeAsCt", () => {
	it("tags a volume with no Modality as CT", () => {
		const volume = { metadata: {} as { Modality?: string } };
		_tagNiftiVolumeAsCt(volume);
		expect(volume.metadata.Modality).toBe("CT");
	});

	it("leaves a volume's own Modality alone", () => {
		const volume = { metadata: { Modality: "MR" } };
		_tagNiftiVolumeAsCt(volume);
		expect(volume.metadata.Modality).toBe("MR");
	});

	it("does nothing to a volume without metadata", () => {
		const volume: { metadata?: unknown } = {};
		expect(() => _tagNiftiVolumeAsCt(volume)).not.toThrow();
		expect(volume.metadata).toBeUndefined();
	});
});
