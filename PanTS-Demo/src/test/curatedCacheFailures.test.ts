import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const items = () => Array.from({ length: 8 }, (_, i) => ({
  case_id: `PanTS_${String(i + 1).padStart(8, "0")}`, dataset: "PanTS", sex: "F", age: 50, tumor: (i + 1) % 2,
}));
let reply: { ok: boolean; items: unknown[] };
beforeEach(() => {
  vi.resetModules(); reply = { ok: true, items: items() };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: reply.ok, json: async () => ({ items: reply.items }) })));
});
afterEach(() => vi.unstubAllGlobals());

describe("server-owned showcase cache", () => {
  it("fetches the exact server list once and retains its order", async () => {
    const { fetchCurated, getCachedCurated } = await import("../helpers/curatedCache");
    await expect(fetchCurated()).resolves.toEqual(reply.items);
    await expect(fetchCurated()).resolves.toEqual(reply.items);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/showcase"), { credentials: "include" });
    expect(getCachedCurated()).toEqual(reply.items);
  });
  it("does not poison the cache after an error, and allows a later retry", async () => {
    const { fetchCurated, getCachedCurated } = await import("../helpers/curatedCache");
    reply.ok = false;
    await expect(fetchCurated()).rejects.toThrow(); expect(getCachedCurated()).toBeNull();
    reply.ok = true;
    await expect(fetchCurated()).resolves.toHaveLength(8);
  });
  it.each([0, 4, 7, 9])("fails closed for an incomplete/non-eight strip (%s)", async (length) => {
    const { fetchCurated, getCachedCurated } = await import("../helpers/curatedCache");
    reply.items = Array.from({ length }, (_, i) => ({ case_id: i + 1, dataset: "PanTS" }));
    await expect(fetchCurated()).rejects.toThrow(); expect(getCachedCurated()).toBeNull();
  });
  it("rejects duplicate, user and non-PanTS cases", async () => {
    const { fetchCurated } = await import("../helpers/curatedCache");
    reply.items = Array(8).fill(items()[0]);
    await expect(fetchCurated()).rejects.toThrow();
    reply.items = items(); reply.items[0] = { case_id: "USER_12345678", dataset: "PanTS" };
    await expect(fetchCurated()).rejects.toThrow();
    reply.items = items(); reply.items[0] = { case_id: "CV_00000001", dataset: "CancerVerse" };
    await expect(fetchCurated()).rejects.toThrow();
  });
});
