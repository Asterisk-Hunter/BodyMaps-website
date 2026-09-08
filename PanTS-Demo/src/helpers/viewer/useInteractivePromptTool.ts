import { useState, useCallback, useRef, type MouseEvent } from "react";
type Point3 = [number, number, number];
import { canvasPointToWorld, worldToVisiblePaneCanvas, buildLassoCroppedMask, buildScribbleCroppedMask, submitInteractiveSegmentPrompt, type CinePane } from "../CornerstoneNifti2";

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
	
	const [status, setStatus] = useState<"idle" | "confirming" | "applying" | "success" | "error">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	
	const [pendingSubmit, setPendingSubmit] = useState<any>(null);

	const [resizeHandle, setResizeHandle] = useState<"tl" | "tr" | "bl" | "br" | "move" | null>(null);
	const [resizeOffset, setResizeOffset] = useState<[number, number] | null>(null);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		setFreehandWorld([]);
		setIsDrawing(false);
		paneRef.current = null;
		setPendingSubmit(null);
		setStatus("idle");
		setResizeHandle(null);
		setResizeOffset(null);
	}, []);

	const executeSubmit = useCallback(async (pane: CinePane, payload: any) => {
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
			if (tolerance != null) payload.tolerance = tolerance;
			if (includeInteraction === false) payload.includeInteraction = false;
			
			const changed = await submitInteractiveSegmentPrompt(apiBase, caseId, activeSegmentIndex, payload, res, activeSegmentIndex);
			if (changed) {
				const msg = `Interactive segment (${changed.toLocaleString()} vox)`;
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
			const msg = e instanceof Error ? e.message : "Interactive segmentation failed.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, includeInteraction, onLog, onBusyChange, onComplete, reset]);

	const submit = useCallback(async (pane: CinePane, pointWorld: Point3 | undefined, boxWorld?: [Point3, Point3], lasso?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }, scribble?: { mask: Uint8Array; bbox: [[number, number], [number, number], [number, number]] }) => {
		const payload: any = {};
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
			void submit(pane, world);
		} else if (mode === "lasso" || mode === "scribble") {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world) return;
			const built = mode === "lasso" ? buildLassoCroppedMask(pane, [world, [world[0]+0.1, world[1], world[2]] as Point3, [world[0], world[1]+0.1, world[2]] as Point3]) : buildScribbleCroppedMask(pane, [world]);
			if (built) void submit(pane, world, undefined, mode === "lasso" ? built : undefined, mode === "scribble" ? built : undefined);
		}
	};

	const startResize = (handle: "tl" | "tr" | "bl" | "br" | "move", e: any) => {
		e.preventDefault();
		e.stopPropagation();
		setResizeHandle(handle);
		if (handle === "move" && liveBoxCanvas) {
			const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
			setResizeOffset([e.clientX - rect.left, e.clientY - rect.top]);
		}
	};
	
	const startLassoResize = (handle: "tl" | "tr" | "bl" | "br" | "move", e: any) => {
		e.preventDefault();
		e.stopPropagation();
		setResizeHandle(handle);
		if (handle === "move" && freehandWorld.length > 0) {
			const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
			setResizeOffset([e.clientX - rect.left, e.clientY - rect.top]);
		}
	};

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

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		
		if (status === "confirming" && resizeHandle && paneRef.current === pane) {
			e.preventDefault();
			e.stopPropagation();
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			
			if (mode === "box" && liveBoxCanvas) {
				const newBox = [...liveBoxCanvas] as [[number, number], [number, number]];
				
				let minX = Math.min(newBox[0][0], newBox[1][0]);
				let minY = Math.min(newBox[0][1], newBox[1][1]);
				let maxX = Math.max(newBox[0][0], newBox[1][0]);
				let maxY = Math.max(newBox[0][1], newBox[1][1]);

				if (resizeHandle === "move" && resizeOffset) {
					const w = maxX - minX;
					const h = maxY - minY;
					minX = canvasPos[0] - resizeOffset[0];
					minY = canvasPos[1] - resizeOffset[1];
					maxX = minX + w;
					maxY = minY + h;
				} else {
					if (resizeHandle === "tl") { minX = canvasPos[0]; minY = canvasPos[1]; }
					if (resizeHandle === "tr") { maxX = canvasPos[0]; minY = canvasPos[1]; }
					if (resizeHandle === "bl") { minX = canvasPos[0]; maxY = canvasPos[1]; }
					if (resizeHandle === "br") { maxX = canvasPos[0]; maxY = canvasPos[1]; }
				}
				
				setLiveBoxCanvas([[minX, minY], [maxX, maxY]]);
			} else if ((mode === "lasso" || mode === "scribble") && freehandWorld.length > 0) {
				const pts2d = freehandWorld.map(w => worldToVisiblePaneCanvas(pane, w)).filter(Boolean) as [number, number][];
				if (pts2d.length === 0) return;
				
				let minX = Math.min(...pts2d.map(p => p[0]));
				let minY = Math.min(...pts2d.map(p => p[1]));
				let maxX = Math.max(...pts2d.map(p => p[0]));
				let maxY = Math.max(...pts2d.map(p => p[1]));
				const cx = (minX + maxX) / 2;
				const cy = (minY + maxY) / 2;
				
				if (resizeHandle === "move") {
					const dx = canvasPos[0] - cx;
					const dy = canvasPos[1] - cy;
					const newPts2d = pts2d.map(p => [p[0] + dx, p[1] + dy] as [number, number]);
					const newWorld = newPts2d.map(p => canvasPointToWorld(pane, p)).filter(Boolean) as Point3[];
					setFreehandWorld(newWorld);
				} else {
					let newW = maxX - minX;
					let newH = maxY - minY;
					let anchorX = minX;
					let anchorY = minY;
					
					if (resizeHandle === "tl") { newW = maxX - canvasPos[0]; newH = maxY - canvasPos[1]; anchorX = maxX; anchorY = maxY; }
					if (resizeHandle === "br") { newW = canvasPos[0] - minX; newH = canvasPos[1] - minY; anchorX = minX; anchorY = minY; }
					if (resizeHandle === "tr") { newW = canvasPos[0] - minX; newH = maxY - canvasPos[1]; anchorX = minX; anchorY = maxY; }
					if (resizeHandle === "bl") { newW = maxX - canvasPos[0]; newH = canvasPos[1] - minY; anchorX = maxX; anchorY = minY; }
					
					const oldW = Math.max(maxX - minX, 1);
					const oldH = Math.max(maxY - minY, 1);
					const scaleX = newW / oldW;
					const scaleY = newH / oldH;
					
					const newPts2d = pts2d.map(p => [(p[0] - anchorX) * scaleX + anchorX, (p[1] - anchorY) * scaleY + anchorY] as [number, number]);
					const newWorld = newPts2d.map(p => canvasPointToWorld(pane, p)).filter(Boolean) as Point3[];
					setFreehandWorld(newWorld);
				}
			}
			return;
		}

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
		
		if (status === "confirming" && resizeHandle) {
			setResizeHandle(null);
			setResizeOffset(null);
			return;
		}

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
			if (dx < 4 && dy < 4) void submit(pane, startWorld);
			else void submit(pane, undefined, [startWorld, endWorld]);
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
			if (mode === "lasso") void submit(paneSnapshot!, seed, undefined, built, undefined);
			else void submit(paneSnapshot!, seed, undefined, undefined, built);
		}
	};

	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	

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
		confirm,
		startResize,
		startLassoResize
	};
}
