import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshManifest } from "../types";

const mocks = vi.hoisted(() => {
  const bounds = { refresh: vi.fn(), clip: vi.fn(), fit: vi.fn() };
  bounds.refresh.mockReturnValue(bounds);
  bounds.clip.mockReturnValue(bounds);
  const controls = {};
  return {
    bounds, controls,
    resources: new Map<string, { state: "ready" | "pending" | "failed"; promise?: Promise<void>; requested?: boolean }>(),
    requests: vi.fn(), mounts: vi.fn(), unmounts: vi.fn(), clear: vi.fn(),
  };
});

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="mesh-canvas">{children}</div>,
  useThree: (selector: (state: { controls: object }) => unknown) => selector({ controls: mocks.controls }),
}));
vi.mock("@react-three/drei", () => ({
  Bounds: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OrbitControls: () => <span data-testid="orbit-controls" />,
  useBounds: () => mocks.bounds,
  useGLTF: Object.assign(vi.fn(), { clear: mocks.clear }),
}));
vi.mock("../helpers/constants", () => ({ APP_CONSTANTS: { API_ORIGIN: "" } }));
vi.mock("../helpers/utils", () => ({ cornerstoneLpsMmToThree: (position: number[]) => position }));
vi.mock("../helpers/viewer/meshCapture", () => ({ registerMeshRoot: vi.fn() }));
vi.mock("../components/viewer/LiveSegmentMesh", () => ({ LiveSegmentMesh: () => null }));
vi.mock("../components/viewer/SceneCrosshair3D", () => ({ SceneCrosshair3D: () => <span data-testid="crosshair" /> }));
vi.mock("../components/viewer/OrganMesh", async () => {
  const { useEffect } = await import("react");
  return { OrganMesh: ({ organ, visible, onLoaded }: {
    organ: { id: number; url: string }; visible: boolean; onLoaded: (id: number) => void;
  }) => {
    const resource = mocks.resources.get(organ.url);
    if (resource && !resource.requested) { resource.requested = true; mocks.requests(organ.url); }
    if (resource?.state === "failed") throw new Error("Network mesh failure");
    if (resource?.state === "pending") throw resource.promise;
    useEffect(() => {
      mocks.mounts(organ.url);
      onLoaded(organ.id);
      return () => mocks.unmounts(organ.url);
    }, [organ.id, organ.url, onLoaded]);
    return <span data-testid={`mesh-${organ.id}`} data-visible={visible}>{organ.url}</span>;
  } };
});

import { SegmentationMeshViewer } from "../components/viewer/MeshViewer";

const manifest = (caseId = "one", count = 3): MeshManifest => ({
  caseId, center: [0, 0, 0], bounds: { min: [-100, -150, -200], max: [100, 150, 200] },
  organs: Array.from({ length: count }, (_, index) => ({
    id: index + 1, key: `organ${index + 1}`, name: `Organ ${index + 1}`, color: "#ffffff",
    url: `/api/cases/${caseId}/render_only/organ${index + 1}.glb`, vertices: 10, faces: 8,
  })),
});
const props = { caseId: "one", loading: false, checkState: [false, true, true, true], opacity: 50, crosshairMm: [0, 0, 0] as [number, number, number] };
const response = (data: MeshManifest) => ({ ok: true, json: async () => data }) as Response;

