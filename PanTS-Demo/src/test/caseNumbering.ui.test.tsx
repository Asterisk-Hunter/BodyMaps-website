import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Preview from "../components/Preview";
import { AuthProvider } from "../contexts/authContext";
import { resetCancerVerseCountCache } from "../helpers/caseNumbering";
import CaseRoute from "../routes/CaseRoute";
import Homepage from "../routes/Homepage";

// One running number: 1-9,901 are PanTS and CancerVerse continues from 9,902. The ids the app
// uses ("17", "CV_00000001") are unchanged; these tests cover the three places a number is used.

beforeEach(() => {
  resetCancerVerseCountCache();
  global.fetch = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes("dataset=cancerverse") && String(url).includes("per_page=1")
        ? { items: [], total: 24422 }
        : { items: [], total: 0, ids: [] },
    text: async () => "",
    headers: { get: () => "application/json" },
  })) as unknown as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const Probe = () => {
  const { caseId } = useParams();
  const { search, hash } = useLocation();
  return <div data-testid="probe">{`${caseId}|${search}|${hash}`}</div>;
};

describe("search box", () => {
  const searchFor = async (value: string) => {
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes>
            <Route path="/dashboard" element={<Homepage />} />
            <Route path="/case/:caseId" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    const box = await screen.findByPlaceholderText(/Search by case number/);
    fireEvent.change(box, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    return screen.findByTestId("probe");
  };

  it("opens a PanTS case for 1-9,901 exactly as before", async () => {
    expect((await searchFor("17")).textContent).toBe("17||");
  });

  it("opens the first CancerVerse case for 9,902", async () => {
    expect((await searchFor("9902")).textContent).toBe("CV_00000001||");
  });

  it("opens the last CancerVerse case for 34,323", async () => {
    expect((await searchFor("34323")).textContent).toBe("CV_00024422||");
  });

  it("clamps a number past the end to the last case", async () => {
    expect((await searchFor("99999")).textContent).toBe("CV_00024422||");
  });
});

describe("/case/<number> links", () => {
  const open = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/case/:caseId"
            element={
              <CaseRoute>
                <Probe />
              </CaseRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

  it("redirects a number above PanTS' range to the CancerVerse case, keeping the share state", async () => {
    open("/case/9902?mode=3d#slice=4");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("CV_00000001|?mode=3d|#slice=4"));
  });

  it("leaves PanTS numbers and CancerVerse ids alone", () => {
    for (const url of ["/case/17", "/case/9901", "/case/CV_00000007"]) {
      const { unmount } = open(url);
      expect(screen.getByTestId("probe").textContent).toBe(`${url.split("/")[2]}||`);
      unmount();
    }
  });
});

describe("number on the library card", () => {
  const card = (id: number | string) =>
    render(
      <MemoryRouter>
        <Preview id={id} previewMetadata={{ sex: "M", age: 60, tumor: 0 }} />
      </MemoryRouter>,
    );

  it("shows the running number next to the id", () => {
    const pants = card(17);
    expect(screen.getByText("PanTS_00000017")).toBeTruthy();
    expect(screen.getByTestId("case-number").textContent).toBe("#17");
    pants.unmount();
    card("CV_00000001");
    expect(screen.getByText("CV_00000001")).toBeTruthy();
    expect(screen.getByTestId("case-number").textContent).toBe("#9,902");
  });
});
