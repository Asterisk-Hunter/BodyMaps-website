import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { IconHelpCircle } from "@tabler/icons-react";
import type { PrimaryEditTool } from "./AnnotationToolbar";
import { TOOL_INFO, isAiTool } from "./annotationToolbarState";
import "./AnnotationContext.css";

interface AnnotationContextProps {
	activeTool: PrimaryEditTool;
	structureLabel?: string;
	hasActiveTarget: boolean;
	hasTargetSegmentation: boolean;
	aiNegative: boolean;
	compact: boolean;
	tourOpen: boolean;
	onToggleTour: () => void;
	viewerHeaderRef?: RefObject<HTMLDivElement | null>;
}

interface HeaderPlacement { element: HTMLDivElement; width: number; top: number; }

/** Reuse the empty first-row space only after the action group wraps below it. */
function useHeaderPlacement(headerRef?: RefObject<HTMLDivElement | null>) {
	const [placement, setPlacement] = useState<HeaderPlacement | null>(null);
	useLayoutEffect(() => {
		const header = headerRef?.current;
		const actions = header?.querySelector<HTMLElement>(".vp-tb-tools");
		if (!header || !actions) { setPlacement(null); return; }
		const preceding = Array.from(header.children).slice(0, Array.from(header.children).indexOf(actions));
		const sync = () => {
			const bounds = header.getBoundingClientRect();
			const rects = preceding.map((element) => element.getBoundingClientRect());
			const first = rects[0];
			const prefixRight = Math.max(...rects.map((rect) => rect.right));
			const available = bounds.right - 16 - prefixRight - 24;
			const wrapped = first && actions.getBoundingClientRect().top >= first.bottom;
			const next = wrapped && available >= 350
				? { element: header, width: Math.min(390, available), top: first.top - bounds.top + Math.max(0, (first.height - 33) / 2) }
				: null;
			setPlacement((previous) => previous?.element === next?.element && previous?.width === next?.width && previous?.top === next?.top ? previous : next);
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(header);
		observer.observe(actions);
		preceding.forEach((element) => observer.observe(element));
		window.addEventListener("resize", sync);
		return () => { observer.disconnect(); window.removeEventListener("resize", sync); };
	}, [headerRef]);
	return placement;
}

/** Interaction guidance only: the scan remains the source of anatomical information. */
export function annotationBrief(tool: PrimaryEditTool, hasTarget: boolean, hasMask: boolean, negative: boolean) {
	if (!hasTarget) return { title: "Segmentation", text: "Choose a structure to enable AI and drawing." };
	if (!tool) return { title: "Segmentation", text: hasMask
		? "Refine with AI, or adjust the mask with Edit tools."
		: "Start with AI, or choose Draw to add the mask by hand." };
	const title = `${isAiTool(tool) ? "AI " : ""}${TOOL_INFO[tool].label}`;
	switch (tool) {
		case "pointSegment": return { title, text: negative ? "Click a region to remove it from the mask." : "Click a region to guide AI segmentation." };
		case "boxSegment": return { title, text: negative ? "Box a region to remove, then choose Apply." : "Drag a box around the region, then choose Apply." };
		case "scribbleSegment": return { title, text: negative ? "Mark a region to remove, then choose Apply." : "Draw a short stroke over the region, then choose Apply." };
		case "paint": return { title, text: "Drag on the slice to add to the mask." };
		case "erase": return { title, text: "Drag on the slice to remove from the mask." };
		default: return { title, text: TOOL_INFO[tool].what };
	}
}

export default function AnnotationContext({ activeTool, structureLabel, hasActiveTarget, hasTargetSegmentation, aiNegative, compact, tourOpen, onToggleTour, viewerHeaderRef }: AnnotationContextProps) {
	const brief = annotationBrief(activeTool, hasActiveTarget, hasTargetSegmentation, aiNegative);
	const headerPlacement = useHeaderPlacement(viewerHeaderRef);
	const copy = <>
		<div className="atb-context__title">{brief.title}{structureLabel && <span> · {structureLabel}</span>}</div>
		<p>{brief.text}</p>
	</>;
	return (
		<aside className={`atb-context${compact || headerPlacement ? " atb-context--compact" : ""}`} aria-label="Tool guide">
			{headerPlacement ? createPortal(
				<div className="atb-context__copy atb-context__copy--header" role="note" aria-label="Selected tool guide" style={{ width: headerPlacement.width, top: headerPlacement.top }}>{copy}</div>,
				headerPlacement.element,
			) : <div className="atb-context__copy">{copy}</div>}
			<button type="button" className="atb-context__tour" aria-label="Quick tour" aria-expanded={tourOpen} onClick={onToggleTour}>
				<IconHelpCircle size={17} aria-hidden="true" /><span>Tour</span>
			</button>
		</aside>
	);
}
