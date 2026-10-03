import { render, screen } from "@testing-library/react";
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
});
