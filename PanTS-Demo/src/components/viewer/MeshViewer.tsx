import { Bounds, OrbitControls, useBounds, useGLTF } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { registerMeshRoot } from "../../helpers/viewer/meshCapture";
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box3, Vector3 } from "three";
import { APP_CONSTANTS } from "../../helpers/constants";
import { cornerstoneLpsMmToThree, type Vec3 } from "../../helpers/utils";
import type { MeshManifest } from "../../types";
import { OrganMesh } from "./OrganMesh";
import { SceneCrosshair3D } from "./SceneCrosshair3D";
import type { Color } from "@cornerstonejs/core/types";
import { LiveSegmentMesh } from "./LiveSegmentMesh";
import type { CheckBoxData } from "../../types";
import ErrorBoundary from "../ErrorBoundary";
import "./MeshViewer.css";

type MeshLoadState = "queued" | "loading" | "loaded" | "failed";
const MAX_CONCURRENT_MESH_LOADS = 2;

function admitQueuedMeshes(states: Record<number, MeshLoadState>, organIds: number[]) {
  const next = { ...states };
  let slots = MAX_CONCURRENT_MESH_LOADS - Object.values(next).filter((state) => state === "loading").length;
  for (const id of organIds) {
    if (slots <= 0) break;
    if (next[id] === "queued") { next[id] = "loading"; slots -= 1; }
  }
  return next;
}

// A failed organ must not unmount the other meshes or the camera controls.
class OrganLoadBoundary extends Component<{
  id: number;
  onFailed: (id: number) => void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.props.onFailed(this.props.id); }

  render() { return this.state.failed ? null : this.props.children; }
}

function InitialMeshBounds({ bounds, loadedCount }: {
  bounds: MeshManifest["bounds"];
  loadedCount: number;
}) {
  const api = useBounds();
  const controls = useThree((state) => state.controls);
  const framed = useRef(false);
  useEffect(() => {
    if (!controls || framed.current) return;
    const validBounds = bounds && [bounds.min, bounds.max].every((point) =>
      Array.isArray(point) && point.length === 3 && point.every(Number.isFinite),
    ) && bounds.min.every((value, axis) => value < bounds.max[axis]);
    if (!validBounds && loadedCount === 0) return;
    // Manifest bounds use the same centered Three.js space as the GLBs. Fit
    // once, without waiting for all requests or resetting a user's camera on retry.
    api.refresh(validBounds
      ? new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max))
      : undefined).clip().fit();
    framed.current = true;
  }, [api, bounds, controls, loadedCount]);
  return null;
}

type SegmentationMeshViewerProps = {
  caseId: string;
  loading: boolean
  checkState: boolean[];
  opacity: number;
  crosshairMm: Vec3 | null
  customOrgans?: CheckBoxData[];
  labelColorMap?: { [key: number]: Color };
  // Uploaded scans have no pre-baked meshes; fetch from the session route, which
  // builds them on demand from the session's combined_labels.
  isSession?: boolean;
};

export async function fetchMeshManifest(caseId: string, isSession = false): Promise<MeshManifest> {
  const base = isSession
    ? `${APP_CONSTANTS.API_ORIGIN}/api/sessions/${caseId}/mesh-manifest`
    : `${APP_CONSTANTS.API_ORIGIN}/api/cases/${caseId}/mesh-manifest`;
  const res = await fetch(base);
  if (!res.ok) throw new Error(`Failed to fetch mesh manifest: ${res.status}`);
  const data = await res.json() as Partial<MeshManifest>;
  if (!Array.isArray(data.organs) || !Array.isArray(data.center)) {
    throw new Error("Mesh manifest response is invalid");
  }
  return data as MeshManifest;
}

export function SegmentationMeshViewer(props: SegmentationMeshViewerProps) {
  // A case switch disposes its statuses, error boundaries, and pending callbacks.
  return <CaseMeshViewer key={`${props.isSession ? "session" : "case"}:${props.caseId}`} {...props} />;
}

