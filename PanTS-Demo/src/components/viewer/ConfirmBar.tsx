import { useState, useEffect, useRef, useCallback } from "react";
import "./ConfirmBar.css";

export type ConfirmBarPlacement = {
  /** Selection bounds in the pane's local coordinate space (px).
   *  For a box this is the live box rect; for lasso/scribble the bounding
   *  rect of the drawn shape. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Which side of the selection the bar should attach to. "below" is the
   *  default (the eye lands under the shape after drawing; above collides
   *  with readouts). "above" is the flip target when below would overflow
   *  the pane. */
  side?: "below" | "above";
  /** Optional voxel-size readout shown left of the buttons, e.g. "128 × 96 vox · slice 47". */
  readout?: string;
  /** Label for the primary action (defaults to "Apply"). */
  applyLabel?: string;
  onApply: () => void;
  onCancel: () => void;
};

const PANE_INSET = 12;
const GAP = 8;

/**
 * Shared Apply/Cancel confirm bar for the interactive prompt tools
 * (box / lasso / scribble). Replaces the old inline-styled floating buttons
 * that rendered at top:-40px above the selection — overlapping anatomy and
 * readouts, clipping at the pane's top edge, and sitting exactly under the
 * user's mouse (misclick bait).
 *
 * Placement (flip + clamp, computed against the enclosing .vp-pane):
 *   1. Default: centered under the selection's bottom edge.
 *   2. Would overflow the pane bottom  -> flip above the top edge.
 *   3. Would overflow both             -> pinned to the pane's bottom-right
 *      corner with a dashed top border (leader treatment).
 * The bar is always fully inside the pane; it never leaves the viewport of
 * the image the user is annotating.
 *
 * Buttons commit on pointerdown (not click) with stopPropagation so the
 * pane underneath never receives the gesture — kills the misclick-through
 * class of bugs. Keyboard: Enter applies, Esc cancels (Esc is already wired
 * by the prompt tool; Enter is bound here while mounted).
 */
export function ConfirmBar({
  left, top, width, height,
  side = "below",
  readout,
  applyLabel = "Apply",
  onApply,
  onCancel,
}: ConfirmBarPlacement) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barSize, setBarSize] = useState<{ w: number; h: number } | null>(null);

  // Measure once after mount so placement math can use real dimensions
  // (buttons + kbd hints + readout make the width content-dependent).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setBarSize({ w: rect.width, h: rect.height });
  }, [readout, applyLabel]);

  // Enter applies while the bar is up (Esc is handled by the prompt tool's
  // global handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onApply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onApply]);

  const placement = useCallback((): { left: number; top: number; pinned: boolean } => {
    // The bar renders as a sibling of the Cornerstone pane div inside
    // .vp-pane-wrap (React must not mix children into Cornerstone's
    // imperatively-managed node), so positioning context = the wrap, not
    // .vp-pane itself.
    const wrap = barRef.current?.closest(".vp-pane-wrap") as HTMLElement | null;
    const paneW = wrap?.clientWidth ?? 0;
    const paneH = wrap?.clientHeight ?? 0;
    const bw = barSize?.w ?? 180;
    const bh = barSize?.h ?? 34;

    // Ideal position: centered horizontally under (or above) the selection.
    // The selection bounds are given relative to the pane (.vp-pane); the
    // wrap is its full-size parent (.vp-pane-wrap>div:first-child is
    // 100%/100%), so the coordinates carry over 1:1.
    let x = left + width / 2 - bw / 2;
    let y = side === "below" ? top + height + GAP : top - bh - GAP;
    let pinned = false;

    const fits = (yy: number) => yy >= PANE_INSET && yy + bh <= paneH - PANE_INSET;

    // Horizontal clamp: never let the bar leave the pane.
    x = Math.min(Math.max(x, PANE_INSET), Math.max(PANE_INSET, paneW - bw - PANE_INSET));

    if (!fits(y)) {
      // Flip to the other side of the selection.
      const flippedY = side === "below" ? top - bh - GAP : top + height + GAP;
      if (fits(flippedY)) {
        y = flippedY;
      } else {
        // Neither side fits (shape spans the pane vertically): pin to the
        // pane's bottom-right corner; dashed top border ties it to the
        // selection visually.
        y = Math.max(PANE_INSET, paneH - bh - PANE_INSET);
        pinned = true;
      }
    }

    return { left: x, top: y, pinned };
  }, [left, top, width, height, side, barSize]);

  const { left: px, top: py, pinned } = placement();

  return (
    <div
      ref={barRef}
      className={`vp-confirm-bar${pinned ? " vp-confirm-bar--pinned" : ""}`}
      style={{ left: px, top: py }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="Confirm segmentation prompt"
    >
      {readout && <span className="vp-confirm-bar__readout">{readout}</span>}
      <button
        type="button"
        className="vp-confirm-bar__btn vp-confirm-bar__btn--primary"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onApply();
        }}
      >
        {applyLabel}
      </button>
      <button
        type="button"
        className="vp-confirm-bar__btn vp-confirm-bar__btn--ghost"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onCancel();
        }}
      >
        Cancel
      </button>
      <span className="vp-confirm-bar__kbd" aria-hidden="true">
        <kbd>⏎</kbd> Apply · <kbd>Esc</kbd> Cancel
      </span>
    </div>
  );
}
