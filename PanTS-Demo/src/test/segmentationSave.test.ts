import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSegmentationSave } from "../helpers/viewer/useSegmentationSave";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("segmentation save feedback", () => {
	it("reports failure and allows a successful retry", async () => {
		const operation = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
		const { result } = renderHook(() => useSegmentationSave("case-1", operation));
		await act(async () => { expect(await result.current.save()).toBe(false); });
		expect(result.current.state.status).toBe("error");
		await act(async () => { expect(await result.current.save()).toBe(true); });
		expect(result.current.state.status).toBe("saved");
	});

	it("deduplicates simultaneous saves and keeps later edits unsaved", async () => {
		const request = deferred();
		const operation = vi.fn(() => request.promise);
		const { result } = renderHook(() => useSegmentationSave("case-1", operation));
		let first!: Promise<boolean>;
		await act(async () => {
			first = result.current.save();
			expect(result.current.save()).toBe(first);
			result.current.markEdited();
			await Promise.resolve();
		});
		expect(operation).toHaveBeenCalledOnce();
		expect(result.current.state.status).toBe("saving");
		await act(async () => { request.resolve(); await first; });
		expect(result.current.state.status).toBe("dirty");
	});

	it("does not show a previous case's delayed save result in the next case", async () => {
		const request = deferred();
		const { result, rerender } = renderHook(({ resourceKey }) => useSegmentationSave(resourceKey, () => request.promise), {
			initialProps: { resourceKey: "case-1" },
		});
		let pending!: Promise<boolean>;
		act(() => { pending = result.current.save(); });
		rerender({ resourceKey: "case-2" });
		expect(result.current.state.status).toBe("idle");
		await act(async () => { request.resolve(); await pending; });
		expect(result.current.state.status).toBe("idle");
	});
});
