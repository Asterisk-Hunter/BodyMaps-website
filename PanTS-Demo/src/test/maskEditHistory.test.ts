/**
 * The shared undo stacks belong to one case. Their entries are closures over
 * that case's labelmap, so they are emptied when the case is disposed (the
 * SPA keeps this module alive across cases), and the fill stack is capped so
 * a long session doesn't keep every edit's voxel list alive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { utilities as csCoreUtils } from "@cornerstonejs/core";
import {
	canRedoSmartFill,
	canUndoSmartFill,
	getMaskEditHistoryState,
	pushEditHistory,
	resetMaskEditHistory,
	undoMaskEdit,
	undoSmartFill,
} from "../helpers/CornerstoneNifti2";

afterEach(() => {
	resetMaskEditHistory();
});

describe("mask edit history", () => {
	it("forgets the previous case's edits on both stacks", () => {
		const staleFill = vi.fn();
		pushEditHistory({ undo: staleFill, redo: vi.fn() });
		pushEditHistory({ undo: staleFill, redo: vi.fn() });
		const staleBrush = { restoreMemo: vi.fn() };
		csCoreUtils.HistoryMemo.DefaultHistoryMemo.push(staleBrush as never);
		expect(canUndoSmartFill()).toBe(true);
		expect(csCoreUtils.HistoryMemo.DefaultHistoryMemo.canUndo).toBe(true);

		resetMaskEditHistory();

		expect(canUndoSmartFill()).toBe(false);
		expect(canRedoSmartFill()).toBe(false);
		expect(csCoreUtils.HistoryMemo.DefaultHistoryMemo.canUndo).toBe(false);
		// Ctrl+Z on the new case reaches neither old closure.
		undoMaskEdit();
		expect(staleFill).not.toHaveBeenCalled();
		expect(staleBrush.restoreMemo).not.toHaveBeenCalled();
	});

	it("keeps only the newest 50 fill edits", () => {
		const undone: number[] = [];
		for (let i = 0; i < 60; i++) pushEditHistory({ undo: () => undone.push(i), redo: vi.fn() });

		while (undoSmartFill()) { /* drain */ }

		expect(undone).toHaveLength(50);
		expect(undone[0]).toBe(59);
		expect(undone[undone.length - 1]).toBe(10);
	});

	// The cap drops the oldest entries, but their voxels stay in the labelmap, so the
	// leave guard and the HD reload question must keep asking after every remaining
	// entry has been undone.
	it("still counts fill edits that fell off the history as unsaved", () => {
		for (let i = 0; i < 60; i++) pushEditHistory({ undo: vi.fn(), redo: vi.fn() });
		while (undoSmartFill()) { /* drain */ }

		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: false, dirty: true });
		resetMaskEditHistory();
		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: false, dirty: false });
	});

	it("still counts brush strokes that fell off Cornerstone's history as unsaved", () => {
		const memo = csCoreUtils.HistoryMemo.DefaultHistoryMemo;
		for (let i = 0; i <= memo.size; i++) memo.push({ restoreMemo: vi.fn() } as never);
		while (memo.canUndo) undoMaskEdit();

		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: false, dirty: true });
	});

	it("counts a grouped edit that pushed out the oldest stroke", () => {
		const memo = csCoreUtils.HistoryMemo.DefaultHistoryMemo;
		for (let i = 0; i < memo.size; i++) memo.push({ restoreMemo: vi.fn() } as never);
		memo.startGroupRecording();
		memo.push({ restoreMemo: vi.fn() } as never);
		memo.endGroupRecording();
		while (memo.canUndo) undoMaskEdit();

		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: false, dirty: true });
	});

	it("is clean again once every edit it still holds has been undone", () => {
		const memo = csCoreUtils.HistoryMemo.DefaultHistoryMemo;
		for (let i = 0; i < 3; i++) pushEditHistory({ undo: vi.fn(), redo: vi.fn() });
		memo.push({ restoreMemo: vi.fn() } as never);
		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: true, dirty: true });

		for (let i = 0; i < 4; i++) undoMaskEdit();

		expect(getMaskEditHistoryState()).toMatchObject({ canUndo: false, dirty: false });
	});
});
