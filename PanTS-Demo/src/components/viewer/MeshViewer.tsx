import { Bounds, OrbitControls, useBounds, useGLTF } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { registerMeshRoot } from "../../helpers/viewer/meshCapture";
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box3, Vector3, type EventDispatcher, type Group, type Object3D } from "three";
import { APP_CONSTANTS } from "../../helpers/constants";
import { cornerstoneLpsMmToThree, type Vec3 } from "../../helpers/utils";
import type { MeshManifest } from "../../types";
import { OrganMesh } from "./OrganMesh";
import { SceneCrosshair3D } from "./SceneCrosshair3D";
import type { Color } from "@cornerstonejs/core/types";
import { LiveSegmentMesh } from "./LiveSegmentMesh";
import type { CheckBoxData } from "../../types";
import ErrorBoundary from "../ErrorBoundary";
import { prefersReducedMotion } from "../../helpers/motion";
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
  // Catalog classes edited on this page. One the scan has no baked mesh for gets a
  // live mesh, the way a custom class does; one with a baked mesh keeps it.
  editedOrgans?: CheckBoxData[];
  labelColorMap?: { [key: number]: Color };
  // Uploaded scans have no pre-baked meshes; fetch from the session route, which
  // builds them on demand from the session's combined_labels.
  isSession?: boolean;
  // Refit the camera to the organs that are shown whenever that set changes. The
  // initial fit is to the whole scan, hidden organs included, which leaves a
  // single isolated organ small and off centre. The report walkthrough turns
  // this on while it highlights one organ at a time.
  fitVisible?: boolean;
};

// The manifest's box, the one InitialMeshBounds frames first, or null when an older
// manifest has none (or a malformed one). Refits that are not about the shown organs
// return to it, so the camera keeps the framing the pane opened with.
function manifestBox(bounds: MeshManifest["bounds"] | undefined): Box3 | null {
  const valid = bounds && [bounds.min, bounds.max].every((point) =>
    Array.isArray(point) && point.length === 3 && point.every(Number.isFinite),
  ) && bounds.min.every((value, axis) => value < bounds.max[axis]);
  return valid ? new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max)) : null;
}

// The box of the group's shown children, or an empty box when none is shown.
function shownBox(group: Group): Box3 {
  const box = new Box3();
  for (const child of group.children) {
    if (child.visible) box.expandByObject(child);
  }
  return box;
}

// Refits the camera to the shown organs (see fitVisible). Lives inside <Bounds>
// for its api. `signature` names the shown set, so the fit reruns when it changes.
// It also reruns when the canvas resizes, so the shown organs are refitted rather
// than the whole scene.
export function RefitToVisibleOrgans({ groupRef, signature }: { groupRef: RefObject<Group | null>; signature: string }) {
  const bounds = useBounds();
  const size = useThree((state) => state.size);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const box = shownBox(group);
    if (box.isEmpty()) return;
    bounds.refresh(box).clip().fit();
  }, [bounds, groupRef, signature, size]);
  return null;
}

// Refits to the pane's opening framing (homeBox, or the whole scene without one) when
// fitVisible turns off. RefitToVisibleOrgans unmounts with it, and nothing else refits on
// a change of the shown set, so a camera left on the last isolated organ would stay on
// that close-up after the report closes. The canvas box does not change when the 3D-only
// layout stays put, so the resize refit does not cover this. The camera cannot be orbited
// while the report is open, so the refit is unconditional.
export function RefitWhenFitVisibleEnds({ fitVisible, homeBox = null }: { fitVisible: boolean; homeBox?: Box3 | null }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const wasFitVisible = useRef(fitVisible);
  useEffect(() => {
    const ended = wasFitVisible.current && !fitVisible;
    wasFitVisible.current = fitVisible;
    if (ended && bounds) (homeBox ? bounds.refresh(homeBox) : bounds.refresh()).clip().fit();
  }, [bounds, fitVisible, homeBox]);
  return null;
}

