import { useState, useCallback, useRef, useEffect, type MouseEvent } from "react";
type Point3 = [number, number, number];
import { canvasPointToWorld, worldToVisiblePaneCanvas, buildLassoCroppedMask, buildScribbleCroppedMask, submitInteractiveSegmentPrompt, snapWorldToVoxelGrid, getVoxelCanvasDelta, type CinePane } from "../CornerstoneNifti2";

const HOOK_INTERACTIVE_TIMEOUT_MS = 60000;
function _isAbortErrorHook(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError" || (e as any)?.name === "AbortError";
}
function _classifyHookError(err: unknown, status?: number): string {
  if (_isAbortErrorHook(err)) return "Request timed out. Check your connection and try again.";
  if (status === 429) return "Server is busy (too many requests). Please wait a moment and try again.";
  if (status != null && status >= 500) return `Server error (${status}). Please try again later.`;
  if (status === 413) return "Request too large. Try a smaller box or lasso.";
  if (err instanceof TypeError) {
    const msg = String((err as Error).message || "");
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("fetch")) return "Network error: could not reach the segmentation server. Check your connection and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Interactive segmentation failed. Please try again.";
}

export type InteractivePromptToolMode = "point" | "box" | "lasso" | "scribble";

export type InteractivePromptToolProps = {
	enabled: boolean;
	mode: InteractivePromptToolMode;
	apiBase: string;
	caseId: string | number | null;
	activeSegmentIndex: number | null;
	res: "low" | "full";
	tolerance?: number;
	includeInteraction?: boolean;
	onLog?: (msg: string) => void;
	onBusyChange?: (busy: boolean) => void;
	onComplete?: () => void;
};