beforeEach(() => {
  mocks.resources.clear();
  mocks.requests.mockClear(); mocks.mounts.mockClear(); mocks.unmounts.mockClear(); mocks.clear.mockReset();
  mocks.bounds.refresh.mockClear(); mocks.bounds.clip.mockClear(); mocks.bounds.fit.mockClear();
  // React deliberately logs caught test errors and unknown Three.js elements in jsdom.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(manifest())));
  mocks.clear.mockImplementation((url: string) => mocks.resources.set(url, { state: "ready" }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("independent organ mesh loading", () => {
  it("starts at most two mesh loads and admits the next only after completion or failure", async () => {
    const data = manifest("one", 5);
    const resolves: (() => void)[] = [];
    for (const organ of data.organs) {
      const promise = new Promise<void>((resolve) => { resolves.push(resolve); });
      mocks.resources.set(organ.url, { state: "pending", promise });
    }
    vi.mocked(fetch).mockResolvedValue(response(data));
    render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 of 5 meshes loaded. 2 loading. 3 queued."));
    expect(mocks.requests.mock.calls.map(([url]) => url)).toEqual(data.organs.slice(0, 2).map((organ) => organ.url));
    await act(async () => {
      mocks.resources.get(data.organs[0].url)!.state = "ready";
      resolves[0]();
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 5 meshes loaded. 2 loading. 2 queued."));
    expect(mocks.requests).toHaveBeenCalledTimes(3);
    expect(mocks.requests).toHaveBeenLastCalledWith(data.organs[2].url);
    await act(async () => {
      mocks.resources.get(data.organs[1].url)!.state = "failed";
      resolves[1]();
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 5 meshes loaded. 2 loading. 1 queued. 1 unavailable."));
    expect(mocks.requests).toHaveBeenCalledTimes(4);
    expect(mocks.requests).toHaveBeenLastCalledWith(data.organs[3].url);
    expect(screen.getByTestId("mesh-1")).toBeVisible();
  });

  it("queues failed retries behind two active loads without restarting either one", async () => {
    const data = manifest();
    const resolves: (() => void)[] = [];
    for (const organ of data.organs) {
      const promise = new Promise<void>((resolve) => { resolves.push(resolve); });
      mocks.resources.set(organ.url, { state: organ.id === 1 ? "failed" : "pending", promise });
    }
    mocks.clear.mockImplementation((url: string) => {
      mocks.resources.set(url, { state: "pending", promise: new Promise(() => {}) });
    });
    render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 of 3 meshes loaded. 2 loading. 1 unavailable."));
    expect(mocks.requests).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Retry failed meshes" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 of 3 meshes loaded. 2 loading. 1 queued.");
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(data.organs[0].url);
    expect(mocks.requests).toHaveBeenCalledTimes(3);
    await act(async () => {
      mocks.resources.get(data.organs[1].url)!.state = "ready";
      resolves[1]();
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 3 meshes loaded. 2 loading."));
    expect(mocks.requests).toHaveBeenCalledTimes(4);
    expect(mocks.requests).toHaveBeenLastCalledWith(data.organs[0].url);
    expect(mocks.requests.mock.calls.filter(([url]) => url === data.organs[2].url)).toHaveLength(1);
  });

  it("keeps a successful organ and controls visible while another is pending and another fails", async () => {
    const data = manifest();
    let resolvePending!: () => void;
    const promise = new Promise<void>((resolve) => { resolvePending = resolve; });
    mocks.resources.set(data.organs[1].url, { state: "pending", promise });
    mocks.resources.set(data.organs[2].url, { state: "failed" });
    render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 3 meshes loaded. 1 loading. 1 unavailable."));
    expect(screen.getByTestId("mesh-1")).toBeVisible();
    expect(screen.getByTestId("orbit-controls")).toBeInTheDocument();
    expect(screen.getByTestId("crosshair")).toBeInTheDocument();
    expect(screen.queryByText("3D segmentation unavailable.")).not.toBeInTheDocument();
    expect(mocks.bounds.refresh.mock.calls[0][0].min.toArray()).toEqual(data.bounds.min);
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.resources.set(data.organs[1].url, { state: "ready" });
      resolvePending(); await promise;
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 of 3 meshes loaded. 1 unavailable."));
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(1);
  });

  it("retries only failed cached URLs without remounting successful meshes or reframing the camera", async () => {
    const data = manifest();
    mocks.resources.set(data.organs[1].url, { state: "failed" });
    const view = render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 of 3 meshes loaded. 1 unavailable."));
    fireEvent.click(screen.getByRole("button", { name: "Retry failed meshes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3 of 3 meshes loaded."));
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(data.organs[1].url);
    expect(mocks.mounts.mock.calls.filter(([url]) => url === data.organs[0].url)).toHaveLength(1);
    expect(mocks.unmounts).not.toHaveBeenCalled();
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry failed meshes" })).not.toBeInTheDocument();

    view.rerender(<SegmentationMeshViewer {...props} opacity={25} checkState={[false, false, true, true]} />);
    expect(screen.getByTestId("mesh-1")).toHaveAttribute("data-visible", "false");
    expect(mocks.mounts).toHaveBeenCalledTimes(3);
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(1);
  });

  it("reports zero loaded when every request fails and permits a real retry", async () => {
    for (const organ of manifest().organs) mocks.resources.set(organ.url, { state: "failed" });
    render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 of 3 meshes loaded. 3 unavailable."));
    expect(screen.getByTestId("mesh-canvas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed meshes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3 of 3 meshes loaded."));
    expect(mocks.clear).toHaveBeenCalledTimes(3);
  });

  it("discards old mesh statuses and pending completion on a case switch", async () => {
    let resolveOld!: () => void;
    const promise = new Promise<void>((resolve) => { resolveOld = resolve; });
    const old = manifest("one", 1);
    mocks.resources.set(old.organs[0].url, { state: "pending", promise });
    vi.mocked(fetch).mockResolvedValueOnce(response(old)).mockResolvedValueOnce(response(manifest("two", 1)));
    const view = render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 of 1 meshes loaded. 1 loading."));
    view.rerender(<SegmentationMeshViewer {...props} caseId="two" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded."));
    await act(async () => {
      mocks.resources.set(old.organs[0].url, { state: "ready" });
      resolveOld(); await promise;
    });
    expect(screen.getByTestId("mesh-1")).toHaveTextContent("/api/cases/two/");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded.");
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(2);
  });

  it("ignores a late manifest from the previous case", async () => {
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
    vi.mocked(fetch).mockReturnValueOnce(old).mockResolvedValueOnce(response(manifest("two", 1)));
    const view = render(<SegmentationMeshViewer {...props} />);
    view.rerender(<SegmentationMeshViewer {...props} caseId="two" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded."));
    await act(async () => { resolveOld(response(manifest())); await old; });
    expect(screen.getByTestId("mesh-1")).toHaveTextContent("/api/cases/two/");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded.");
  });

  it("allows retry after a manifest transport failure", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(response(manifest("one", 1)));
    render(<SegmentationMeshViewer {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry 3D meshes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded."));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fits the first completed mesh once when an older manifest has no valid bounds", async () => {
    const data = manifest("one", 1);
    data.bounds = undefined as unknown as MeshManifest["bounds"];
    vi.mocked(fetch).mockResolvedValue(response(data));
    render(<SegmentationMeshViewer {...props} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 1 meshes loaded."));
    expect(mocks.bounds.refresh).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(mocks.bounds.fit).toHaveBeenCalledTimes(1);
  });
});
