import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShowcaseCaseRoute from "../routes/ShowcaseCaseRoute";
import { showcaseRouteId } from "../helpers/useShowcaseAccess";

const state = vi.hoisted(() => ({ authenticated: false, cached: true, fail: false }));
const items = [{ case_id: "PanTS_00000035", dataset: "PanTS" }];
vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ isAuthenticated: state.authenticated, loading: false }) }));
vi.mock("../helpers/curatedCache", () => ({
  getCachedCurated: () => state.cached ? items : null,
  fetchCurated: async () => { if (state.fail) throw new Error("offline"); return items; },
}));

function harness(path = "/dashboard") {
  render(<MemoryRouter initialEntries={[path]}>
    <Link to="/case/35">showcase card</Link><Link to="/case/36">other card</Link>
    <Routes><Route path="/dashboard" element={<div>Dataset</div>} />
      <Route path="/case/:caseId" element={<ShowcaseCaseRoute><div>CT viewer</div></ShowcaseCaseRoute>} />
    </Routes>
  </MemoryRouter>);
}
beforeEach(() => { state.authenticated = false; state.cached = true; state.fail = false; });

describe("showcase case admission", () => {
  it("guest clicking a showcase card opens viewer; another card still needs sign-in", async () => {
    harness();const user=userEvent.setup();
    await user.click(screen.getByRole("link", { name: "showcase card" }));
    expect(screen.getByText("CT viewer")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "other card" }));
    expect(screen.queryByText("CT viewer")).not.toBeInTheDocument();
    expect(screen.getByText("Sign in to continue to BodyMaps.")).toBeInTheDocument();
  });
  it("supports a direct link before the cache arrives", async () => {
    state.cached=false;harness('/case/35');
    await waitFor(() => expect(screen.getByText('CT viewer')).toBeInTheDocument());
  });
  it("fails closed when showcase fetch fails", async () => {
    state.cached=false;state.fail=true;harness('/case/35');
    await waitFor(() => expect(screen.getByText('Sign in to continue to BodyMaps.')).toBeInTheDocument());
    expect(screen.queryByText('CT viewer')).not.toBeInTheDocument();
  });
  it("does not restrict signed-in viewing", () => {
    state.authenticated=true;harness('/case/36');
    expect(screen.getByText('CT viewer')).toBeInTheDocument();
  });
  it("rejects odd IDs and other datasets without consulting search", () => {
    for(const path of ['/case/USER_35','/case/CV_00000035','/case/BDMAP_00000035','/case/35,36','/case/../35'])
      expect(showcaseRouteId(path)).toBeNull();
    expect(showcaseRouteId('/case/PanTS_00000035')).toBe(35);
  });
});
