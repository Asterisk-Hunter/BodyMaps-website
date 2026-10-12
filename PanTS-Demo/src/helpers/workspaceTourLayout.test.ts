import { describe, expect, it } from "vitest";
import { layoutWorkspaceTour, type WorkspaceTourLayoutInput } from "./workspaceTourLayout";

const base: WorkspaceTourLayoutInput = {
  viewportWidth: 1280, viewportHeight: 900, scale: 1,
  target: null, cardWidth: 372, cardHeight: 220,
};

function expectInsideUsableArea(input: WorkspaceTourLayoutInput) {
  const layout = layoutWorkspaceTour(input);
  const width = Math.min(input.cardWidth, layout.availableMaxWidth);
  const height = Math.min(input.cardHeight, layout.availableMaxHeight);
  expect(layout.left).toBeGreaterThanOrEqual(16 * input.scale);
  expect(layout.left + width).toBeLessThanOrEqual(input.viewportWidth - 16 * input.scale);
  expect(layout.top).toBeGreaterThanOrEqual(72 * input.scale);
  expect(layout.top + height).toBeLessThanOrEqual(input.viewportHeight - 112 * input.scale);
  return layout;
}

describe("workspace tour layout", () => {
  it("centers the intro within the usable viewport between Skip and navigation", () => {
    expect(layoutWorkspaceTour(base)).toEqual({
      left: 454, top: 320, availableMaxHeight: 716, availableMaxWidth: 1248,
    });
  });

  it("honors a fitting preferred placement and points the caret at the target", () => {
    const input = { ...base, target: { left: 500, top: 450, width: 200, height: 100 }, preferred: ["above" as const] };
    const layout = expectInsideUsableArea(input);
    expect(layout.left).toBe(414);
    expect(layout.top).toBe(212);
    expect(layout.caret).toEqual({ left: 593, top: 425 });
  });

  it("rejects preferred placements crossing the viewport edge and clamps the other axis", () => {
    const input = { ...base, viewportWidth: 800, viewportHeight: 700, cardWidth: 320, cardHeight: 180,
      target: { left: 8, top: 90, width: 50, height: 30 }, preferred: ["left" as const, "above" as const, "below" as const] };
    const layout = expectInsideUsableArea(input);
    expect(layout.left).toBe(16);
    expect(layout.top).toBe(138);
    expect(layout.caret).toEqual({ left: 40, top: 131 });
  });

  it("keeps a sidebar-bottom account card above the bottom navigation", () => {
    const input = { ...base, viewportWidth: 1440,
      target: { left: 16, top: 780, width: 220, height: 50 }, preferred: ["right" as const] };
    const layout = expectInsideUsableArea(input);
    expect(layout.left).toBe(254);
    expect(layout.top).toBe(568);
    expect(layout.caret).toEqual({ left: 247, top: 750 });
  });

  it("scales reserved bands, gaps and caret geometry consistently at .75 CSS zoom", () => {
    const unscaled = layoutWorkspaceTour({ ...base, target: { left: 500, top: 450, width: 200, height: 100 } });
    const input = { ...base, scale: .75, viewportWidth: 960, viewportHeight: 675,
      cardWidth: 279, cardHeight: 165, target: { left: 375, top: 337.5, width: 150, height: 75 } };
    const scaled = expectInsideUsableArea(input);
    expect(scaled.left).toBe(unscaled.left * .75);
    expect(scaled.top).toBe(unscaled.top * .75);
    expect(scaled.availableMaxHeight).toBe(unscaled.availableMaxHeight * .75);
    expect(scaled.caret).toEqual({ left: unscaled.caret!.left * .75, top: unscaled.caret!.top * .75 });
  });

  it("returns a scrollable card maximum for a narrow, short mobile viewport", () => {
    const input = { ...base, viewportWidth: 320, viewportHeight: 240, cardHeight: 400 };
    expect(expectInsideUsableArea(input)).toEqual({
      left: 16, top: 72, availableMaxHeight: 56, availableMaxWidth: 288,
    });
  });

  it("clamps a no-fit fallback inside both bands without a misleading overlapping caret", () => {
    const input = { ...base, viewportWidth: 800, viewportHeight: 500,
      target: { left: 100, top: 100, width: 600, height: 280 } };
    expect(expectInsideUsableArea(input).caret).toBeUndefined();
  });

  it("hides a caret that would intrude into the bottom navigation", () => {
    const input = { ...base, viewportWidth: 320, viewportHeight: 240, cardHeight: 400,
      target: { left: 4, top: 200, width: 312, height: 30 } };
    expect(expectInsideUsableArea(input).caret).toBeUndefined();
  });

  it("returns zero available height when no card can fit between reserved controls", () => {
    const layout = layoutWorkspaceTour({ ...base, viewportHeight: 120 });
    expect(layout.availableMaxHeight).toBe(0);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.top).toBeLessThanOrEqual(120);
    expect(layout.caret).toBeUndefined();
  });
});