// Whether the user has moved the camera (orbit, zoom or pan) and whether a gesture is in
// progress, for refits that must leave a camera the user placed where it is.
function useUserCameraMoves() {
  const controls = useThree((state) => state.controls) as EventDispatcher | null | undefined;
  const orbited = useRef(false);
  const gesture = useRef(false);
  useEffect(() => {
    if (!controls?.addEventListener) return;
    // A press or a wheel tick fires "start" even when the camera never moves, so the camera counts
    // as moved by the user only if it differs from where it was when the gesture began. While a
    // gesture is in progress no refit runs either.
    const view = controls as unknown as { object?: Object3D; target?: Vector3 };
    let before: { position: Vector3; target: Vector3 } | null = null;
    const onStart = () => {
      gesture.current = true;
      before = view.object && view.target ? { position: view.object.position.clone(), target: view.target.clone() } : null;
    };
    const onEnd = () => {
      gesture.current = false;
      const moved = !before || !view.object || !view.target
        || before.position.distanceTo(view.object.position) > 1e-3
        || before.target.distanceTo(view.target) > 1e-3;
      if (moved) orbited.current = true;
    };
    controls.addEventListener("start" as never, onStart);
    controls.addEventListener("end" as never, onEnd);
    return () => {
      gesture.current = false;
      controls.removeEventListener?.("start" as never, onStart);
      controls.removeEventListener?.("end" as never, onEnd);
    };
  }, [controls]);
  return { orbited, gesture };
}

// Refits the camera whenever the canvas box changes size, in every view mode. The
// pane changes size with layout changes (grid spans, the docks, the AI sidebar), and
// the fit from the old size then leaves the organs tiny in a corner or cropped. The
// box is observed directly, so this does not depend on anything outside the pane
// dispatching a window resize. A short settle delay lets the layout finish first,
// and a camera the user has orbited, zoomed or panned is left where they put it
// (RefitWhenShownSetChanges keeps the same guard).
// `fitVisible` frames only the shown organs, for the report and for a scan with no
// baked meshes, whose hidden live classes would otherwise widen the fit. Otherwise the
// refit keeps the pane's opening framing (homeBox, or the whole scene without one).
export function RefitOnCanvasResize({ groupRef, fitVisible, homeBox = null }: { groupRef: RefObject<Group | null>; fitVisible: boolean; homeBox?: Box3 | null }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const gl = useThree((state) => state.gl) as { domElement?: HTMLCanvasElement } | undefined;
  const { orbited, gesture } = useUserCameraMoves();
  useEffect(() => {
    const host = gl?.domElement?.parentElement;
    if (!bounds || !host || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = host.clientWidth;
    let lastH = host.clientHeight;
    const refit = () => {
      if (orbited.current || gesture.current) return;
      const group = groupRef.current;
      let box: Box3 | null = null;
      if (fitVisible && group) {
        box = shownBox(group);
        if (box.isEmpty()) box = null;
      }
      (box ? bounds.refresh(box) : homeBox ? bounds.refresh(homeBox) : bounds.refresh()).clip().fit();
    };
    const observer = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (w === 0 || h === 0) return;
      clearTimeout(timer);
      timer = setTimeout(refit, 120);
    });
    observer.observe(host);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [bounds, gl, groupRef, fitVisible, homeBox, orbited, gesture]);
  return null;
}

// On a scan with no baked meshes the scene starts empty and fills up class by class, so the
// first fit frames only the first class. This refits to the shown classes whenever that set
// changes (a class gets its first voxels, or is shown or hidden), unless the user has moved the
// camera. Canvas resizes are left to RefitOnCanvasResize, which keeps the same guard, so a
// camera the user placed is never moved behind their back.
export function RefitWhenShownSetChanges({ groupRef, signature }: { groupRef: RefObject<Group | null>; signature: string }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const { orbited, gesture } = useUserCameraMoves();
  useEffect(() => {
    const group = groupRef.current;
    if (!bounds || !group || orbited.current || gesture.current) return;
    const box = shownBox(group);
    if (box.isEmpty()) return;
    bounds.refresh(box).clip().fit();
  }, [bounds, groupRef, signature, orbited, gesture]);
  return null;
}

type CrosshairBounds = { min: Vec3; max: Vec3 };

const sameBounds = (a: CrosshairBounds, b: CrosshairBounds) =>
  a.min.every((v, i) => Math.abs(v - b.min[i]) < 0.5) && a.max.every((v, i) => Math.abs(v - b.max[i]) < 0.5);

// How often the crosshair re-reads the shown organs' box, in ms.
const CROSSHAIR_BOUNDS_POLL_MS = 250;

