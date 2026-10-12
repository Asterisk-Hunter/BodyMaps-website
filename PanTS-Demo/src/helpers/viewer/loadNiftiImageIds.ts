import { createNiftiImageIdsAndCacheMetadata as loadNiftiImageIds } from "@cornerstonejs/nifti-volume-loader";

// Cornerstone calls new URL(url) without a base before fetching. API_BASE is
// intentionally empty for same-origin deployments, so normalize only at this
// loader boundary. Absolute URLs and local blob URLs keep their own origin.
export function createNiftiImageIdsAndCacheMetadata({ url }: { url: string }) {
	if (!url.trim()) throw new TypeError("A NIfTI volume URL is required.");
	return loadNiftiImageIds({ url: new URL(url, window.location.href).href });
}
