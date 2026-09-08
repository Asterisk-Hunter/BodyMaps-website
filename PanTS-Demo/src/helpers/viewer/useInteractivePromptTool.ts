// helpers/viewer/useInteractivePromptTool.ts
// Supports point / box / lasso / scribble prompts. Point = click, box = drag, lasso = freehand closed loop, scribble = freehand stroke.
// Lasso/scribble masks are cropped via interaction_bbox, resampled nearest on server.
import { useCallback, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	submitInteractiveSegmentPrompt,
	buildLassoCroppedMask,
	buildScribbleCroppedMask,
	type CinePane,
} from "../CornerstoneNifti2";
type Point3 = [number, number, number];

export type PromptMode = "point" | "box" | "lasso" | "scribble";

interface UseInteractivePromptToolArgs {
	enabled: boolean;
	mode: PromptMode;
	apiBase: string;
	caseId: string | number | null;
	activeSegmentIndex: number | null;
	res: "low" | "full";
	tolerance?: number;
	includeInteraction?: boolean;
	onLog?: (detail: string) => void;
	onBusyChange?: (busy: boolean) => void;
	onComplete?: () => void;
}

export function useInteractivePromptTool({
	enabled, mode, apiBase, caseId, activeSegmentIndex, res, tolerance, includeInteraction = true, onLog, onBusyChange, onComplete,
}: UseInteractivePromptToolArgs) {
	const [dragStartCanvas, setDragStartCanvas] = useState<[number, number] | null>(null);
	const [dragStartWorld, setDragStartWorld] = useState<Point3 | null>(null);
	const [liveBoxCanvas, setLiveBoxCanvas] = useState<[[number, number], [number, number]] | null>(null);
	const [freehandWorld, setFreehandWorld] = useState<Point3[]>([]);
	const [isDrawing, setIsDrawing] = useState(false);
	const paneRef = useRef<CinePane | null>(null);
	const busyRef = useRef(false);
	const [status, setStatus] = useState<"idle" | "applying" | "success" | "error">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		setFreehandWorld([]);
		setIsDrawing(false);
		paneRef.current = null;
	}, []);

	const submit = useCallback(async (_pane: CinePane, pointWorld: Point3 | undefined, boxWorld?: [Point3, Point3], lasso?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }, scribble?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }) => {
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
		try {
			const payload: any = {};
			if (pointWorld) payload.pointLps = pointWorld;
			if (boxWorld) payload.boxLps = boxWorld;
			if (tolerance != null) payload.tolerance = tolerance;
			if (includeInteraction === false) payload.includeInteraction = false;
			if (lasso) { payload.lassoMask = lasso.mask; payload.lassoBbox = lasso.bbox; }
			if (scribble) { payload.scribbleMask = scribble.mask; payload.scribbleBbox = scribble.bbox; }
			// For lasso/scribble, pointLps is still required as seed fallback; use first freehand point
			if (!payload.pointLps && lasso) payload.pointLps = freehandWorld[0] ?? pointWorld;
			if (!payload.pointLps && scribble) payload.pointLps = freehandWorld[0] ?? pointWorld;
			const changed = await submitInteractiveSegmentPrompt(apiBase, caseId, activeSegmentIndex, payload, res, activeSegmentIndex);
			if (changed) {
				const msg = `Interactive segment (${changed.toLocaleString()} vox)`;
				onLog?.(msg);
				setStatus("success");
				setStatusMessage("Operation completed successfully");
				onComplete?.();
			} else {
				const msg = "Interactive segment: nothing grew from that point — try a different spot.";
				onLog?.(msg);
				setStatus("error");
				setStatusMessage(msg);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Interactive segmentation failed.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, includeInteraction, onLog, onBusyChange, onComplete, freehandWorld]);

	const dismissStatus = useCallback(() => { setStatus("idle"); setStatusMessage(null); }, []);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		if (mode === "point") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			void submit(pane, world);
		} else if (mode === "lasso" || mode === "scribble") {
			// single click without drag still submits as point-like lasso/scribble of radius 1
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			const built = mode === "lasso" ? buildLassoCroppedMask(pane, [world, [world[0]+0.1, world[1], world[2]] as Point3, [world[0], world[1]+0.1, world[2]] as Point3]) : buildScribbleCroppedMask(pane, [world]);
			if (built) void submit(pane, world, undefined, mode === "lasso" ? built : undefined, mode === "scribble" ? built : undefined);
		}
	};

	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		if (mode === "box") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			// Prevent Cornerstone pan from firing simultaneously
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
			// Prevent Cornerstone pan from firing simultaneously
			e.preventDefault();
			e.stopPropagation();
			paneRef.current = pane;
			setIsDrawing(true);
			setFreehandWorld([world]);
		}
	};

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
			reset();
			if (!endWorld) return;
			const dx = Math.abs(canvasPos[0] - (startCanvas?.[0] ?? 0));
			const dy = Math.abs(canvasPos[1] - (startCanvas?.[1] ?? 0));
			if (dx < 4 && dy < 4) void submit(pane, startWorld);
			else void submit(pane, undefined, [startWorld, endWorld]);
			return;
		}
		if ((mode === "lasso" || mode === "scribble") && isDrawing && paneRef.current === pane) {
			const worldPoints = [...freehandWorld];
			const paneSnapshot = paneRef.current;
			// capture extra point at release
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const endWorld = canvasPointToWorld(pane, canvasPos);
			if (endWorld) worldPoints.push(endWorld);
			reset();
			if (worldPoints.length < 2) return;
			const built = mode === "lasso" ? buildLassoCroppedMask(paneSnapshot!, worldPoints) : buildScribbleCroppedMask(paneSnapshot!, worldPoints);
			if (!built) { onLog?.("Interactive segment: draw a larger shape."); return; }
			const seed = worldPoints[Math.floor(worldPoints.length / 2)];
			if (mode === "lasso") void submit(paneSnapshot!, seed, undefined, built, undefined);
			else void submit(paneSnapshot!, seed, undefined, undefined, built);
		}
	};

	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	void worldToCanvasPoint;

	return {
		pane,
		liveBox: liveBoxDisplay,
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
	};
}