export function useInteractivePromptTool({
	enabled,
	mode,
	apiBase,
	caseId,
	activeSegmentIndex,
	res,
	tolerance,
	includeInteraction,
	onLog,
	onBusyChange,
	onComplete,
}: InteractivePromptToolProps) {
	const [dragStartCanvas, setDragStartCanvas] = useState<[number, number] | null>(null);
	const [dragStartWorld, setDragStartWorld] = useState<Point3 | null>(null);
	const [liveBoxCanvas, setLiveBoxCanvas] = useState<[[number, number], [number, number]] | null>(null);

	const [isDrawing, setIsDrawing] = useState(false);
	const [freehandWorld, setFreehandWorld] = useState<Point3[]>([]);

	const paneRef = useRef<CinePane | null>(null);
	const busyRef = useRef(false);
	const abortRef = useRef<AbortController | null>(null);
	const hookQueueRef = useRef<Promise<void>>(Promise.resolve());
	function _enqueueHook<T>(task: () => Promise<T>): Promise<T> {
		const result = hookQueueRef.current.then(task, task);
		hookQueueRef.current = result.then(() => undefined, () => undefined);
		return result;
	}
	useEffect(() => () => { abortRef.current?.abort(); }, []);
	
	const [status, setStatus] = useState<"idle" | "confirming" | "applying" | "success" | "error">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	
	const [pendingSubmit, setPendingSubmit] = useState<any>(null);

	// Confirm-state pointer gesture guard (box resize/move, lasso translate).
	// A ref rather than state: the window-level gesture listeners below read it
	// on every frame without re-binding, and reset() can cancel an in-flight
	// gesture (e.g. Esc mid-resize) so it stops writing tool state.
	const gestureActiveRef = useRef(false);

	// TASK-001 (pointer capture robustness): track the element/pointer that
	// currently holds a capture for an active prompt-tool gesture, so onEnd
	// can release it explicitly on pointerup/pointercancel and a second
	// gesture cannot steal an in-flight capture.
	const capturedElRef = useRef<HTMLElement | null>(null);
	const capturedPointerIdRef = useRef<number | null>(null);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		setFreehandWorld([]);
		setIsDrawing(false);
		paneRef.current = null;
		setPendingSubmit(null);
		setStatus("idle");
		gestureActiveRef.current = false;
	}, []);

	const executeSubmit = useCallback(async (_pane: CinePane, payload: any) => {
		return _enqueueHook(async () => {
		if (busyRef.current) return;
		if (activeSegmentIndex == null) {
			alert("Please select a target segment in the UI before drawing/clicking.");
			onLog?.("Interactive segment: no target segment selected.");
			return;
		}
		if (caseId == null) {
			alert("No case loaded.");
			onLog?.("Interactive segment: no case loaded.");
			return;
		}
		busyRef.current = true;
		onBusyChange?.(true);
		setStatus("applying");
		setStatusMessage(null);
		const controller = new AbortController();
		abortRef.current = controller;
		const tid = setTimeout(() => controller.abort(), HOOK_INTERACTIVE_TIMEOUT_MS);
		// Race the inner queue (Cornerstone handles its own AbortController/timeout), but hook timeout still surfaces actionable error if hung.
		const timeoutPromise = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new DOMException("Request timed out", "AbortError")), { once: true });
		});
		try {
			if (tolerance != null) payload.tolerance = tolerance;
			if (payload.includeInteraction === undefined && includeInteraction === false) payload.includeInteraction = false;
			
			const changed = await Promise.race([
				submitInteractiveSegmentPrompt(apiBase, caseId, activeSegmentIndex, payload, res, activeSegmentIndex),
				timeoutPromise
			]);
			if (controller.signal.aborted) throw new DOMException("Request timed out", "AbortError");
			if (changed) {
				const msg = `Interactive segment (${(changed as number).toLocaleString()} vox)`;
				onLog?.(msg);
				setStatus("success");
				setStatusMessage("Operation completed successfully");
				onComplete?.();
			} else {
				const msg = "Interactive segment: nothing grew from that point - try a different spot.";
				onLog?.(msg);
				setStatus("error");
				setStatusMessage(msg);
			}
			reset();
		} catch (e) {
			const status = (e as any)?.status as number | undefined;
			const msg = _classifyHookError(e, status);
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			clearTimeout(tid);
			if (abortRef.current === controller) abortRef.current = null;
			busyRef.current = false;
			onBusyChange?.(false);
		}
		});
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, includeInteraction, onLog, onBusyChange, onComplete, reset]);

	const submit = useCallback(async (pane: CinePane, pointWorld: Point3 | undefined, boxWorld?: [Point3, Point3], lasso?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }, scribble?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }, invertPolarity: boolean = false) => {
		const payload: any = {};
		const finalPolarity = invertPolarity ? !includeInteraction : includeInteraction;
		payload.includeInteraction = finalPolarity !== false;
		if (pointWorld) payload.pointLps = pointWorld;
		if (boxWorld) payload.boxLps = boxWorld;
		if (lasso) { payload.lassoMask = lasso.mask; payload.lassoBbox = lasso.bbox; }
		if (scribble) { payload.scribbleMask = scribble.mask; payload.scribbleBbox = scribble.bbox; }
		if (!payload.pointLps && lasso) payload.pointLps = freehandWorld[0] ?? pointWorld;
		if (!payload.pointLps && scribble) payload.pointLps = freehandWorld[0] ?? pointWorld;
		
		if (mode === "box" || mode === "lasso" || mode === "scribble") {
			setPendingSubmit({ pane, payload });
			setStatus("confirming");
		} else {
			void executeSubmit(pane, payload);
		}
	}, [mode, freehandWorld, executeSubmit]);

	const confirm = useCallback(() => {
		if (status === "confirming" && pendingSubmit) {
			const { pane, payload } = pendingSubmit;
			
			if (mode === "box" && liveBoxCanvas) {
				const worldStart = canvasPointToWorld(pane, liveBoxCanvas[0]);
				const worldEnd = canvasPointToWorld(pane, liveBoxCanvas[1]);
				if (worldStart && worldEnd) {
					payload.boxLps = [worldStart, worldEnd];
				}
			}
			if ((mode === "lasso" || mode === "scribble") && freehandWorld.length >= 2) {
				const built = mode === "lasso" ? buildLassoCroppedMask(pane, freehandWorld) : buildScribbleCroppedMask(pane, freehandWorld);
				if (built) {
					if (mode === "lasso") {
						payload.lassoMask = built.mask;
						payload.lassoBbox = built.bbox;
					} else {
						payload.scribbleMask = built.mask;
						payload.scribbleBbox = built.bbox;
					}
				}
			}
			
			void executeSubmit(pane, payload);
		}
	}, [status, pendingSubmit, executeSubmit, mode, liveBoxCanvas, freehandWorld]);

	const dismissStatus = useCallback(() => { setStatus("idle"); setStatusMessage(null); }, []);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		if (status === "confirming") return;
		if (mode === "point") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			void submit(pane, world, undefined, undefined, undefined, e.altKey);
		} else if (mode === "lasso" || mode === "scribble") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			const built = mode === "lasso" ? buildLassoCroppedMask(pane, [world, [world[0]+0.1, world[1], world[2]] as Point3, [world[0], world[1]+0.1, world[2]] as Point3]) : buildScribbleCroppedMask(pane, [world]);
			if (built) void submit(pane, world, undefined, mode === "lasso" ? built : undefined, mode === "scribble" ? built : undefined, e.altKey);
		}
	};

	// ---- Confirm-state editing gestures (Fix B) ----
	// Pointer capture + window listeners: the drag keeps working when the
	// cursor leaves the pane (or the window) and ends reliably anywhere — the
	// old React onMouseMove wiring dropped the gesture at the pane edge and
	// left handles "stuck". Geometry is computed from the gesture-start
	// snapshot (no compounding drift), clamped to the pane, voxel-snapped so
	// the visual box matches the voxel bbox the backend receives, and applied
	// once per animation frame (rAF batching — the classic laggy-resize fix).

	// The pane div (.vp-pane--<name>) is the coordinate space all canvas
	// coords in this hook are relative to; overlays are full-size siblings.
	const _paneRectFor = (pane: CinePane): DOMRect | null => {
		const el = document.querySelector(`.vp-pane--${pane}`) as HTMLElement | null;
		return el ? el.getBoundingClientRect() : null;
	};

	// Canvas point -> world -> snapped to the voxel grid (in-plane axes) ->
	// back to canvas. Falls back to the input when no CT volume is loaded.
	const _snapCanvasPoint = (pane: CinePane, p: [number, number]): [number, number] => {
		const world = canvasPointToWorld(pane, p);
		if (!world) return p;
		const snapped = snapWorldToVoxelGrid(pane, world);
		if (!snapped) return p;
		return worldToVisiblePaneCanvas(pane, snapped) ?? p;
	};

	const startResize = (handle: "tl" | "tr" | "t" | "l" | "bl" | "br" | "b" | "r" | "move", e: any) => {
		e.preventDefault();
		e.stopPropagation();
		if (gestureActiveRef.current) return;
		if (!liveBoxCanvas || !paneRef.current) return;
		const pane = paneRef.current;
		const rect = _paneRectFor(pane);
		if (!rect) return;
		gestureActiveRef.current = true;
		const MIN = 4; // px — matches the click-vs-drag threshold
		// Normalized start geometry (start/end corners are not ordered).
		const s0 = liveBoxCanvas[0], s1 = liveBoxCanvas[1];
		const startX0 = Math.min(s0[0], s1[0]), startY0 = Math.min(s0[1], s1[1]);
		const startX1 = Math.max(s0[0], s1[0]), startY1 = Math.max(s0[1], s1[1]);
		const startW = startX1 - startX0, startH = startY1 - startY0;
		const grabOffset: [number, number] = [(e.clientX - rect.left) - startX0, (e.clientY - rect.top) - startY0];
		let latest: { clientX: number; clientY: number } | null = null;
		let rafId: number | null = null;
		let alive = true;
		const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

		const applyFrame = () => {
			rafId = null;
			if (!alive || !gestureActiveRef.current || !latest) return;
			const px = clamp(latest.clientX - rect.left, 0, rect.width);
			const py = clamp(latest.clientY - rect.top, 0, rect.height);
			let x0 = startX0, y0 = startY0, x1 = startX1, y1 = startY1;
			if (handle === "move") {
				// Translate, voxel-snapped on the min corner, clamped in-pane.
				const snapped = _snapCanvasPoint(pane, [px - grabOffset[0], py - grabOffset[1]]);
				x0 = clamp(snapped[0], 0, Math.max(0, rect.width - startW));
				y0 = clamp(snapped[1], 0, Math.max(0, rect.height - startH));
				x1 = x0 + startW;
				y1 = y0 + startH;
			} else {
				// Anchored resize: corners anchor the opposite corner, mid-edge
				// handles the opposite edge (single-axis); min size enforced.
				const [sx, sy] = _snapCanvasPoint(pane, [px, py]);
				if (handle.includes("l")) x0 = clamp(Math.min(sx, startX1 - MIN), 0, rect.width);
				if (handle.includes("r")) x1 = clamp(Math.max(sx, startX0 + MIN), 0, rect.width);
				if (handle.includes("t")) y0 = clamp(Math.min(sy, startY1 - MIN), 0, rect.height);
				if (handle.includes("b")) y1 = clamp(Math.max(sy, startY0 + MIN), 0, rect.height);
			}
			setLiveBoxCanvas([[x0, y0], [x1, y1]] as [[number, number], [number, number]]);
		};
		const onMove = (ev: PointerEvent) => {
			latest = ev;
			if (rafId == null) rafId = requestAnimationFrame(applyFrame);
		};
		const onEnd = () => {
			if (!alive) return; // idempotent: a stray second end event must not undo cleanup
			alive = false;
			gestureActiveRef.current = false;
			if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			// Release the pointer capture taken on pointerdown (TASK-001). Without
			// this the browser keeps the handle as the capturing target until
			// pointerup fires there natively, and a capture left dangling after a
			// pointercancel swallows the next gesture's events.
			try {
				const el = capturedElRef.current;
				const pid = capturedPointerIdRef.current;
				if (el && pid != null && el.hasPointerCapture?.(pid)) el.releasePointerCapture(pid);
			} catch { /* capture already gone */ }
			capturedElRef.current = null;
			capturedPointerIdRef.current = null;
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
		// Capture the pointer on the handle: the gesture keeps receiving
		// events outside the pane and even outside the window. Also guard
		// against a second pointer (e.g. a touch landing mid-drag) stealing
		// the capture. Capture is released in onEnd (above).
		if (capturedElRef.current && capturedElRef.current !== (e.currentTarget as HTMLElement)) {
			// Another gesture still holds a capture — bail instead of stealing it.
			alive = false;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			gestureActiveRef.current = false;
			return;
		}
		try {
			capturedElRef.current = e.currentTarget as HTMLElement;
			capturedPointerIdRef.current = e.pointerId;
			(e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
		} catch { /* optional */ }
	};

	const startLassoResize = (handle: "move", e: any) => {
		e.preventDefault();
		e.stopPropagation();
		// Shape-warping axis-scale resize removed (Fix B): an outline scaled
		// on its axes produces anatomically nonsensical shapes. Translate via
		// the move handle only; redraw for shape changes.
		if (handle !== "move") return;
		if (gestureActiveRef.current) return;
		if (freehandWorld.length === 0 || !paneRef.current) return;
		const pane = paneRef.current;
		const rect = _paneRectFor(pane);
		if (!rect) return;
		const pts2d = freehandWorld.map(w => worldToVisiblePaneCanvas(pane, w)).filter(Boolean) as [number, number][];
		if (pts2d.length === 0) return;
		gestureActiveRef.current = true;
		const minX = Math.min(...pts2d.map(p => p[0]));
		const minY = Math.min(...pts2d.map(p => p[1]));
		const grabOffset: [number, number] = [(e.clientX - rect.left) - minX, (e.clientY - rect.top) - minY];
		let latest: { clientX: number; clientY: number } | null = null;
		let rafId: number | null = null;
		let alive = true;

		const applyFrame = () => {
			rafId = null;
			if (!alive || !gestureActiveRef.current || !latest) return;
			const dx = (latest.clientX - rect.left - grabOffset[0]) - minX;
			const dy = (latest.clientY - rect.top - grabOffset[1]) - minY;
			const newWorld = pts2d
				.map(p => canvasPointToWorld(pane, [p[0] + dx, p[1] + dy]))
				.filter(Boolean) as Point3[];
			// Only commit a fully-converted polygon (drop nothing mid-shape).
			if (newWorld.length === pts2d.length) setFreehandWorld(newWorld);
		};
		const onMove = (ev: PointerEvent) => {
			latest = ev;
			if (rafId == null) rafId = requestAnimationFrame(applyFrame);
		};
		const onEnd = () => {
			if (!alive) return; // idempotent: a stray second end event must not undo cleanup
			alive = false;
			gestureActiveRef.current = false;
			if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			// Release the pointer capture taken on pointerdown (TASK-001) —
			// same rationale as the box gesture above.
			try {
				const el = capturedElRef.current;
				const pid = capturedPointerIdRef.current;
				if (el && pid != null && el.hasPointerCapture?.(pid)) el.releasePointerCapture(pid);
			} catch { /* capture already gone */ }
			capturedElRef.current = null;
			capturedPointerIdRef.current = null;
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
		// Shared refs: one active prompt gesture (box or lasso) at a time.
		if (capturedElRef.current && capturedElRef.current !== (e.currentTarget as HTMLElement)) {
			alive = false;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			gestureActiveRef.current = false;
			return;
		}
		try {
			capturedElRef.current = e.currentTarget as HTMLElement;
			capturedPointerIdRef.current = e.pointerId;
			(e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
		} catch { /* optional */ }
	};

	// Arrow-key nudge while a box is in the confirming state (Fix B):
	// 1 voxel per keypress, Shift = 5. Consumes the event so the page never
	// scrolls mid-adjustment, and yields to focused form controls (the W/L
	// slider etc. also use arrow keys).
	useEffect(() => {
		if (status !== "confirming" || mode !== "box" || !liveBoxCanvas) return;
		const pane = paneRef.current;
		if (!pane) return;
		const onKey = (e: KeyboardEvent) => {
			const ae = document.activeElement as HTMLElement | null;
			if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
			const dir = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
			if (!dir) return;
			const anchorWorld = canvasPointToWorld(pane, liveBoxCanvas[0]);
			if (!anchorWorld) return;
			const step = getVoxelCanvasDelta(pane, anchorWorld);
			if (!step) return;
			const n = e.shiftKey ? 5 : 1;
			const dx = dir[0] * step[0] * n;
			const dy = dir[1] * step[1] * n;
			e.preventDefault();
			e.stopPropagation();
			setLiveBoxCanvas((prev) => {
				if (!prev) return prev;
				const el = document.querySelector(`.vp-pane--${pane}`) as HTMLElement | null;
				const paneW = el?.clientWidth ?? Number.POSITIVE_INFINITY;
				const paneH = el?.clientHeight ?? Number.POSITIVE_INFINITY;
				const bw = Math.abs(prev[1][0] - prev[0][0]);
				const bh = Math.abs(prev[1][1] - prev[0][1]);
				const nx = Math.min(Math.max(Math.min(prev[0][0], prev[1][0]) + dx, 0), Math.max(0, paneW - bw));
				const ny = Math.min(Math.max(Math.min(prev[0][1], prev[1][1]) + dy, 0), Math.max(0, paneH - bh));
				return [[nx, ny], [nx + bw, ny + bh]] as [[number, number], [number, number]];
			});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [status, mode, liveBoxCanvas]);

	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		
		if (status === "confirming") {
			reset();
			return;
		}

		if (mode === "box") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			e.preventDefault();
			e.stopPropagation();
			paneRef.current = pane;
			setDragStartCanvas(canvasPos);
			setDragStartWorld(world);
			setLiveBoxCanvas([canvasPos, canvasPos]);
			return;
		}
		if (mode === "lasso" || mode === "scribble") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			e.preventDefault();
			e.stopPropagation();
			paneRef.current = pane;
			setIsDrawing(true);
			setFreehandWorld([world]);
		}
	};

	// Confirm-state resize/move no longer flows through here: gestures are
	// window-level (pointer capture) started by startResize/startLassoResize,
	// so the gesture cannot be dropped at the pane boundary. This handler is
	// only the create-time drag/draw.
	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;

		if (mode === "box" && paneRef.current === pane && dragStartCanvas) {
			e.preventDefault();
			e.stopPropagation();
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			setLiveBoxCanvas([dragStartCanvas, canvasPos]);
			return;
		}
		if ((mode === "lasso" || mode === "scribble") && isDrawing && paneRef.current === pane) {
			e.preventDefault();
			e.stopPropagation();
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			setFreehandWorld((prev) => [...prev, world]);
		}
	};

	const handleMouseUp = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;

		if (mode === "box" && paneRef.current === pane && dragStartWorld) {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const endWorld = canvasPointToWorld(pane, canvasPos);
			const startWorld = dragStartWorld;
			const startCanvas = dragStartCanvas;
			
			setDragStartCanvas(null);
			setDragStartWorld(null);
			setIsDrawing(false);
			
			if (!endWorld) return;
			const dx = Math.abs(canvasPos[0] - (startCanvas?.[0] ?? 0));
			const dy = Math.abs(canvasPos[1] - (startCanvas?.[1] ?? 0));
			if (dx < 4 && dy < 4) void submit(pane, startWorld, undefined, undefined, undefined, e.altKey);
			else void submit(pane, undefined, [startWorld, endWorld], undefined, undefined, e.altKey);
			return;
		}
		if ((mode === "lasso" || mode === "scribble") && isDrawing && paneRef.current === pane) {
			const worldPoints = [...freehandWorld];
			const paneSnapshot = paneRef.current;
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const endWorld = canvasPointToWorld(pane, canvasPos);
			if (endWorld) worldPoints.push(endWorld);
			
			setIsDrawing(false);
			
			if (worldPoints.length < 2) return;
			const built = mode === "lasso" ? buildLassoCroppedMask(paneSnapshot!, worldPoints) : buildScribbleCroppedMask(paneSnapshot!, worldPoints);
			if (!built) { onLog?.("Interactive segment: draw a larger shape."); return; }
			const seed = worldPoints[Math.floor(worldPoints.length / 2)];
			if (mode === "lasso") void submit(paneSnapshot!, seed, undefined, built, undefined, e.altKey);
			else void submit(paneSnapshot!, seed, undefined, undefined, built, e.altKey);
		}
	};

	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	

	return {
		pane,
		liveBox: liveBoxDisplay,
		/** World-coordinate anchor of the in-progress box drag (start corner).
		 *  Used by the confirm bar's voxel-span readout. */
		dragStartWorld,
		freehand: freehandWorld,
		status,
		statusMessage,
		dismissStatus,
		handleClick,
		handleMouseDown,
		handleMouseMove,
		handleMouseUp,
		cancel: reset,
		reset,
		confirm,
		startResize,
		startLassoResize
	};
}
