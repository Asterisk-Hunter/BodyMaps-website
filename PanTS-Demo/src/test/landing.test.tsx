import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LandingPage from "../routes/LandingPage";
import { LANDING_OVERVIEW, LANDING_SUBTITLE } from "../helpers/copy";

// The landing page fetches the live CT count; stub it so the test never
// touches a backend (same shape as routes.smoke.test.tsx).
beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], total: 0, ids: [] }),
    text: async () => "",
    headers: { get: () => "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("landing hero copy", () => {
  it("shows the subtitle under the wordmark and the overview under the stats row", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const subtitle = screen.getByText(LANDING_SUBTITLE);
    expect(subtitle.previousElementSibling?.tagName).toBe("H1");
    const overview = screen.getByText(LANDING_OVERVIEW);
    // Directly after the stats row, not between subtitle and stats.
    expect(overview.previousElementSibling?.textContent).toContain("CT Volumes");
    expect(overview.nextElementSibling).toBeNull();
    // The nonclinical sentence lives in the footer, not in the paragraph.
    expect(overview.textContent).not.toMatch(/nonclinical|research use only/i);
  });

  it("keeps the existing hero mounted while collapsed and restores its accessible content", () => {
    const view = (collapsed: boolean) => <AuthProvider><MemoryRouter><LandingPage collapsed={collapsed} /></MemoryRouter></AuthProvider>;
    const { rerender } = render(view(false));
    const heading = screen.getByRole("heading", { name: "Body Maps" });
    rerender(view(true));
    expect(heading.isConnected).toBe(true);
    expect(screen.queryByRole("heading", { name: "Body Maps" })).not.toBeInTheDocument();
    rerender(view(false));
    expect(screen.getByRole("heading", { name: "Body Maps" })).toBe(heading);
  });

  it("shows final counts immediately when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    render(<AuthProvider><MemoryRouter><LandingPage /></MemoryRouter></AuthProvider>);
    expect(screen.getByText("34,323")).toBeInTheDocument();
    expect(screen.getByText("993K+")).toBeInTheDocument();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("stops a running count-up when reduced motion is enabled and cleans up its listener", () => {
    const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => preference));
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(77);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(<AuthProvider><MemoryRouter><LandingPage /></MemoryRouter></AuthProvider>);
    const onChange = preference.addEventListener.mock.calls[0][1];
    act(() => { preference.matches = true; onChange(); });
    expect(cancelFrame).toHaveBeenCalledWith(77);
    expect(screen.getByText("34,323")).toBeInTheDocument();
    expect(screen.getByText("993K+")).toBeInTheDocument();
    unmount();
    expect(preference.removeEventListener).toHaveBeenCalledWith("change", onChange);
  });
});
