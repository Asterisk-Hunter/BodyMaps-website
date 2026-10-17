// Which dataset a case id belongs to. The ids the app and the backend use are
//   PanTS         the bare number ("17") or "PanTS_00000017"
//   CancerVerse   "CV_00000001"
//   AbdomenAtlas  "BDMAP_00000001"
// CancerVerse and AbdomenAtlas scans live only on the lab's server (there is no public mirror
// to fall back to), so the viewer treats them alike when it loads a case.

const CANCERVERSE_ID = /^CV/i;
const ABDOMENATLAS_ID = /^BDMAP/i;

const text = (id: unknown): string => String(id ?? "").trim();

export const isCancerVerseCaseId = (id: unknown): boolean => CANCERVERSE_ID.test(text(id));

export const isAbdomenAtlasCaseId = (id: unknown): boolean => ABDOMENATLAS_ID.test(text(id));

/** A CancerVerse or AbdomenAtlas case: its CT is only on the lab's server, never on the PanTS mirror. */
export const isServerOnlyCaseId = (id: unknown): boolean =>
	isCancerVerseCaseId(id) || isAbdomenAtlasCaseId(id);
