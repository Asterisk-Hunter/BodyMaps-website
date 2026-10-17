import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSources } from "./compareSources";

describe("comparison volume resolution", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses preview CT with full-resolution segmentation", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

		const sources = await resolveSources("35");

		expect(sources.ct).toContain("/api/get-main-nifti/35.nii.gz?res=low");
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
		expect(sources.seg).not.toContain("res=low");
	});

	it("reads the full-resolution CT when asked", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

		const sources = await resolveSources("35", true);

		expect(sources.ct).toMatch(/\/api\/get-main-nifti\/35\.nii\.gz$/);
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
	});

	it("loads the mask from the backend when the lab server says it has no such case", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

		const sources = await resolveSources("35");

		expect(sources.ct).toContain("huggingface.co");
		// The mirror's raw mask numbers the spleen, stomach and lesion differently from the viewer.
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
		expect(sources.seg).not.toContain("mask_only");
	});

	it.each([
		["cannot be reached", () => Promise.reject(new TypeError("Failed to fetch"))],
		["answers with a gateway error", () => Promise.resolve({ ok: false, status: 502 })],
		["has its dataset storage down", () => Promise.resolve({ ok: false, status: 503 })],
		["answers that the sign-in has ended", () => Promise.resolve({ ok: false, status: 401 })],
		["refuses the request", () => Promise.resolve({ ok: false, status: 403 })],
	])("loads both volumes from the mirror when the lab server %s", async (_why, answer) => {
		const fetchMock = vi.fn(answer);
		vi.stubGlobal("fetch", fetchMock);

		const sources = await resolveSources("35");

		// The lab server will not read or convert the mask either, so the mirror's own mask
		// goes with the mirror's CT, as in the case viewer.
		expect(sources.ct).toMatch(/^https:\/\/huggingface\.co\/.*\/image_only\//);
		expect(sources.seg).toMatch(/^https:\/\/huggingface\.co\/.*\/mask_only\//);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("overlays a CancerVerse tumor mask when the route answers with a volume", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "application/gzip" } });
		vi.stubGlobal("fetch", fetchMock);

		const sources = await resolveSources("CV_00000001");

		expect(sources.ct).toContain("/api/get-main-nifti/CV_00000001.nii.gz?res=low");
		expect(sources.seg).toMatch(/\/api\/get-segmentations\/CV_00000001\.nii\.gz$/);
		expect(fetchMock).toHaveBeenCalledWith(sources.seg, { method: "HEAD" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("shows a CancerVerse CT alone when the route answers that it has no mask", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "application/json" } }));

		const sources = await resolveSources("CV_00000002");

		expect(sources.ct).toContain("/api/get-main-nifti/CV_00000002.nii.gz?res=low");
		expect(sources.seg).toBe("");
	});

	it("overlays an AbdomenAtlas organ mask from the lab server only, with no mirror", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "application/gzip" } });
		vi.stubGlobal("fetch", fetchMock);

		const sources = await resolveSources("BDMAP_00000001");

		expect(sources.ct).toContain("/api/get-main-nifti/BDMAP_00000001.nii.gz?res=low");
		expect(sources.seg).toMatch(/\/api\/get-segmentations\/BDMAP_00000001\.nii\.gz$/);
		expect(fetchMock).toHaveBeenCalledWith(sources.seg, { method: "HEAD" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(sources.ct) + String(sources.seg)).not.toContain("huggingface");
	});

	it("shows an AbdomenAtlas CT alone when its mask is not built yet", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "application/json" } }));

		const sources = await resolveSources("BDMAP_00000002");

		expect(sources.ct).toContain("/api/get-main-nifti/BDMAP_00000002.nii.gz?res=low");
		expect(sources.seg).toBe("");
	});

	it("shows a CancerVerse CT alone when the mask check fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

		const sources = await resolveSources("CV_00000003", true);

		expect(sources.ct).toMatch(/\/api\/get-main-nifti\/CV_00000003\.nii\.gz$/);
		expect(sources.seg).toBe("");
	});
});
