import { useCallback, useRef, useState } from "react";
import { setReferenceLinesEnabled, type CinePane } from "../CornerstoneNifti2";

type ViewMode = "mpr" | "axial" | "sagittal" | "coronal" | "3d";

interface UseFocusedPaneArgs {
	viewMode: ViewMode;
	referenceLinesOn: boolean;
	onInteraction?: () => void;
}

/**
 * Tracks which MPR pane is "focused": the fullscreen pane in a single 2D
 * view, or whichever of the three panes was most recently scrolled/clicked
 * while in MPR grid view. Used by every single-pane tool: reference lines'
 * source, cine playback, flip, rotate.
 *
 * Also reports that pane for RENDERING, via `isPaneFocused`, so the viewer can
 * mark it on screen — every one of those tools acts on a pane the reader
 * otherwise has no way to identify by looking.
 */
export function useFocusedPane({ viewMode, referenceLinesOn, onInteraction }: UseFocusedPaneArgs) {
	// A ref, not state: a wheel tick shouldn't force a re-render, and reading
	// .current at call time is always fresh regardless of when the enclosing
	// closure was created.
	const activePaneRef = useRef<CinePane>("axial");
	// Mirror of the above, for rendering only. Advanced on an actual pane CHANGE
	// (the same guard reference lines already use) rather than on every wheel
	// tick, so scrolling inside one pane still doesn't re-render the viewer.
	const [focusedPaneId, setFocusedPaneId] = useState<CinePane>("axial");

	// Memoized so callers (e.g. VisualizationPage's toggleCine useCallback) can
	// safely list it in a dependency array without it changing identity every
	// render — only viewMode changes actually need to invalidate it.
	const getFocusedPane = useCallback((): CinePane => {
		return viewMode === "axial" || viewMode === "sagittal" || viewMode === "coronal"
			? viewMode
			: activePaneRef.current;
	}, [viewMode]);

	// Guarded on the pane actually changing: a wheel gesture fires this once
	// per slice (dozens of times while scrolling the SAME pane), and
	// re-running setReferenceLinesEnabled on every tick — a full disable/
	// enable + re-render of all three viewports — for a source that hasn't
	// changed shows up as the dotted lines flickering during a normal scroll.
	const handleFocus = useCallback(
		(pane: CinePane) => {
			const paneChanged = activePaneRef.current !== pane;
			activePaneRef.current = pane;
			if (paneChanged) setFocusedPaneId(pane);
			if (referenceLinesOn && paneChanged) setReferenceLinesEnabled(true, pane);
		},
		[referenceLinesOn]
	);

	const handleWheel = useCallback((pane: CinePane) => () => {
		onInteraction?.();
		handleFocus(pane);
	}, [handleFocus, onInteraction]);
	const handleMouseDown = useCallback((pane: CinePane) => () => {
		onInteraction?.();
		handleFocus(pane);
	}, [handleFocus, onInteraction]);

	// Whether to draw the focused-pane marker on `pane`. Only the MPR grid needs
	// one: in the single-pane view modes the whole stage already belongs to one
	// plane, so outlining it would be decoration rather than information.
	const isPaneFocused = useCallback(
		(pane: CinePane) => viewMode === "mpr" && focusedPaneId === pane,
		[viewMode, focusedPaneId]
	);

	return { activePaneRef, getFocusedPane, isPaneFocused, handleFocus, handleWheel, handleMouseDown };
}