// The crosshair spans the shown organs, so its lines end at the anatomy. The
// manifest bounds are the whole CT volume around a different centre than the
// meshes, so they run well past the organs and are only the fallback until a
// mesh has loaded. The box is read from the group a few times a second while the
// pane is on screen (meshes stream in, and visibility and edits change it), and
// state is set only when it moves.
function OrganCrosshair3D({ groupRef, position, fallback, active }: { groupRef: RefObject<Group | null>; position: Vec3; fallback: CrosshairBounds; active: boolean }) {
  const [bounds, setBounds] = useState<CrosshairBounds>(fallback);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const group = groupRef.current;
      if (!group) return;
      const box = shownBox(group);
      const next: CrosshairBounds = box.isEmpty()
        ? fallback
        : { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
      setBounds((prev) => (sameBounds(prev, next) ? prev : next));
    };
    read();
    const timer = window.setInterval(read, CROSSHAIR_BOUNDS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, fallback, groupRef]);
  return <SceneCrosshair3D position={position} bounds={bounds} />;
}

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

function CaseMeshViewer({ caseId, checkState, loading, opacity, crosshairMm, customOrgans = [], editedOrgans = [], labelColorMap = {}, isSession = false, fitVisible = false}: SegmentationMeshViewerProps) {
  const [manifest, setManifest] = useState<MeshManifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [meshStates, setMeshStates] = useState<Record<number, MeshLoadState>>({});
  const [meshAttempts, setMeshAttempts] = useState<Record<number, number>>({});
  const organIds = useRef<number[]>([]);
  // Set when something outside an organ boundary throws inside the Canvas (no WebGL context, a
  // marching-cubes failure), so the pane offers a retry instead of a dead end.
  const [canvasFailed, setCanvasFailed] = useState(false);
  // False while the pane is not on screen (a single 2D view hides it with display: none, and
  // the page keeps this component mounted). The render loop is stopped then, so the organs are
  // not redrawn every frame into a canvas nobody can see. A snapshot still renders on demand.
  const [onScreen, setOnScreen] = useState(true);

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
  // Everything drawn from the live labelmap: custom classes, plus edited catalog
  // classes that have no baked mesh here (an organ the dataset never labelled on
  // this scan, filled in with the model or the brush). Without this a catalog
  // class drawn from scratch never showed in 3D. A class with a baked mesh keeps it.
  const liveOrgans = useMemo(() => {
    if (editedOrgans.length === 0) return customOrgans;
    const baked = new Set(organs.map((o) => o.id));
    return [...editedOrgans.filter((o) => !baked.has(o.id)), ...customOrgans];
  }, [organs, editedOrgans, customOrgans]);
  const organGroupRef = useRef<Group>(null);
  const homeBox = useMemo(() => manifestBox(manifest?.bounds), [manifest]);
  // Live classes that have something to draw. A class joins the scene empty (a new
  // custom class) and gets its first voxels later, so the shown set below only counts
  // it from then, and a refit to the shown set frames it.
  const [livePresent, setLivePresent] = useState<Record<number, boolean>>({});
  const onLivePresence = useCallback((id: number, present: boolean) => {
    setLivePresent((prev) => (!!prev[id] === present ? prev : { ...prev, [id]: present }));
  }, []);
  // The shown set: loaded baked meshes and live classes with voxels, that are visible.
  const shownSignature = useMemo(
    () => [
      ...organs.filter((o) => meshStates[o.id] === "loaded").map((o) => o.id),
      ...liveOrgans.filter((o) => livePresent[o.id]).map((o) => o.id),
    ].filter((id) => checkState?.[id]).join(","),
    [organs, meshStates, liveOrgans, livePresent, checkState]
  );

  // A retry is pressed with the keyboard, and the button it was on goes away (the
  // pane swaps to the loading message, the canvas takes the alert's place, or the
  // last failed mesh is queued again). Whichever block is showing takes focus, once
  // each time the pane changes what it shows or a retry starts, until the user moves
  // on or the retry lands on the alert again.
  const paneRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const paneKind = manifestError || canvasFailed ? "alert" : !manifest || loading || !checkState || checkState.length === 0 ? "loading" : "host";
  useEffect(() => {
    if (!refocus.current) return;
    const el = paneRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Focus was moved somewhere else on purpose, so leave it there.
    if (active && active !== document.body && active.isConnected && !el.contains(active)) {
      refocus.current = false;
      return;
    }
    // Already on the pane or on a button inside it.
    if (active && el.contains(active)) return;
    el.focus({ preventScroll: true });
    if (paneKind === "alert") refocus.current = false;
  }, [paneKind, manifestAttempt, meshAttempts]);
  useEffect(() => {
    // A click or tab to anything else, or a press on the canvas, hands focus back to the user.
    const release = (e: Event) => {
      if (e.type === "focusin" && paneRef.current?.contains(e.target as Node)) return;
      refocus.current = false;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release, true);
    return () => {
      document.removeEventListener("focusin", release);
      document.removeEventListener("pointerdown", release, true);
    };
  }, []);

  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneKind]);

  const retryFailed = () => {
    refocus.current = true;
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

  // Read on each render, so a change of the system setting applies without a reload.
  const reduceMotion = prefersReducedMotion();

  if (manifestError || canvasFailed) return <div className="mesh-viewer-error" role="alert" ref={paneRef} tabIndex={-1} style={{ outline: "none" }}>
    <span>3D segmentation unavailable.</span>
    <button type="button" onClick={() => {
      refocus.current = true;
      // A failed canvas mounts a fresh one; a failed manifest is fetched again.
      if (canvasFailed) setCanvasFailed(false);
      else setManifestAttempt((attempt) => attempt + 1);
    }}>Retry 3D meshes</button>
  </div>;
  if (!manifest || loading || !checkState || checkState.length === 0) {
    return <div className="vp-3d-empty" role="status" ref={paneRef} tabIndex={-1} style={{ outline: "none" }}>Loading 3D segmentation...</div>;
  }
  return (
    <div ref={paneRef} tabIndex={-1} style={{ display: "flex", width: "100%", height: "100%", outline: "none" }}>
      <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {/*
          preserveDrawingBuffer is REQUIRED for the AI assistant's snapshots.
          WebGL clears the drawing buffer as soon as the frame is composited, so
          without it canvas.toDataURL() reads an already-cleared buffer and the
          captured "3D view" is a black rectangle. data-bodymaps-3d marks the
          canvas so the capture helper picks this one and never an unrelated
          canvas that happens to sit in the same pane.
        */}
        <ErrorBoundary fallback={null} onError={() => setCanvasFailed(true)}>
        <Canvas
          camera={{ position: [0, 250, 650], fov: 45, near: 0.1, far: 5000 }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          frameloop={onScreen ? "always" : "never"}
          resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
          onCreated={(state) => {
            registerMeshRoot(state);
            state.gl.domElement.setAttribute("data-bodymaps-3d", "1");
            state.gl.domElement.setAttribute("role", "img");
            state.gl.domElement.setAttribute("aria-label", "3D view of the segmented organs. Drag to rotate, scroll to zoom.");
          }}
        >
          <color attach="background" args={["#000"]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[300, 500, 300]} intensity={1.2} />
            <Bounds margin={1.2} maxDuration={reduceMotion ? 0.01 : 1}>
              <InitialMeshBounds bounds={manifest.bounds} loadedCount={loadedCount} />
              <group ref={organGroupRef}>
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
                {liveOrgans.map((organ) => (
                  <LiveSegmentMesh
                    key={organ.id}
                    segmentIndex={organ.id}
                    color={labelColorMap[organ.id] ?? [255, 255, 255, 255]}
                    visible={!!checkState[organ.id]}
                    opacity={opacity / 100}
                    manifestCenter={manifest.center as [number, number, number]}
                    onPresenceChange={onLivePresence}
                  />
                ))}
              </group>
              {fitVisible && <RefitToVisibleOrgans groupRef={organGroupRef} signature={shownSignature} />}
              {/* A scan with no baked meshes fills up class by class, so its camera follows the
                  shown classes until the user moves it, and a resize frames them too. */}
              {!fitVisible && organs.length === 0 && <RefitWhenShownSetChanges groupRef={organGroupRef} signature={shownSignature} />}
              <RefitWhenFitVisibleEnds fitVisible={fitVisible} homeBox={homeBox} />
              <RefitOnCanvasResize groupRef={organGroupRef} fitVisible={fitVisible || organs.length === 0} homeBox={homeBox} />
            </Bounds>
            {crosshairPosition && manifest.bounds && (
              <OrganCrosshair3D groupRef={organGroupRef} position={crosshairPosition} fallback={manifest.bounds} active={onScreen} />
            )}
          <OrbitControls makeDefault enableDamping={!reduceMotion} />
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
