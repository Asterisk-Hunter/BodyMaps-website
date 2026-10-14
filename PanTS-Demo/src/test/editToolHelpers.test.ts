/**
 * The small helpers behind the edit tools and the class bookkeeping: visibility by class id,
 * the split's rows and target, the hover tip's edge flip and the release-to-commit click.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Color } from "@cornerstonejs/core/types";
import { CANCERVERSE_TUMOR_IDS, segmentation_categories } from "../helpers/constants";
import { toggleCheckState, visibilityById, visibilityFromCheckState } from "../components/segmentation/segmentVisibility";
import { splitClassBookkeeping, type ClassTarget } from "../helpers/splitClassBookkeeping";
import { organTipPosition } from "../helpers/viewer/organTipPosition";
import { commitOnRelease } from "../helpers/viewer/commitOnRelease";
import type { CheckBoxData } from "../types";

const catalog = segmentation_categories.map((_, i) => ({ id: i + 1 }));

describe("visibility by class id", () => {
	it("keeps each class at its own id after a middle custom class is deleted", () => {
		const first = catalog.length + 1;
		const organs = [...catalog, { id: first }, { id: first + 2 }]; // first + 1 was deleted
		const state: boolean[] = [];
		state[first] = false;
		state[first + 2] = true;
		const arr = visibilityById(organs, state);
		expect(arr[0]).toBe(true);
		expect(arr[first]).toBe(false);
		expect(arr[first + 1]).toBe(false);
		expect(arr[first + 2]).toBe(true);
		expect(arr).toHaveLength(first + 3);
	});

	it("puts the CancerVerse tumor classes at their own label ids", () => {
		const state: boolean[] = [];
		for (const id of CANCERVERSE_TUMOR_IDS) state[id] = true;
		const arr = visibilityById(catalog, state);
		for (const id of CANCERVERSE_TUMOR_IDS) expect(arr[id]).toBe(true);
		expect(arr.filter(Boolean)).toHaveLength(CANCERVERSE_TUMOR_IDS.size + 1);
	});

	it("reads and flips the drawn state", () => {
		const state = [true, true, false];
		expect(visibilityFromCheckState([{ id: 1 }, { id: 2 }], state)).toEqual({ 1: true, 2: false });
		expect(toggleCheckState(state, 2)).toEqual([true, true, true]);
		expect(state).toEqual([true, true, false]);
	});
});

describe("split class bookkeeping", () => {
	function harness(target: ClassTarget) {
		const s = {
			rows: [{ id: 1, label: "Liver" }] as CheckBoxData[],
			check: [true, true] as boolean[],
			colors: {} as { [key: number]: Color },
			hex: {} as Record<number, string>,
			target,
		};
		const book = splitClassBookkeeping(
			{
				setCheckBoxData: (f) => { s.rows = f(s.rows); },
				setCheckState: (f) => { s.check = f(s.check); },
				setLabelColorMap: (f) => { s.colors = f(s.colors); },
				setSegmentColorsHex: (f) => { s.hex = f(s.hex); },
				setActiveSegment: (id) => { s.target = { ...s.target, segment: id }; },
				setActiveCatalogOrgan: (id) => { s.target = { ...s.target, catalogOrgan: id }; },
				getTarget: () => s.target,
				colorToHex: () => "#ff0000",
			},
			target,
		);
		return { s, book };
	}
	const created = [
		{ id: 50, label: "Class 50", color: [255, 0, 0, 255] as Color },
		{ id: 51, label: "Class 51", color: [0, 255, 0, 255] as Color },
	];

	it("adds the new classes and targets the first, and an undo takes them out again", () => {
		const { s, book } = harness({ segment: null, catalogOrgan: 1 });
		book.add(created);
		expect(s.rows.map((r) => r.id)).toEqual([1, 50, 51]);
		expect(s.check[50]).toBe(true);
		expect(s.target).toEqual({ segment: 50, catalogOrgan: null });
		book.add(created); // a redo after a redo does not duplicate rows
		expect(s.rows.map((r) => r.id)).toEqual([1, 50, 51]);

		book.remove(created);
		expect(s.rows.map((r) => r.id)).toEqual([1]);
		expect(s.colors[50]).toBeUndefined();
		expect(s.hex[51]).toBeUndefined();
		expect(s.target).toEqual({ segment: null, catalogOrgan: 1 });
	});

	it("leaves a target picked after the split alone", () => {
		const { s, book } = harness({ segment: null, catalogOrgan: 1 });
		book.add(created);
		s.target = { segment: 7, catalogOrgan: null };
		book.remove(created);
		expect(s.target).toEqual({ segment: 7, catalogOrgan: null });
	});
});

describe("hover tip placement", () => {
	it("sits right of and below the pointer when there is room", () => {
		expect(organTipPosition(100, 100, "liver", 1280, 720)).toEqual({ x: 114, y: 114 });
	});

	it("flips left and up near the right and bottom edges", () => {
		const pos = organTipPosition(1270, 710, "pancreatic lesion", 1280, 720);
		expect(pos.x).toBeLessThan(1270);
		expect(pos.y).toBeLessThan(710);
		expect(pos.x).toBeGreaterThanOrEqual(8);
	});
});

describe("commit on release", () => {
	afterEach(() => vi.restoreAllMocks());
	const up = (x: number, y: number) => window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y }));
	const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));

	it("commits a click that stays within the pan slack", () => {
		const commit = vi.fn();
		commitOnRelease({ clientX: 10, clientY: 10 }, commit);
		move(13, 12);
		up(13, 12);
		expect(commit).toHaveBeenCalledTimes(1);
		up(13, 12);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("treats a press that travels 4 px as a pan", () => {
		const commit = vi.fn();
		commitOnRelease({ clientX: 10, clientY: 10 }, commit);
		move(14, 10);
		move(10, 10);
		up(10, 10);
		expect(commit).not.toHaveBeenCalled();
	});

	it("drops the press on a window blur and when a new press replaces it", () => {
		const first = vi.fn();
		commitOnRelease({ clientX: 0, clientY: 0 }, first);
		window.dispatchEvent(new Event("blur"));
		up(0, 0);
		expect(first).not.toHaveBeenCalled();

		const older = vi.fn();
		const newer = vi.fn();
		commitOnRelease({ clientX: 0, clientY: 0 }, older);
		commitOnRelease({ clientX: 0, clientY: 0 }, newer);
		up(0, 0);
		expect(older).not.toHaveBeenCalled();
		expect(newer).toHaveBeenCalledTimes(1);
	});
});
