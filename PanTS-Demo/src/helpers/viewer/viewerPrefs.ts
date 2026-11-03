// Longitudinal viewer preferences: the handful of readout settings a reader
// otherwise re-establishes by hand on every single case — organ labels on
// hover, reference lines, cine speed, which side panels are open, the CT window
// preset, the layout they read in, and brush size.
//
// One versioned key holding one object, rather than a key per setting, so a
// future shape change can drop the whole record cleanly instead of leaving
// orphaned half-migrated keys behind. Every read is total: corrupt JSON, wrong
// types, unknown enum members and out-of-range numbers fall back to that
// field's default and never throw while a case is loading.
export const VIEWER_PREFS_KEY = "bodymaps_viewer_prefs";
export const VIEWER_PREFS_VERSION = 1;

// Mirrors of the viewer's own unions (VisualizationPage's ViewMode /
// LayoutPreset). Duplicated on purpose: this module is imported *by* that route
// and must not import it back. Kept as whitelists so a stored value from an
// older build can't put the viewer into a mode it no longer has.
export const PREF_VIEW_MODES = ["mpr", "axial", "sagittal", "coronal", "3d"] as const;
export type PrefViewMode = (typeof PREF_VIEW_MODES)[number];
export const PREF_LAYOUT_PRESETS = ["grid", "axial-primary", "sagittal-primary", "coronal-primary", "3d-primary"] as const;
export type PrefLayoutPreset = (typeof PREF_LAYOUT_PRESETS)[number];

export const CINE_FPS_MIN = 1;
export const CINE_FPS_MAX = 100;
export const BRUSH_MM_MIN = 2;
export const BRUSH_MM_MAX = 40;
const WINDOW_WIDTH_MIN = 1;
const WINDOW_WIDTH_MAX = 20000;
const WINDOW_CENTER_MIN = -10000;
const WINDOW_CENTER_MAX = 10000;

export interface ViewerPanelsPref {
	stats?: boolean;
	metadata?: boolean;
	measurements?: boolean;
}

export interface ViewerWindowPref {
	/** Preset display name (e.g. "Soft Tissue"). Restored only when the caller
	 *  recognises it — the W/L numbers below are what actually matter. */
	preset?: string;
	width?: number;
	center?: number;
}

export interface ViewerLayoutPref {
	viewMode?: PrefViewMode;
	preset?: PrefLayoutPreset;
}

export interface ViewerPrefs {
	hoverIdentify?: boolean;
	referenceLines?: boolean;
	cineFps?: number;
	panels?: ViewerPanelsPref;
	window?: ViewerWindowPref;
	layout?: ViewerLayoutPref;
	brushDiameterMm?: number;
}

const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const asNumber = (v: unknown, min: number, max: number): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
	typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** Trims untrusted stored data down to the fields that are actually valid.
 *  Anything unrecognised is simply dropped, so a hand-edited or older record
 *  degrades to defaults field-by-field instead of failing as a whole. */
export function sanitizeViewerPrefs(raw: unknown): ViewerPrefs {
	if (!raw || typeof raw !== "object") return {};
	const input = raw as Record<string, unknown>;

	const panelsRaw = (input.panels ?? {}) as Record<string, unknown>;
	const windowRaw = (input.window ?? {}) as Record<string, unknown>;
	const layoutRaw = (input.layout ?? {}) as Record<string, unknown>;

	const panels: ViewerPanelsPref = {
		stats: asBool(panelsRaw.stats),
		metadata: asBool(panelsRaw.metadata),
		measurements: asBool(panelsRaw.measurements),
	};
	const window: ViewerWindowPref = {
		preset: typeof windowRaw.preset === "string" ? windowRaw.preset : undefined,
		width: asNumber(windowRaw.width, WINDOW_WIDTH_MIN, WINDOW_WIDTH_MAX),
		center: asNumber(windowRaw.center, WINDOW_CENTER_MIN, WINDOW_CENTER_MAX),
	};
	const layout: ViewerLayoutPref = {
		viewMode: oneOf(layoutRaw.viewMode, PREF_VIEW_MODES),
		preset: oneOf(layoutRaw.preset, PREF_LAYOUT_PRESETS),
	};

	const prefs: ViewerPrefs = {
		hoverIdentify: asBool(input.hoverIdentify),
		referenceLines: asBool(input.referenceLines),
		cineFps: asNumber(input.cineFps, CINE_FPS_MIN, CINE_FPS_MAX),
		brushDiameterMm: asNumber(input.brushDiameterMm, BRUSH_MM_MIN, BRUSH_MM_MAX),
	};
	// Drop sub-objects that sanitized down to nothing but `undefined` keys, so a
	// caller can test `prefs.window?.width` without tripping over `{}`.
	if (Object.values(panels).some((v) => v !== undefined)) prefs.panels = panels;
	if (Object.values(window).some((v) => v !== undefined)) prefs.window = window;
	if (Object.values(layout).some((v) => v !== undefined)) prefs.layout = layout;
	return prefs;
}

function resolveStorage(storage?: Storage): Storage | undefined {
	if (storage) return storage;
	return typeof window !== "undefined" ? window.localStorage : undefined;
}

export function loadViewerPrefs(storage?: Storage): ViewerPrefs {
	try {
		const store = resolveStorage(storage);
		if (!store) return {};
		const raw = store.getItem(VIEWER_PREFS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as { version?: unknown; prefs?: unknown };
		// An unrecognised version is treated as "no preferences yet" rather than
		// guessed at — the next save rewrites it in the current shape.
		if (parsed?.version !== VIEWER_PREFS_VERSION) return {};
		return sanitizeViewerPrefs(parsed.prefs);
	} catch {
		return {};
	}
}

/** Shallow-merges `patch` over what's stored (one level deep, which is all this
 *  record has) and writes it back. Silently no-ops when storage is unavailable
 *  — a preference that can't be saved is never worth interrupting a read for. */
export function saveViewerPrefs(patch: ViewerPrefs, storage?: Storage): void {
	try {
		const store = resolveStorage(storage);
		if (!store) return;
		const current = loadViewerPrefs(store);
		const merged = sanitizeViewerPrefs({
			...current,
			...patch,
			panels: { ...current.panels, ...patch.panels },
			window: { ...current.window, ...patch.window },
			layout: { ...current.layout, ...patch.layout },
		});
		store.setItem(VIEWER_PREFS_KEY, JSON.stringify({ version: VIEWER_PREFS_VERSION, prefs: merged }));
	} catch {
		/* storage full / blocked — the session just won't remember */
	}
}

export function clearViewerPrefs(storage?: Storage): void {
	try {
		resolveStorage(storage)?.removeItem(VIEWER_PREFS_KEY);
	} catch {
		/* nothing to do */
	}
}
