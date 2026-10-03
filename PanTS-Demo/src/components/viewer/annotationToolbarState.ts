// The annotation ribbon's declarative model: which of the four annotation
// states the app is in, which controls that state exposes, and the
// human-readable copy (flyout sections, tooltip bodies, onboarding) for those
// controls.
//
// Deliberately pure and free of React/DOM so the state machine and the copy
// can be unit-tested directly — see src/test/annotationToolbarState.test.ts.
// AnnotationToolbar.tsx renders straight off TOOLBAR_LAYOUTS rather than
// testing conditions inline, so "what shows when" lives in exactly one place.
import type { PrimaryEditTool } from "./AnnotationToolbar";

/** A tool id with the null case stripped — the ids TOOL_DEFS is keyed by. */
export type EditTool = Exclude<PrimaryEditTool, null>;

/**
 * The four states the toolbar re-renders from. Order matters for
 * `deriveToolbarState`'s precedence: an active manual tool wins over
 * target/segmentation flags, since editing is a mode the user explicitly
 * entered and it must survive an edit that happens to empty the mask.
 */
export type ToolbarState =
	| "NO_STRUCTURE_SELECTED"
	| "STRUCTURE_SELECTED_NO_SEGMENTATION"
	| "SEGMENTATION_EXISTS"
	| "EDITING";

/** The AI prompt tools — the only tools allowed to show the polarity toggle. */
export const AI_TOOL_IDS: readonly EditTool[] = ["pointSegment", "boxSegment", "scribbleSegment"];

export function isAiTool(tool: PrimaryEditTool): boolean {
	return tool != null && AI_TOOL_IDS.some((id) => id === tool);
}

/** Manual (non-AI) tools: equip-and-use icons plus everything that lives in
 *  the Edit flyout. Activating any of them is what makes the toolbar enter
 *  its EDITING state. */
export const MANUAL_TOOL_IDS: readonly EditTool[] = [
	"paint", "erase", "scissors", "levelTracing",
	"margin", "smoothing", "islands", "logicalOperators",
	"growFromSeeds", "fillBetweenSlices", "copyAcrossSlices", "hollow",
];

export function isManualTool(tool: PrimaryEditTool): boolean {
	return tool != null && MANUAL_TOOL_IDS.some((id) => id === tool);
}

export interface ToolbarStateInput {
	/** A structure/class is currently targeted (`activeSegment != null`). */
	hasActiveTarget: boolean;
	/** That targeted structure already has mask voxels in it. */
	hasTargetSegmentation: boolean;
	/** The tool currently armed in the ribbon, if any. */
	activeTool: PrimaryEditTool;
}

export function deriveToolbarState({ hasActiveTarget, hasTargetSegmentation, activeTool }: ToolbarStateInput): ToolbarState {
	if (isManualTool(activeTool)) return "EDITING";
	if (!hasActiveTarget) return "NO_STRUCTURE_SELECTED";
	return hasTargetSegmentation ? "SEGMENTATION_EXISTS" : "STRUCTURE_SELECTED_NO_SEGMENTATION";
}

/**
 * Which Level 1 slots a state renders, in ribbon order. `ai` is tri-state
 * rather than a boolean because the AI Segment slot is the same control
 * wearing two labels: "AI segment" for an empty target and "AI refine" when
 * a mask exists.
 */
export interface ToolbarLayout {
	structurePicker: boolean;
	ai: "start" | "refine" | null;
	/** Add/Remove polarity — additionally gated on an AI tool actually being
	 *  armed (see `toolbarLayout`); hidden during manual editing because
	 *  Brush/Eraser carry their own implicit polarity. */
	polarity: boolean;
	edit: boolean;
	brush: boolean;
	eraser: boolean;
	more: boolean;
	/** Slot for user-pinned tools — sits between Edit/More and Undo. */
	pinned: boolean;
	undo: boolean;
	redo: boolean;
	save: boolean;
	finishEditing: boolean;
}

