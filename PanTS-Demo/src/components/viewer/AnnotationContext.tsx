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

export default function AnnotationContext({ activeTool, structureLabel, hasActiveTarget, hasTargetSegmentation, aiNegative, compact, tourOpen, onToggleTour }: AnnotationContextProps) {
	const brief = annotationBrief(activeTool, hasActiveTarget, hasTargetSegmentation, aiNegative);
	return (
		<aside className={`atb-context${compact ? " atb-context--compact" : ""}`} aria-label="Tool guide">
			<div className="atb-context__copy">
				<div className="atb-context__title">{brief.title}{structureLabel && <span> · {structureLabel}</span>}</div>
				<p>{brief.text}</p>
			</div>
			<button type="button" className="atb-context__tour" aria-label="Quick tour" aria-expanded={tourOpen} onClick={onToggleTour}>
				<IconHelpCircle size={17} aria-hidden="true" /><span>Tour</span>
			</button>
		</aside>
	);
}
