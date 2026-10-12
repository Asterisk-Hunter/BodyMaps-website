import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "../routes/Homepage/hooks/useDashboard";

vi.mock("../helpers/prefetchViewer", () => ({ prefetchViewer: vi.fn() }));
vi.mock("../helpers/curatedCache", () => ({
  getCachedCurated: () => null,
  fetchCurated: async () => [{ case_id: "PanTS_00000035", sex: "F", age: 55, tumor: 0 }],
}));
vi.mock("../helpers/analytics", () => ({ track: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ case_id: "CV_00000012", sex: "M", age: 60, tumor: 1 }], total: 17, page: 1 }) }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dataset actions", () => {
  it.each(["handleBrowseAll", "handleShuffle"] as const)("%s returns from Saved to the fetched cases", async (action) => {
    const { result } = renderHook(useDashboard, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setShowSaved(true));
    expect(result.current.showSaved).toBe(true);
    await act(async () => { await result.current[action](); });
    expect(result.current.showSaved).toBe(false);
    expect(result.current.previewIds).toEqual(["CV_00000012"]);
    expect(result.current.error).toBeNull();
  });

  it("exposes a failed search and clears the error after a successful retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(useDashboard, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await act(async () => { result.current.handleBrowseAll(); });
    await waitFor(() => expect(result.current.error).toContain("search could not be completed"));
    expect(result.current.loading).toBe(false);
    await act(async () => { result.current.handleBrowseAll(); });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.previewIds).toEqual(["CV_00000012"]);
  });
});
