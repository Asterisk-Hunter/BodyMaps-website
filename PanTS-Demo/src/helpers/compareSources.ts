// Shared CT/segmentation source resolution for the comparison viewer. The comparison
// page may warm the small viewer JavaScript chunk, but it deliberately never downloads
// CT data in the background: large speculative requests can delay the reader's chosen
// case and overload a shared server.
import { API_BASE } from "./constants";
import { datasetSegmentationUrl } from "./segmentationSource";
import { getPanTSId } from "./utils";

// Local CT preview first, HuggingFace mirror fallback for the CT. The mask comes from the
// backend, which converts the dataset's organ numbering (and reads the mirror itself when it
// has no local copy), while the lab server serves the CT or answers 404 for a case it does
// not store. Any other answer (unreachable, a server error, a refused request) means it will
// not read or convert the mask either, and both volumes come from the mirror, as in the case
// viewer.
// Labelmaps stay full resolution because nearest-neighbour downsampling visibly
// stair-steps organ boundaries and can erase small structures.
// `full` asks for the full-resolution local CT instead of the fast preview, as ?hd=1 does
// in the case viewer.
export async function resolveSources(id: string, full = false): Promise<{ ct: string; seg: string }> {
	const localCt = `${API_BASE}/api/get-main-nifti/${id}.nii.gz`;
	const res = full ? "" : "?res=low";
	// CancerVerse has tumor masks only, for the scans with an annotated tumor (already in the
	// viewer's numbering). For any other scan the segmentation route answers JSON with HTTP 200,
	// which the NIfTI loader never settles on, so the mask is used only when a HEAD says it is
	// a gzip volume, as in the case viewer; otherwise the CT shows alone. Their CT lives only on
	// the lab's server, so there is no mirror, and getPanTSId would build a meaningless mirror
	// name from the id.
	if (/^CV/i.test(id)) {
		const cvSeg = `${API_BASE}/api/get-segmentations/${id}.nii.gz`;
		const maskOk = await fetch(cvSeg, { method: "HEAD" })
			.then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("gzip"))
			.catch(() => false);
		return { ct: `${localCt}${res}`, seg: maskOk ? cvSeg : "" };
	}
	const p = getPanTSId(id);
	const hfCt = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/${p}/ct.nii.gz?download=true`;
	const hfSeg = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/${p}/combined_labels.nii.gz?download=true`;
	// status 0: the request itself failed (network, a backend that is down).
	const probe = await fetch(localCt, { method: "HEAD" })
		.then((r) => ({ ok: r.ok, status: r.status }))
		.catch(() => ({ ok: false, status: 0 }));
	const mirrorMask = !probe.ok && probe.status !== 404;
	return { ct: probe.ok ? `${localCt}${res}` : hfCt, seg: mirrorMask ? hfSeg : datasetSegmentationUrl(id) };
}

// Respect the user's data budget: skip prefetch under Save-Data or on very slow (2G)
// connections — the same restraint the browser applies to native prefetch. These volumes
// are large and only *maybe* used, so honouring this matters.
function prefetchAllowed(): boolean {
	if (typeof navigator === "undefined") return false;
	const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
	if (c?.saveData) return false;
	if (typeof c?.effectiveType === "string" && c.effectiveType.includes("2g")) return false;
	return true;
}

// Warm the lazily-loaded viewer chunk so navigating to it doesn't wait on a JS download.
export function prefetchCompareViewerChunk(): void {
	// Skip under vitest — importing the viewer chunk pulls the WebGL stack jsdom can't load.
	if (typeof process !== "undefined" && process.env?.VITEST) return;
	if (!prefetchAllowed()) return;
	import("../routes/CompareViewerPage").catch(() => {});
}
