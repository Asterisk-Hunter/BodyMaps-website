// The viewer's keyboard shortcuts, as data.
//
// These bindings have existed for a while but only ever as a comment at the top
// of useKeyboardShortcuts.ts, so nothing in the app could show them. Keeping
// them here lets the cheat-sheet surface them without the hook and the UI
// drifting apart — the two are meant to be edited together: if you add a
// binding in useKeyboardShortcuts.ts, add it here in the same commit.
export interface ShortcutItem {
	/** Key tokens rendered as separate chips, e.g. ["Shift", "["]. */
	keys: string[];
	desc: string;
}

export interface ShortcutGroup {
	title: string;
	items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	{
		title: "Moving through the scan",
		items: [
			{ keys: ["Scroll"], desc: "Step through slices on the pane you last touched" },
			{ keys: ["[", "]"], desc: "Step one slice on the focused pane" },
			{ keys: ["Shift", "[", "]"], desc: "Step ten slices" },
			{ keys: ["PageUp", "PageDown"], desc: "Step one slice (same as [ / ])" },
			{ keys: ["Home", "End"], desc: "Jump to the first or last slice of the focused pane" },
			{ keys: ["Ctrl", "←/→"], desc: "Jump the focused pane to its first or last slice" },
			{ keys: ["+", "-"], desc: "Zoom in or out toward the cursor" },
			{ keys: ["Ctrl", "0"], desc: "Reset zoom to fit" },
			{ keys: ["C"], desc: "Crosshair / navigation mode" },
		],
	},
	{
		title: "Measuring",
		items: [
			{ keys: ["L"], desc: "Length" },
			{ keys: ["B"], desc: "Bidirectional (RECIST)" },
			{ keys: ["A"], desc: "Angle" },
			{ keys: ["P"], desc: "Probe" },
			{ keys: ["R"], desc: "Rectangular ROI" },
			{ keys: ["E"], desc: "Elliptical ROI" },
			{ keys: ["F"], desc: "Freehand ROI" },
			{ keys: ["T"], desc: "Arrow" },
			{ keys: ["G"], desc: "Magnify loupe" },
			{ keys: ["M"], desc: "Open or close the measurements panel" },
			{ keys: ["S"], desc: "Save a snapshot of the current view" },
		],
	},
	{			title: "Reading",
			items: [
				{ keys: ["V"], desc: "Cine play / pause" },
				{ keys: ["?"], desc: "Open or close this shortcut list" },
			],
	},
	{
		title: "Editing (annotation ribbon open)",
		items: [
			{ keys: ["Alt", "Click"], desc: "Remove from the target with a corrective AI prompt" },
			{ keys: ["Esc"], desc: "Cancel the armed AI tool" },
		],
	},
	{
		title: "Undo",
		items: [
			{ keys: ["Ctrl", "Z"], desc: "Undo the last mask edit or measurement" },
			{ keys: ["Ctrl", "Shift", "Z"], desc: "Redo the last mask edit" },
			{ keys: ["Shift", "[", "]"], desc: "While painting: shrink or grow the brush by 2 mm" },
		],
	},
];
