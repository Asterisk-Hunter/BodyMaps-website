import { describe, expect, it, vi } from "vitest";
import { replaceVolumeTransaction } from "./replaceVolumeTransaction";

describe("HD labelmap replacement", () => {
  it("retains the old voxels when loading the replacement fails", async () => {
    const original = new Uint8Array([0, 80, 80]);
    const volumes = new Map([["old", original], ["new", new Uint8Array(3)]]);
    const activate = vi.fn();
    const restore = vi.fn();
    await expect(replaceVolumeTransaction({
      load: async () => { throw new Error("download failed"); }, activate, restore,
      retirePrevious: () => { volumes.delete("old"); },
      discardReplacement: () => { volumes.delete("new"); },
    })).rejects.toThrow("download failed");
    expect(volumes.get("old")).toBe(original);
    expect(volumes.has("new")).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
  it("reattaches the old mask before discarding a partly attached replacement", async () => {
    const order: string[] = [];
    await expect(replaceVolumeTransaction({
      load: async () => { order.push("load"); },
      activate: async () => { throw new Error("actor failed"); },
      restore: async () => { order.push("restore old"); },
      retirePrevious: () => { order.push("delete old"); },
      discardReplacement: () => { order.push("delete new"); },
    })).rejects.toThrow("actor failed");
    expect(order).toEqual(["load", "restore old", "delete new"]);
  });
  it("releases the previous mask only after successful attachment", async () => {
    const order: string[] = [];
    await replaceVolumeTransaction({
      load: async () => { order.push("load"); }, activate: async () => { order.push("attach"); },
      restore: vi.fn(), retirePrevious: () => { order.push("delete old"); }, discardReplacement: vi.fn(),
    });
    expect(order).toEqual(["load", "attach", "delete old"]);
  });
  it("keeps the replacement cache when restoration fails", async () => {
    const discard = vi.fn();
    await expect(replaceVolumeTransaction({
      load: async () => {}, activate: async () => { throw new Error("actor failed"); },
      restore: async () => { throw new Error("restore failed"); }, retirePrevious: vi.fn(), discardReplacement: discard,
    })).rejects.toThrow("restore failed");
    expect(discard).not.toHaveBeenCalled();
  });
});