export const TOOLBAR_LAYOUTS: Record<ToolbarState, ToolbarLayout> = {
	// Nothing to annotate yet — the picker is the only thing worth showing.
	NO_STRUCTURE_SELECTED: {
		structurePicker: true,
		ai: null,
		polarity: false,
		edit: false,
		brush: false,
		eraser: false,
		more: false,
		pinned: false,
		undo: false,
		redo: false,
		save: false,
		finishEditing: false,
	},
	// A structure is targeted but empty: AI segmentation and basic drawing are
	// both available. Mask-dependent operations, history, and saving stay hidden.
	//
	// Polarity is allowed here as well as in SEGMENTATION_EXISTS: it only ever
	// reaches the screen while an AI prompt tool is armed (see
	// `toolbarLayout`), which is exactly the moment the person has picked an
	// option out of the AI flyout — they need Add/Remove for that first pass
	// just as much as for later refinements.
	STRUCTURE_SELECTED_NO_SEGMENTATION: {
		structurePicker: true,
		ai: "start",
		polarity: true,
		edit: true,
		brush: false,
		eraser: false,
		more: false,
		pinned: false,
		undo: false,
		redo: false,
		save: false,
		finishEditing: false,
	},
	// The steady state once a mask exists: refine it with AI or by hand, and
	// keep the history/save controls in reach.
	SEGMENTATION_EXISTS: {
		structurePicker: true,
		ai: "refine",
		polarity: true,
		edit: true,
		brush: false,
		eraser: false,
		more: false,
		pinned: true,
		undo: true,
		redo: true,
		save: true,
		finishEditing: false,
	},
	// Mid-edit: Brush/Eraser stay on the ribbon, other tools move behind More,
	// and Save stays available alongside an explicit editing exit.
	EDITING: {
		structurePicker: true,
		ai: null,
		polarity: false,
		edit: false,
		brush: true,
		eraser: true,
		more: true,
		pinned: true,
		undo: true,
		redo: true,
		save: true,
		finishEditing: true,
	},
};

/**
 * The AI Segment slot's copy for a state — and, once an AI option is in hand,
 * the name of that option.
 *
 * "AI refine" is right for the resting state (there is a mask, and the point of
 * the button is to improve it), but it is wrong the moment the person picks an
 * option out of the flyout: they are no longer choosing to refine, they are
 * running a click/box/scribble. Leaving the button reading "AI refine" after that
 * choice is what made it feel like the choice hadn't registered, so the armed
 * tool now wins the label and the button reports what is about to happen.
 */
export interface AiSlotCopy {
	label: string;
	info: TooltipInfo;
}

export function aiSlotCopy(ai: "start" | "refine", activeTool: PrimaryEditTool): AiSlotCopy {
	// Armed option: reuse the tool's own tooltip copy, so the hover card here
	// and the row in the flyout can never drift apart.
	if (isAiTool(activeTool)) {
		const armed = TOOL_INFO[activeTool as EditTool];
		return { label: `AI: ${armed.label}`, info: armed };
	}
	if (ai === "start") {
		return { label: "AI segment", info: CONTROL_INFO.aiSegmentStart };
	}
	return { label: "AI refine", info: CONTROL_INFO.aiSegmentRefine };
}

/** The state's layout with the one cross-cutting rule applied: polarity is
 *  only ever on screen while an AI prompt tool is armed. */
export function toolbarLayout(state: ToolbarState, activeTool: PrimaryEditTool): ToolbarLayout {
	const layout = TOOLBAR_LAYOUTS[state];
	if (!layout.polarity || isAiTool(activeTool)) return layout;
	return { ...layout, polarity: false };
}

/** Tool ids a state already renders as their own slot, so a pinned tool that
 *  happens to be one of them isn't drawn twice. */
