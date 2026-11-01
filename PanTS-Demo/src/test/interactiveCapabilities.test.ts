import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

describe("model capabilities", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("offers every model tool until the server says otherwise", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		for (const id of ["pointSegment", "boxSegment", "scribbleSegment", "lassoSegment", "refineSegment", "paint"]) {
			expect(mod.modelToolOffered(id, null)).toBe(true);
		}
	});

	it("hides exactly the tools the loaded checkpoint can't serve", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			available: true,
			license: "CC BY-NC-SA 4.0",
			interactions: { point: true, box: true, scribble: false, lasso: null },
			refine: false,
			undo: true,
		}))));
		mod.primeInteractiveLicense("http://api.test");
		await waitFor(() => expect(mod.interactiveCapabilities()).not.toBeNull());

		const caps = mod.interactiveCapabilities();
		expect(mod.modelToolOffered("pointSegment", caps)).toBe(true);
		expect(mod.modelToolOffered("boxSegment", caps)).toBe(true);
		expect(mod.modelToolOffered("scribbleSegment", caps)).toBe(false);
		expect(mod.modelToolOffered("lassoSegment", caps)).toBe(true); // not reported, so kept
		expect(mod.modelToolOffered("refineSegment", caps)).toBe(false);
		expect(mod.modelToolOffered("paint", caps)).toBe(true);
	});

	it("keeps every tool when the model server is down", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			available: false, license: null, interactions: null, refine: null, undo: null,
		}))));
		mod.primeInteractiveLicense("http://api.test");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mod.interactiveCapabilities()).toBeNull();
	});
});
