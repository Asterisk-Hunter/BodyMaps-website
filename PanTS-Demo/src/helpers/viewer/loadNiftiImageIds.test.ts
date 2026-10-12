import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the installed NIfTI metadata loader, including its real URL parsing
// and header reader. Only the WebGL metadata registry and network are replaced.
vi.mock("@cornerstonejs/core", () => ({
	eventTarget: new EventTarget(),
	triggerEvent: vi.fn(),
	utilities: { genericMetadataProvider: { add: vi.fn(), addRaw: vi.fn() } },
}));

import { createNiftiImageIdsAndCacheMetadata } from "./loadNiftiImageIds";

function niftiFixture(): ArrayBuffer {
	const bytes = new ArrayBuffer(352 + 4 * 4 * 8 * 2);
	const header = new DataView(bytes);
	header.setInt32(0, 348, true);
	[3, 4, 4, 8, 1, 1, 1, 1].forEach((value, index) => header.setInt16(40 + index * 2, value, true));
	header.setInt16(70, 4, true); // signed 16-bit voxels
	header.setInt16(72, 16, true);
	[1, 1, 1, 1].forEach((value, index) => header.setFloat32(76 + index * 4, value, true));
	header.setFloat32(108, 352, true);
	header.setInt16(254, 1, true);
	[280, 300, 320].forEach((offset) => header.setFloat32(offset, 1, true));
	new Uint8Array(bytes, 344, 4).set([110, 43, 49, 0]);
	return bytes;
}

beforeEach(() => {
	window.history.replaceState(null, "", "/session/test-result");
	vi.stubGlobal("fetch", vi.fn(async () => new Response(niftiFixture(), {
		headers: { "Content-Type": "application/octet-stream" },
	})));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("NIfTI loader URL boundary", () => {
	it.each([
		"/api/session-ct/test-result",
		"/api/session-segmentation/test-result",
		"/api/get-main-nifti/35.nii?res=low",
		"/api/get-segmentations/CV_00000012.nii",
	])("loads a same-origin %s through the real metadata parser", async (url) => {
		const ids = await createNiftiImageIdsAndCacheMetadata({ url });
		const absolute = `${window.location.origin}${url}`;
		expect(fetch).toHaveBeenCalledWith(absolute, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(ids).toHaveLength(8);
		expect(ids[0]).toBe(`nifti:${absolute}?frame=0`);
	});

	it.each([
		"https://storage.example.test/scan.nii?token=fixture%2Bvalue",
		"blob:http://localhost/local-volume",
	])("preserves an absolute or local volume URL: %s", async (url) => {
		const ids = await createNiftiImageIdsAndCacheMetadata({ url });
		expect(fetch).toHaveBeenCalledWith(url, expect.any(Object));
		expect(ids).toHaveLength(8);
	});

	it("rejects an absent URL instead of requesting the current HTML page", () => {
		expect(() => createNiftiImageIdsAndCacheMetadata({ url: "" })).toThrow("NIfTI volume URL is required");
		expect(fetch).not.toHaveBeenCalled();
	});
});
