import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSegmentationMetadata, parseSavedStructures, rememberSavedRevision, savedRevision, structureMetadataHeader } from "./segmentationMetadata";

afterEach(() => vi.unstubAllGlobals());
describe("saved segmentation metadata", () => {
  it("encodes international names in a byte-safe HTTP header", () => {
    const value = { 80: { name: "肝臓", color: [0, 10, 20, 255] as [number, number, number, number] } };
    const header = structureMetadataHeader(value);
    expect([...header].every(ch => ch.charCodeAt(0) < 127)).toBe(true);
    expect(JSON.parse(header)).toEqual(value);
  });
  it("loads custom names and colours with the revision for conflict detection", async () => {
    const structures = { 80: { name: "Target", color: [12, 34, 56, 255] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ custom_structures: structures, revision: "v1" }))));
    expect(await loadSegmentationMetadata("/test", 35, new AbortController().signal)).toEqual(structures);
    expect(savedRevision("/test", 35)).toBe("v1");
    rememberSavedRevision("/test", 35, "v2");
    expect(savedRevision("/test", 35)).toBe("v2");
    expect(savedRevision("/test", 36)).toBeUndefined();
  });
  it("does not retain a previous revision when reopening fails", async () => {
    rememberSavedRevision("/test", 35, "old");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(loadSegmentationMetadata("/test", 35, new AbortController().signal)).rejects.toThrow("Could not load");
    expect(savedRevision("/test", 35)).toBeUndefined();
  });
  it("keeps delayed saves from another account out of the current account revision", () => {
    rememberSavedRevision("/test", 35, "new-account-version", "B");
    rememberSavedRevision("/test", 35, "late-old-account-version", "A");
    expect(savedRevision("/test", 35, "B")).toBe("new-account-version");
    expect(savedRevision("/test", 35, "A")).toBe("late-old-account-version");
  });
  it.each([
    { 256: { name: "Overflow", color: [0, 0, 0, 255] } },
    { 80: { name: "", color: [0, 0, 0, 255] } },
    { 80: { name: "Invalid", color: [0, 0, 999, 255] } },
  ])("rejects invalid stored metadata", value => expect(() => parseSavedStructures(value)).toThrow());
});
