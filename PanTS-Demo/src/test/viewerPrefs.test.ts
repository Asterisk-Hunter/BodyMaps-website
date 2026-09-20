import { describe, expect, it } from "vitest";
import {
	BRUSH_MM_MAX,
	clearViewerPrefs,
	CINE_FPS_MAX,
	loadViewerPrefs,
	sanitizeViewerPrefs,
	saveViewerPrefs,
	VIEWER_PREFS_KEY,
	VIEWER_PREFS_VERSION,
	type ViewerPrefs,
} from "../helpers/viewer/viewerPrefs";

/** Minimal in-memory Storage, so these tests never touch the real
 *  localStorage that other suites in the same run might be using. */
function memoryStorage(seed: Record<string, string> = {}) {
	const map = new Map(Object.entries(seed));
	const storage: Storage = {
		get length() {
			return map.size;
		},
		key: (index: number) => [...map.keys()][index] ?? null,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
	};
	return { storage, map };
}

const FULL: ViewerPrefs = {
	hoverIdentify: true,
	referenceLines: true,
	cineFps: 24,
	brushDiameterMm: 18,
	panels: { stats: true, metadata: false, measurements: true },
	window: { preset: "Bone", width: 2000, center: 400 },
	layout: { viewMode: "axial", preset: "axial-primary" },
};

describe("viewer preferences", () => {
	it("reads back exactly what it saved", () => {
		const { storage } = memoryStorage();
		saveViewerPrefs(FULL, storage);
		expect(loadViewerPrefs(storage)).toEqual(FULL);
	});

	it("starts empty when nothing has been stored", () => {
		const { storage } = memoryStorage();
		expect(loadViewerPrefs(storage)).toEqual({});
	});

	it("writes a versioned record so an older shape can be discarded", () => {
		const { storage, map } = memoryStorage();
		saveViewerPrefs({ hoverIdentify: true }, storage);
		expect(JSON.parse(map.get(VIEWER_PREFS_KEY)!)).toEqual({
			version: VIEWER_PREFS_VERSION,
			prefs: { hoverIdentify: true },
		});
	});

	it("treats an unrecognised version as no preferences at all", () => {
		const { storage } = memoryStorage({
			[VIEWER_PREFS_KEY]: JSON.stringify({
				version: VIEWER_PREFS_VERSION + 1,
				prefs: { hoverIdentify: true },
			}),
		});
		expect(loadViewerPrefs(storage)).toEqual({});
	});

	it("survives corrupt JSON rather than throwing while a case loads", () => {
		const { storage } = memoryStorage({ [VIEWER_PREFS_KEY]: "{ not json" });
		expect(loadViewerPrefs(storage)).toEqual({});
	});

	it("drops every field that doesn't validate, keeping the ones that do", () => {
		expect(
			sanitizeViewerPrefs({
				hoverIdentify: "yes", // wrong type
				referenceLines: false, // fine
				cineFps: CINE_FPS_MAX + 1, // out of range
				brushDiameterMm: BRUSH_MM_MAX + 1,
				panels: { stats: true, metadata: "maybe" },
				window: { width: -5, center: 40 },
				layout: { viewMode: "axial", preset: "not-a-layout" },
			})
		).toEqual({
			referenceLines: false,
			panels: { stats: true },
			window: { center: 40 },
			layout: { viewMode: "axial" },
		});
	});

	it("rejects the top-level value when it isn't an object", () => {
		expect(sanitizeViewerPrefs(null)).toEqual({});
		expect(sanitizeViewerPrefs("nope")).toEqual({});
	});

	it("merges a patch without dropping the sibling keys of the same object", () => {
		const { storage } = memoryStorage();
		saveViewerPrefs({ hoverIdentify: true, panels: { stats: true } }, storage);
		saveViewerPrefs({ cineFps: 30, panels: { measurements: true } }, storage);
		expect(loadViewerPrefs(storage)).toEqual({
			hoverIdentify: true,
			cineFps: 30,
			panels: { stats: true, measurements: true },
		});
	});

	it("never disturbs the reader when storage refuses to work", () => {
		const hostile = {
			get length() {
				return 0;
			},
			key: () => null,
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			clear: () => {
				throw new Error("blocked");
			},
		} as unknown as Storage;

		expect(() => saveViewerPrefs(FULL, hostile)).not.toThrow();
		expect(loadViewerPrefs(hostile)).toEqual({});
		expect(() => clearViewerPrefs(hostile)).not.toThrow();
	});

	it("clears the record on request", () => {
		const { storage, map } = memoryStorage();
		saveViewerPrefs(FULL, storage);
		clearViewerPrefs(storage);
		expect(map.has(VIEWER_PREFS_KEY)).toBe(false);
		expect(loadViewerPrefs(storage)).toEqual({});
	});
});
