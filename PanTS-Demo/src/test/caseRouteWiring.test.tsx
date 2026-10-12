import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// App imports its router from "react-router" while the rest of the app uses "react-router-dom"; the test
// environment loads those as two separate copies (their contexts do not match), so point one at the other.
vi.mock("react-router", async () => await import("react-router-dom"));

// The viewer is heavy and irrelevant here: stand in a stub that shows which case the URL asks for.
vi.mock("../routes/VisualizationPage", async () => {
  const { useParams } = await import("react-router-dom");
  const ViewerStub = () => <div data-testid="viewer">{useParams().caseId}</div>;
  return { default: ViewerStub };
});

import App from "../App";

beforeEach(() => {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith("/api/auth/me")
      ? { user: { id: "case-route-reader", email: "reader@example.com", roles: [] } }
      : { items: [], total: 0, ids: [] },
    text: async () => "",
    headers: { get: () => "application/json" },
  })) as unknown as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

// App wraps the /case/:caseId route in CaseRoute; without it a number above 9,901 would reach the
// viewer as a PanTS id that does not exist.
describe("App /case route", () => {
  it("sends /case/9902 to the first CancerVerse case, keeping the query string", async () => {
    window.history.pushState({}, "", "/case/9902?mode=3d#slice=4");
    render(<App />);
    expect((await screen.findByTestId("viewer")).textContent).toBe("CV_00000001");
    await waitFor(() => expect(window.location.pathname + window.location.search + window.location.hash).toBe("/case/CV_00000001?mode=3d#slice=4"));
  });

  it("opens a PanTS number as it is", async () => {
    window.history.pushState({}, "", "/case/17");
    render(<App />);
    expect((await screen.findByTestId("viewer")).textContent).toBe("17");
    expect(window.location.pathname).toBe("/case/17");
  });
});
