import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const promptApi = vi.hoisted(() => ({
	canvasPointToWorld: vi.fn(() => [1, 2, 3]),
	worldToVisiblePaneCanvas: vi.fn(() => [1, 2]),
	buildLassoCroppedMask: vi.fn(),
	buildScribbleCroppedMask: vi.fn(),
	submitInteractiveSegmentPrompt: vi.fn(),
	snapWorldToVoxelGrid: vi.fn(),
	getVoxelCanvasDelta: vi.fn(),
}));

vi.mock("../CornerstoneNifti2", () => promptApi);

import { useInteractivePromptTool } from "./useInteractivePromptTool";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function clickEvent() {
	return {
		currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		clientX: 12,
		clientY: 16,
		altKey: false,
	} as any;
}

describe("interactive prompt resource changes", () => {
	beforeEach(() => promptApi.submitInteractiveSegmentPrompt.mockReset());

	it("drops queued prompts when the viewer unmounts", async () => {

		const first = deferred<number>();
		promptApi.submitInteractiveSegmentPrompt.mockReturnValue(first.promise);
		const { result, unmount } = renderHook(() => useInteractivePromptTool({
			enabled: true, mode: "point", apiBase: "http://api.test", caseId: "case-a",
			activeSegmentIndex: 12, res: "full",
		}));
		const click = result.current.handleClick("axial" as any);
		act(() => click(clickEvent()));
		await act(async () => { await Promise.resolve(); await Promise.resolve(); });
		act(() => click(clickEvent()));
		unmount();
		await act(async () => {
			first.resolve(0);
			await first.promise;
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(promptApi.submitInteractiveSegmentPrompt).toHaveBeenCalledTimes(1);
	});

	it("aborts the active case request and drops old-case prompts waiting in the hook queue", async () => {
		const first = deferred<number>();
		promptApi.submitInteractiveSegmentPrompt.mockReturnValue(first.promise);
		const { result, rerender } = renderHook(
			(props: { caseId: string; res: "low" | "full" }) => useInteractivePromptTool({
				enabled: true,
				mode: "point",
				apiBase: "http://api.test",
				caseId: props.caseId,
				activeSegmentIndex: 12,
				res: props.res,
			}),
			{ initialProps: { caseId: "case-a", res: "low" as const } },
		);
		const pointClick = result.current.handleClick("axial" as any);

		act(() => pointClick(clickEvent()));
		await act(async () => { await Promise.resolve(); await Promise.resolve(); });
		expect(promptApi.submitInteractiveSegmentPrompt).toHaveBeenCalledTimes(1);
		const activeSignal = promptApi.submitInteractiveSegmentPrompt.mock.calls[0][6] as AbortSignal;

		// A second old-case operation has entered the hook queue behind request 1.
		act(() => pointClick(clickEvent()));
		rerender({ caseId: "case-b", res: "low" });
		expect(activeSignal.aborted).toBe(true);

		await act(async () => {
			first.resolve(5);
			await first.promise;
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(promptApi.submitInteractiveSegmentPrompt).toHaveBeenCalledTimes(1);
	});

	it("invalidates pending work when the labelmap resolution changes", async () => {
		const first = deferred<number>();
		promptApi.submitInteractiveSegmentPrompt.mockReturnValue(first.promise);
		const { result, rerender } = renderHook(
			(props: { res: "low" | "full" }) => useInteractivePromptTool({
				enabled: true,
				mode: "point",
				apiBase: "http://api.test",
				caseId: "case-a",
				activeSegmentIndex: 12,
				res: props.res,
			}),
			{ initialProps: { res: "low" as const } },
		);

		act(() => result.current.handleClick("axial" as any)(clickEvent()));
		await act(async () => { await Promise.resolve(); await Promise.resolve(); });
		const activeSignal = promptApi.submitInteractiveSegmentPrompt.mock.calls[0][6] as AbortSignal;
		rerender({ res: "full" });
		expect(activeSignal.aborted).toBe(true);
		await act(async () => { first.resolve(0); await first.promise; });
	});

	it("explicit cancel drops prompts that have not started yet", async () => {
		const first = deferred<number>();
		promptApi.submitInteractiveSegmentPrompt.mockReturnValue(first.promise);
		const { result } = renderHook(() => useInteractivePromptTool({
			enabled: true,
			mode: "point",
			apiBase: "http://api.test",
			caseId: "case-a",
			activeSegmentIndex: 12,
			res: "low",
		}));
		const pointClick = result.current.handleClick("axial" as any);

		act(() => pointClick(clickEvent()));
		await act(async () => { await Promise.resolve(); await Promise.resolve(); });
		const activeSignal = promptApi.submitInteractiveSegmentPrompt.mock.calls[0][6] as AbortSignal;
		act(() => pointClick(clickEvent()));
		act(() => result.current.cancel());
		expect(activeSignal.aborted).toBe(true);
		await act(async () => { first.resolve(0); await first.promise; });
		expect(promptApi.submitInteractiveSegmentPrompt).toHaveBeenCalledTimes(1);
	});

	it("keeps queued prompts when only the target structure changes", async () => {
		const first = deferred<number>();
		promptApi.submitInteractiveSegmentPrompt
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(2);
		const { result, rerender } = renderHook(
			(props: { activeSegmentIndex: number }) => useInteractivePromptTool({
				enabled: true,
				mode: "point",
				apiBase: "http://api.test",
				caseId: "case-a",
				activeSegmentIndex: props.activeSegmentIndex,
				res: "low",
			}),
			{ initialProps: { activeSegmentIndex: 12 } },
		);

		act(() => result.current.handleClick("axial" as any)(clickEvent()));
		await act(async () => { await Promise.resolve(); await Promise.resolve(); });
		rerender({ activeSegmentIndex: 13 });
		act(() => result.current.handleClick("axial" as any)(clickEvent()));
		await act(async () => { first.resolve(0); await first.promise; await Promise.resolve(); await Promise.resolve(); });
		expect(promptApi.submitInteractiveSegmentPrompt).toHaveBeenCalledTimes(2);
		expect(promptApi.submitInteractiveSegmentPrompt.mock.calls[1][2]).toBe(13);
	});
});
