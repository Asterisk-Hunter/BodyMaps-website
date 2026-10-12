export type Rect = { left: number; top: number; width: number; height: number };
export type WorkspaceTourPlacement = "above" | "below" | "right" | "left";

export type WorkspaceTourLayoutInput = {
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  /** Already padded, in physical viewport pixels; null represents the intro. */
  target: Rect | null;
  /** Measured physical dimensions, including any CSS zoom. */
  cardWidth: number;
  cardHeight: number;
  preferred?: WorkspaceTourPlacement[];
};

export type WorkspaceTourLayout = {
  left: number;
  top: number;
  /** Apply both maxima to the card; overflowing copy should scroll inside it. */
  availableMaxHeight: number;
  availableMaxWidth: number;
  /** Absolute viewport position of a 14 * scale square, before its rotation. */
  caret?: { left: number; top: number };
};

const nonnegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const DEFAULT_ORDER: WorkspaceTourPlacement[] = ["above", "below", "right", "left"];

/** Position the tour without covering its separate Skip or bottom navigation. */
export function layoutWorkspaceTour(input: WorkspaceTourLayoutInput): WorkspaceTourLayout {
  const scale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1;
  const viewportWidth = nonnegative(input.viewportWidth);
  const viewportHeight = nonnegative(input.viewportHeight);
  const margin = 16 * scale;
  const gap = 18 * scale;
  const minLeft = Math.min(margin, viewportWidth);
  const minTop = Math.min(72 * scale, viewportHeight);
  const availableMaxWidth = Math.max(0, viewportWidth - 2 * margin);
  const availableMaxHeight = Math.max(0, viewportHeight - (72 + 112) * scale);
  const width = Math.min(nonnegative(input.cardWidth), availableMaxWidth);
  const height = Math.min(nonnegative(input.cardHeight), availableMaxHeight);
  const maxLeft = minLeft + availableMaxWidth - width;
  const maxTop = minTop + availableMaxHeight - height;
  const clampLeft = (left: number) => clamp(left, minLeft, maxLeft);
  const clampTop = (top: number) => clamp(top, minTop, maxTop);
  const base = { availableMaxHeight, availableMaxWidth };
  const target = input.target;
  const centered = {
    ...base,
    left: minLeft + (availableMaxWidth - width) / 2,
    top: minTop + (availableMaxHeight - height) / 2,
  };
  // No usable area means the caller must hide/collapse the card rather than
  // allowing an oversized card to extend over the reserved controls.
  if (!target || !Object.values(target).every(Number.isFinite)
    || target.width <= 0 || target.height <= 0 || width <= 0 || height <= 0) return centered;

  const middleX = target.left + target.width / 2;
  const middleY = target.top + target.height / 2;
  const candidates: Record<WorkspaceTourPlacement, { left: number; top: number }> = {
    above: { left: clampLeft(middleX - width / 2), top: target.top - gap - height },
    below: { left: clampLeft(middleX - width / 2), top: target.top + target.height + gap },
    right: { left: target.left + target.width + gap, top: clampTop(middleY - height / 2) },
    left: { left: target.left - gap - width, top: clampTop(middleY - height / 2) },
  };
  const order = [...new Set([...(input.preferred ?? []), ...DEFAULT_ORDER])];
  let position = order.map((placement) => candidates[placement]).find((candidate) =>
    candidate.left >= minLeft && candidate.left <= maxLeft
    && candidate.top >= minTop && candidate.top <= maxTop);
  if (!position) {
    // Like V6, prefer the side with the most room relative to the measured
    // card dimension. Unlike its fallback, always retain BOTH reserved bands.
    const space: Record<WorkspaceTourPlacement, number> = {
      above: (target.top - gap - minTop) / height,
      below: (minTop + availableMaxHeight - target.top - target.height - gap) / height,
      right: (minLeft + availableMaxWidth - target.left - target.width - gap) / width,
      left: (target.left - gap - minLeft) / width,
    };
    const best = order.reduce((chosen, next) => space[next] > space[chosen] ? next : chosen);
    position = { left: clampLeft(candidates[best].left), top: clampTop(candidates[best].top) };
  }
  const result: WorkspaceTourLayout = { ...base, ...position };
  const caretSize = 14 * scale;
  const halfCaret = caretSize / 2;
  if (width < caretSize || height < caretSize) return result;
  // Keep the caret away from rounded corners, centering it on very small cards.
  const caretAxis = (middle: number, start: number, length: number) => {
    const inset = Math.min(24 * scale, (length - caretSize) / 2);
    return clamp(middle - halfCaret, start + inset, start + length - inset - caretSize);
  };
  let caret: { left: number; top: number } | undefined;
  if (position.top + height <= target.top) {
    caret = { left: caretAxis(middleX, position.left, width), top: position.top + height - halfCaret };
  } else if (position.top >= target.top + target.height) {
    caret = { left: caretAxis(middleX, position.left, width), top: position.top - halfCaret };
  } else if (position.left + width <= target.left) {
    caret = { left: position.left + width - halfCaret, top: caretAxis(middleY, position.top, height) };
  } else if (position.left >= target.left + target.width) {
    caret = { left: position.left - halfCaret, top: caretAxis(middleY, position.top, height) };
  }
  // A constrained fallback can overlap the target; do not show a misleading
  // arrow there, or let an arrow extend into the Skip/navigation bands.
  if (caret && caret.left >= minLeft && caret.left + caretSize <= minLeft + availableMaxWidth
    && caret.top >= minTop && caret.top + caretSize <= minTop + availableMaxHeight) result.caret = caret;
  return result;
}