function CaseMeshViewer({ caseId, checkState, loading, opacity, crosshairMm, customOrgans = [], labelColorMap = {}, isSession = false}: SegmentationMeshViewerProps) {
  const [manifest, setManifest] = useState<MeshManifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [meshStates, setMeshStates] = useState<Record<number, MeshLoadState>>({});
  const [meshAttempts, setMeshAttempts] = useState<Record<number, number>>({});
  const organIds = useRef<number[]>([]);

  // Drop the renderer handle when this pane goes away, so a capture can never
  // reach into a disposed WebGL context.
  useEffect(() => () => registerMeshRoot(null), []);

  const crosshairPosition = useMemo(() => {
    if (!manifest || !crosshairMm) return null;
    return cornerstoneLpsMmToThree(crosshairMm, manifest.center);
  }, [manifest, crosshairMm]);

  useEffect(() => {
    let alive = true;
    setManifest(null);
    setManifestError(false);
    setMeshStates({});
    setMeshAttempts({});
    organIds.current = [];
    fetchMeshManifest(caseId, isSession)
      .then((data) => {
        if (!alive) return;
        organIds.current = data.organs.map((organ) => organ.id);
        setMeshStates(admitQueuedMeshes(Object.fromEntries(organIds.current.map((id) => [id, "queued"])), organIds.current));
        setManifest(data);
      })
      .catch(() => { if (alive) setManifestError(true); });
    return () => { alive = false; };
  }, [caseId, isSession, manifestAttempt]);

  const organs = useMemo(() => manifest?.organs ?? [], [manifest]);
  const loadedCount = organs.filter((organ) => meshStates[organ.id] === "loaded").length;
  const failedOrgans = organs.filter((organ) => meshStates[organ.id] === "failed");
  const loadingCount = organs.filter((organ) => meshStates[organ.id] === "loading").length;
  const queuedCount = organs.filter((organ) => meshStates[organ.id] === "queued").length;
  const onLoaded = useCallback((id: number) => {
    setMeshStates((states) => states[id] !== "loading" ? states
      : admitQueuedMeshes({ ...states, [id]: "loaded" }, organIds.current));
  }, []);
  const onFailed = useCallback((id: number) => {
    setMeshStates((states) => states[id] !== "loading" ? states
      : admitQueuedMeshes({ ...states, [id]: "failed" }, organIds.current));
  }, []);
  const retryFailed = () => {
    // useGLTF also caches rejected requests. Clear only those entries, leaving
    // successful scenes and their materials mounted.
    for (const organ of failedOrgans) useGLTF.clear(organ.url);
    setMeshStates((states) => {
      const next = { ...states };
      for (const organ of failedOrgans) next[organ.id] = "queued";
      return admitQueuedMeshes(next, organIds.current);
    });
    setMeshAttempts((attempts) => {
      const next = { ...attempts };
      for (const organ of failedOrgans) next[organ.id] = (next[organ.id] ?? 0) + 1;
      return next;
    });
  };

  if (manifestError) return <div className="mesh-viewer-error" role="alert">
    <span>3D segmentation unavailable.</span>
    <button type="button" onClick={() => setManifestAttempt((attempt) => attempt + 1)}>Retry 3D meshes</button>
  </div>;
  if (!manifest || loading || !checkState || checkState.length === 0) {
    return <div>Loading 3D segmentation...</div>;
  }
  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {/*
          preserveDrawingBuffer is REQUIRED for the AI assistant's snapshots.
          WebGL clears the drawing buffer as soon as the frame is composited, so
          without it canvas.toDataURL() reads an already-cleared buffer and the
          captured "3D view" is a black rectangle. data-bodymaps-3d marks the
          canvas so the capture helper picks this one and never an unrelated
          canvas that happens to sit in the same pane.
        */}
        <ErrorBoundary fallback={<div className="vp-3d-empty">3D segmentation unavailable.</div>}>
        <Canvas
          camera={{ position: [0, 250, 650], fov: 45, near: 0.1, far: 5000 }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          frameloop="always"
          onCreated={(state) => {
            registerMeshRoot(state);
            state.gl.domElement.setAttribute("data-bodymaps-3d", "1");
          }}
        >
          <color attach="background" args={["#050505"]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[300, 500, 300]} intensity={1.2} />
            <Bounds margin={1.2}>
              <InitialMeshBounds bounds={manifest.bounds} loadedCount={loadedCount} />
              <group>
                {organs.map((organ) => {
                  // Admit only two network loads at a time. Completed meshes
                  // stay mounted, and retries wait without displacing active loads.
                  if (meshStates[organ.id] === "queued") return null;
                  // Always render the pre-baked GLB, even after this organ
                  // has been edited. Switching to a live marching-cubes
                  // mesh (LiveSegmentMesh) the instant an edit lands was
                  // both expensive (isosurface extraction on the stroke
                  // that triggers the switch — visible as a lag spike
                  // right on the first brush stroke) and unnecessary: the
                  // 3D pane is meant to show the original mesh, not a
                  // live reconstruction of in-progress annotations, so
                  // there's nothing gained by ever recomputing it here.
                  // Custom classes (no baked GLB to fall back to) still go
                  // through LiveSegmentMesh below, since that's the only
                  // way they can be shown in 3D at all.
                  return (
                    <OrganLoadBoundary key={`${organ.id}:${meshAttempts[organ.id] ?? 0}`} id={organ.id} onFailed={onFailed}>
                      <Suspense fallback={null}>
                        <OrganMesh
                          organ={organ}
                          visible={!!checkState[organ.id]}
                          opacity={opacity/100}
                          color={labelColorMap[organ.id]}
                          onLoaded={onLoaded}
                        />
                      </Suspense>
                    </OrganLoadBoundary>
                  );
                })}
                {customOrgans.map((organ) => (
                  <LiveSegmentMesh
                    key={organ.id}
                    segmentIndex={organ.id}
                    color={labelColorMap[organ.id] ?? [255, 255, 255, 255]}
                    visible={!!checkState[organ.id]}
                    opacity={opacity / 100}
                    manifestCenter={manifest.center as [number, number, number]}
                  />
                ))}
              </group>
            </Bounds>
            {crosshairPosition && manifest.bounds && (
              <SceneCrosshair3D position={crosshairPosition} bounds={manifest.bounds} />
            )}
          <OrbitControls makeDefault />
        </Canvas>
        <div className="mesh-viewer-status">
          <span role="status" aria-live="polite">
            {organs.length === 0 ? "No 3D meshes available." : `${loadedCount} of ${organs.length} meshes loaded.`}
            {loadingCount > 0 && ` ${loadingCount} loading.`}
            {queuedCount > 0 && ` ${queuedCount} queued.`}
            {failedOrgans.length > 0 && ` ${failedOrgans.length} unavailable.`}
          </span>
          {failedOrgans.length > 0 && <button type="button" onClick={retryFailed}>Retry failed meshes</button>}
        </div>
        </ErrorBoundary>
      </main>
    </div>
  );
}