export function inlineToolIds(state: ToolbarState): readonly EditTool[] {
	return state === "EDITING" ? ["paint", "erase"] : [];
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/** The tooltip contract from the redesign spec:
 *     [Tool name]
 *     One sentence: what it does.
 *     "Use when: [situation]"
 *     Shortcut: [key]
 *  Kept as data next to the tool ids so every surface that can show a tooltip
 *  (ribbon icon, flyout row, pinned slot) renders identical copy. */
export interface TooltipInfo {
	label: string;
	what: string;
	useWhen: string;
	/** Rendered only when a real key binding exists — see useKeyboardShortcuts. */
	shortcut?: string;
}

export const TOOL_INFO: Record<EditTool, TooltipInfo> = {
	// --- AI prompt tools -----------------------------------------------------
	pointSegment: {
		label: "Click",
		what: "Click inside the structure. Fastest for simple areas.",
		useWhen: "the structure is large, obvious, and easy to point at.",
		shortcut: "P",
	},
	boxSegment: {
		label: "Box",
		what: "Draw a box around it. Useful for larger regions.",
		useWhen: "the structure spans several slices or you want to bound the AI's search area.",
		shortcut: "B",
	},
	scribbleSegment: {
		label: "Scribble",
		what: "Draw over the structure. More guidance for complex cases.",
		useWhen: "the boundary is irregular, or a click or box already gave a rough result.",
		shortcut: "S",
	},
	lassoSegment: {
		label: "Lasso",
		what: "Outline the structure with a freehand loop.",
		useWhen: "you want to show the AI the exact outline you mean.",
	},
	// --- Basic editing ------------------------------------------------------
	paint: {
		label: "Brush",
		what: "Paint mask voxels freehand with a round brush.",
		useWhen: "adding tissue the AI or a threshold missed.",
	},
	erase: {
		label: "Eraser",
		what: "Rub mask voxels away freehand.",
		useWhen: "removing tissue that was segmented by mistake.",
	},
	scissors: {
		label: "Scissors",
		what: "Cut along a line of placed points to add or remove everything on one side.",
		useWhen: "splitting a mask along a clean anatomical edge.",
	},
	levelTracing: {
		label: "Level Trace",
		what: "Follow the equal-intensity boundary around the cursor and fill inside it.",
		useWhen: "the structure has a crisp, uniform-intensity edge.",
	},
	// --- Advanced ------------------------------------------------------------
	smoothing: {
		label: "Smooth",
		what: "Smooth jagged segmentation boundaries.",
		useWhen: "after manual brushing — it tidies the edges without moving them.",
	},
	margin: {
		label: "Margin",
		what: "Grow or shrink the segmentation by N mm.",
		useWhen: "the mask is consistently too tight or too generous everywhere.",
	},
	islands: {
		label: "Islands",
		what: "Remove disconnected pieces. Keep the largest, or pick one manually.",
		useWhen: "stray specks appear, or a second unrelated blob got segmented.",
	},
	growFromSeeds: {
		label: "Grow from seeds",
		what: "Mark inside/outside points and auto-grow the region.",
		useWhen: "a structure is easy to identify but tedious to outline by hand.",
	},
	// --- Across slices -------------------------------------------------------
	fillBetweenSlices: {
		label: "Fill between slices",
		what: "Segment start + end slice, interpolates everything between.",
		useWhen: "a structure is smooth and continuous across many slices.",
	},
	copyAcrossSlices: {
		label: "Copy across slices",
		what: "Copy this slice's shape exactly onto another slice.",
		useWhen: "the same shape repeats over several slices.",
	},
	// --- More ----------------------------------------------------------------
	logicalOperators: {
		label: "Logical operators",
		what: "Combine two classes with add, subtract, or keep-common.",
		useWhen: "two masks overlap and you need to merge or trim them.",
	},
	hollow: {
		label: "Hollow",
		what: "Replace the mask with a uniform-thickness shell.",
		useWhen: "you need a wall of a specific thickness instead of a solid fill.",
	},
};

/** Tooltips for the non-tool controls the state machine renders. */
export const CONTROL_INFO = {
	structurePicker: {
		label: "Structure",
		what: "Choose which structure this segmentation belongs to.",
		useWhen: "you start annotating, or switch to a different organ or class.",
	},
	aiSegmentStart: {
		label: "AI segment",
		what: "Generate a first mask for this structure with AI.",
		useWhen: "the structure is empty and you want a starting point.",
	},
	aiSegmentRefine: {
		label: "AI refine",
		what: "Run the AI again on the mask you already have.",
		useWhen: "the mask is close but missing tissue, or is including too much.",
	},
	polarity: {
		label: "Add / Remove",
		what: "Switch whether the next AI step adds to or removes from the mask.",
		useWhen: "correcting an over- or under-segmented area.",
		shortcut: "X",
	},
	edit: {
		label: "Edit",
		what: "Open the manual editing tools: brush, eraser, scissors and more.",
		useWhen: "you need to fix the mask by hand.",
	},
	more: {
		label: "More tools",
		what: "Open the full manual editing tool list.",
		useWhen: "you need a tool other than Brush or Eraser.",
	},
	undo: {
		label: "Undo",
		what: "Step back one mask edit or measurement.",
		useWhen: "the last change wasn't what you wanted.",
		shortcut: "Ctrl+Z",
	},
	redo: {
		label: "Redo",
		what: "Reapply the last undone edit.",
		useWhen: "you undid one step too far.",
		shortcut: "Ctrl+Shift+Z",
	},
	save: {
		label: "Save",
		what: "Save this segmentation to the master record.",
		useWhen: "the mask is reviewed and complete.",
	},
	finishEditing: {
		label: "Finish editing",
		what: "Leave manual editing and return to the annotation tools.",
		useWhen: "you've finished making manual changes.",
	},
} as const satisfies Record<string, TooltipInfo>;

// ---------------------------------------------------------------------------
// Flyout contents
// ---------------------------------------------------------------------------

/** The AI segment flyout: exactly three options, described in plain English
 *  with no internal implementation names. */
export const AI_FLYOUT_OPTIONS: readonly EditTool[] = ["pointSegment", "boxSegment", "scribbleSegment"];

export interface EditSection {
	title: string;
	/** Collapsed-by-default sections render as an inline expander whose
	 *  label replaces the section header. */
	collapsed?: boolean;
	tools: readonly EditTool[];
}

export const EDIT_SECTIONS: readonly EditSection[] = [
	{ title: "Basic", tools: ["paint", "erase", "scissors", "levelTracing"] },
	{ title: "Advanced", tools: ["smoothing", "margin", "islands", "growFromSeeds"] },
	{ title: "Across slices", tools: ["fillBetweenSlices", "copyAcrossSlices"] },
	{ title: "More", collapsed: true, tools: ["logicalOperators", "hollow"] },
];

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/** First-run flag. A localStorage key (not sessionStorage, unlike the older
 *  per-tool walkthrough hints) because the tour is meant to appear once ever,
 *  not once per tab. */
export const ONBOARDING_STORAGE_KEY = "annotation_onboarded";

/** A compact workflow overview, kept beside Tour without opening editing tools. */
export interface OnboardingStep {
	title: string;
	text: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
	{
		title: "Pick a structure",
		text: "Select a structure to annotate.",
	},
	{
		title: "Create a mask",
		text: "Choose an AI method, or draw the mask with Brush.",
	},
	{
		title: "Refine the mask",
		text: "Use Brush to add or Eraser to remove.",
	},
	{
		title: "Review and save",
		text: "Check the slices, then choose Save.",
	},
];

export function hasCompletedOnboarding(): boolean {
	try {
		return typeof window !== "undefined" && window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
	} catch {
		// Storage unavailable (private mode / blocked) — treat as "already
		// seen" so a broken storage backend can't nag on every load.
		return true;
	}
}

export function markOnboardingComplete(): void {
	try {
		window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
	} catch {
		/* nothing to do — the tour simply shows again next session */
	}
}
