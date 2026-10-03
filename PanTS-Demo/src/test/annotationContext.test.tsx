import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationContext, { annotationBrief } from "../components/viewer/AnnotationContext";

describe("annotation tool guide", () => {
	it("explains the selected interaction and follows add/remove polarity", () => {
		expect(annotationBrief("boxSegment", true, true, false).text).toContain("choose Apply");
		expect(annotationBrief("boxSegment", true, true, true).text).toContain("remove");
		expect(annotationBrief(null, true, false, false).text).toContain("Draw");
		expect(annotationBrief("erase", true, true, false).text).toContain("remove from the mask");
	});

	it("keeps tour access available when the optional brief collapses", () => {
		render(<AnnotationContext activeTool="paint" structureLabel="Liver" hasActiveTarget hasTargetSegmentation aiNegative={false} compact tourOpen={false} onToggleTour={vi.fn()} />);
		expect(screen.getByRole("button", { name: "Quick tour" })).toBeEnabled();
		expect(screen.getByLabelText("Tool guide")).toHaveClass("atb-context--compact");
	});

	it("uses the empty header row, returns to the ribbon on resize, and removes the guide when editing closes", () => {
		const header = document.createElement("div");
		const identity = document.createElement("div");
		const actions = document.createElement("div");
		actions.className = "vp-tb-tools";
		header.append(identity, actions);
		document.body.append(header);
		let wrapped = true;
		const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
		vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => rect(0, 0, 867, 98));
		vi.spyOn(identity, "getBoundingClientRect").mockImplementation(() => rect(16, 8, 360, 38));
		vi.spyOn(actions, "getBoundingClientRect").mockImplementation(() => rect(16, wrapped ? 54 : 8, 600, 36));
		const props = { activeTool: "pointSegment" as const, structureLabel: "Liver", hasActiveTarget: true, hasTargetSegmentation: true, aiNegative: false, compact: false, tourOpen: false, onToggleTour: vi.fn() };
		const view = render(<AnnotationContext {...props} viewerHeaderRef={{ current: header }} />);
		expect(header).toContainElement(screen.getByRole("note", { name: "Selected tool guide" }));
		expect(screen.getAllByText("Click a region to guide AI segmentation.")).toHaveLength(1);
		wrapped = false;
		act(() => window.dispatchEvent(new Event("resize")));
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Tool guide")).toHaveTextContent("Click a region to guide AI segmentation.");
		wrapped = true;
		act(() => window.dispatchEvent(new Event("resize")));
		expect(screen.getByRole("note")).toBeInTheDocument();
		view.rerender(<AnnotationContext {...props} />);
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		view.unmount();
		header.remove();
	});
});
