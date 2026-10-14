import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LandingPage from "../routes/LandingPage";

// Signed in, so the hero asks /api/search for the live CT-volume total.
const serve = (total: number) => {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.includes("/api/auth/me")
      ? { user: { id: "u1", email: "ada@example.com", roles: [] } }
      : u.includes("/api/search") ? { items: [], total, ids: [] } : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
};

const renderHero = () => {
  // Final figures at once, so the test reads them without the count-up.
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  return render(<AuthProvider><MemoryRouter><LandingPage /></MemoryRouter></AuthProvider>);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("landing hero CT-volume figure", () => {
  it("shows the live total once it arrives", async () => {
    serve(12_345);
    renderHero();
    expect(await screen.findByText("12,345")).toBeInTheDocument();
  });

  it("keeps the fallback figure when the server's catalog is empty", async () => {
    serve(0);
    renderHero();
    await vi.waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes("/api/search"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("34,323")).toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});
