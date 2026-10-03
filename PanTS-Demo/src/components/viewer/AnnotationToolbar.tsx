import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
	IconBrush,
	IconEraser,
	IconScissors,
	IconRipple,
	IconArrowsDiagonal,
	IconDroplet,
	IconMathFunction,
	IconWand,
	IconStack2,
	IconCopy,
	IconWaveSine,
	IconCircleDashed,
	IconHandClick,
	IconFrame,
	IconPencil,
	IconPlayerStop,
	IconX,
	IconPin,
	IconChevronDown,
	IconDotsVertical,
	IconArrowBackUp,
	IconArrowForwardUp,
	IconDeviceFloppy,
	IconLoader,
} from "@tabler/icons-react";
import "./AnnotationToolbar.css";
import NumberSliderField from "../NumberSliderField";
import { FlyoutPanel, GrandchildRow, MenuColumn, MenuRow, MenuDivider, useFlyout } from "./FlyoutPrimitives";
import type { GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";
import StructurePicker, { type StructureOption } from "./StructurePicker";
import {
	AI_FLYOUT_OPTIONS,
	CONTROL_INFO,
	EDIT_SECTIONS,
	TOOL_INFO,
	aiSlotCopy,
	deriveToolbarState,
	inlineToolIds,
	isAiTool,
	toolbarLayout,
	type EditTool,
} from "./annotationToolbarState";

export type PrimaryEditTool =
	| "paint" | "erase" | "scissors" | "levelTracing"
	| "margin" | "smoothing" | "islands" | "logicalOperators"
	| "growFromSeeds" | "fillBetweenSlices" | "copyAcrossSlices" | "hollow"
	| "pointSegment" | "boxSegment" | "lassoSegment" | "scribbleSegment"
	| null;
export type ScissorsOperation = "eraseInside" | "eraseOutside" | "fillInside" | "fillOutside";
export type ScissorsSliceCut = "unlimited" | "positive" | "negative" | "symmetric";

export interface ScissorsOptions {
	operation: ScissorsOperation;
	/** When on, each placed point snaps to the nearest strong intensity edge
	 *  within a small radius (like Photoshop's magnetic lasso). */
	magnetEnabled?: boolean;
}

interface AnnotationToolbarProps {
	open: boolean;
	disabled?: boolean;
	hasSegments: boolean;
	hasActiveTarget: boolean;
	activeTool: PrimaryEditTool;
	onToolChange: (tool: PrimaryEditTool) => void;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onDiameterPreviewChange?: (active: boolean) => void;
	scissorsOptions: ScissorsOptions;
	onScissorsOptionsChange: (opts: ScissorsOptions) => void;
	scissorsPointCount: number;
	onScissorsCancel: () => void;

	/** ± toggle for AI segment — true = negative / subtractive (maps to include_interaction:false) */
	aiNegative?: boolean;
	onAiNegativeChange?: (v: boolean) => void;

	/** An AI prompt run is in flight. Keeps the run's Stop control live while
	 *  every other ribbon control is disabled. */
	aiRunBusy?: boolean;
	/** Stops the in-flight AI run — aborts the request itself, it does not just
	 *  stop waiting for it. Same effect as Esc while a run is up; the armed tool
	 *  stays armed so the next click can go straight out. */
	onAiCancelRun?: () => void;

	/** Id of whatever class/organ is currently targeted. Not used for editing
	 *  logic here — only watched so the ribbon can deselect the active tool
	 *  when the target changes (see the reset effect below). */
	targetKey: number | null;

	/** Cancels/deselects the currently armed AI prompt tool (point/box/
	 *  lasso/scribble) — same effect as pressing Esc. Rendered as an
	 *  explicit ✕ button in the ribbon's AI controls so the sticky
	 *  equip-and-use tool has a visible, mouse-driven way out. */
	onAiCancel?: () => void;

	// `onApplied`: one-shot tools (margin, smoothing, islands, logical
	// operators, grow-from-seeds, hollow, ...) call this once their Apply
	// button runs, to deselect the tool (see LIVE_COMMIT_TOOLS for tools that
	// skip this). `onCloseSettings` closes just the settings flyout without
	// deselecting the tool — used by level tracing (auto-close on mode pick)
	// and the guided-overlay tools (close once their full-screen walkthrough
	// takes over).
	renderFlyout: (tool: Exclude<PrimaryEditTool, null>, onApplied: () => void, onCloseSettings: () => void, onGuidedControlsChange: (controls: GuidedFlowControls | null) => void) => React.ReactNode;
	/** Fired whenever a guided slice-anchor pick flow (Copy/Fill across
	 *  slices) becomes active or finishes — true for the flow's entire
	 *  lifecycle (both click steps, the ready-to-apply confirm, and while
	 *  committing), not just the literal picking sub-phase, since the
	 *  crosshair shouldn't be live for any of it: clicking a pane during a
	 *  guided pick is meant to choose a slice/anchor, not move the
	 *  crosshair. The caller (VisualizationPage) uses this to suppress
	 *  Crosshairs for the duration. */
	onGuidedPickingChange?: (active: boolean) => void;

	// ------------------------------------------------------------------
	// Level 1 history / save controls
	// ------------------------------------------------------------------
	/** Undo/redo/save are owned by VisualizationPage — the same handlers the
	 *  main toolbar's own buttons call, threaded in rather than duplicated so
	 *  the ribbon can never drift out of sync with them (e.g. offering Undo
	 *  when the parent says there's nothing to undo). */
	onUndo: () => void;
	onRedo: () => void;
	onSave: () => void;
	saveStatus?: "idle" | "dirty" | "saving" | "saved" | "error";
	saveError?: string;
	onRetrySave?: () => void;
	canUndo: boolean;
	canRedo: boolean;
	isSaving: boolean;

	// ------------------------------------------------------------------
	// Toolbar state machine inputs (see annotationToolbarState.ts)
	// ------------------------------------------------------------------
	/** Whether the currently targeted structure already contains mask voxels.
	 *  Together with `hasActiveTarget` and `activeTool` this decides which of
	 *  the four toolbar states renders — and therefore whether the AI slot
	 *  reads "AI segment" or "AI refine", and whether Edit/Undo/Save are
	 *  on the ribbon at all. */
	hasTargetSegmentation: boolean;

	// ------------------------------------------------------------------
	// Structure picker
	// ------------------------------------------------------------------
	/** Present catalog organs and custom structures for the single target picker. */
	structures: StructureOption[];
	colors?: Record<number, string>;
	activeStructureId: number | null;
	onSelectStructure: (id: number | null) => void;
	onCreateStructure?: (name: string, color: string) => StructureOption | null;
	onRenameStructure?: (id: number, name: string) => boolean;
	onColorChange?: (id: number, color: string) => void;
	onDeleteStructure?: (id: number) => void;
	showOnlyTargetMask?: boolean;
	onShowOnlyTargetMaskChange?: (value: boolean) => void;
	managedStructureIds?: readonly number[];
	visibility?: Record<number, boolean>;
	onToggleVisibility?: (id: number) => void;

	/** Retained for caller compatibility; the toolbar is docked independently. */
	anchorRef?: React.RefObject<HTMLElement | null>;

}

export const TOOL_DEFS: Array<{ id: Exclude<PrimaryEditTool, null>; label: string; Icon: typeof IconBrush; description: string }> = [	
	{ id: "paint", label: "Brush", Icon: IconBrush, description: "Paint freehand with a round brush." },
	{ id: "erase", label: "Erase", Icon: IconEraser, description: "Erase parts of a shape manually." },
	{ id: "scissors", label: "Scissors", Icon: IconScissors, description: "Lasso tool using anchor points." },
	{ id: "levelTracing", label: "Level Tracing", Icon: IconRipple, description: "Traces the boundary of similar intensity around cursor." },
	{ id: "margin", label: "Margin", Icon: IconArrowsDiagonal, description: "Grow or shrink by a specified margin size." },
	{ id: "smoothing", label: "Smoothing", Icon: IconWaveSine, description: "Smooth class boundaries." },
	{ id: "islands", label: "Islands", Icon: IconDroplet, description: "Edit islands (connected components) in a class." },
	{ id: "logicalOperators", label: "Logical operators", Icon: IconMathFunction, description: "Apply logical operators or combine classes." },
	{ id: "growFromSeeds", label: "Grow from seeds", Icon: IconWand, description: "Grow a class from user-placed scribbles." },
	{ id: "fillBetweenSlices", label: "Fill between slices", Icon: IconStack2, description: "Interpolate a class's shape between two annotated slices." },
	{ id: "copyAcrossSlices", label: "Copy across slices", Icon: IconCopy, description: "Copy a class's shape from first to last slice." },
	{ id: "hollow", label: "Hollow", Icon: IconCircleDashed, description: "Make the class hollow by replacing it with a uniform-thickness shell." },
	{ id: "pointSegment", label: "Click to segment", Icon: IconHandClick, description: "Click a point to propose a segment there." },
	{ id: "boxSegment", label: "Box to segment", Icon: IconFrame, description: "Draw a box to propose a segment restricted to that region." },
	{ id: "scribbleSegment", label: "Scribble", Icon: IconPencil, description: "Draw a scribble stroke — cropped via interaction_bbox, resampled nearest." },
];

const SCISSORS_OPERATIONS: { value: ScissorsOperation; label: string }[] = [
	{ value: "eraseInside", label: "Erase inside" },
	{ value: "eraseOutside", label: "Erase outside" },
	{ value: "fillInside", label: "Fill inside" },
	{ value: "fillOutside", label: "Fill outside" },
];

// Tools that don't have an ApplyButton — they commit directly on pointer
// interaction, so the rendering dot is the only feedback available.
const LIVE_COMMIT_TOOLS: Exclude<PrimaryEditTool, null>[] = ["paint", "erase", "scissors", "levelTracing", "pointSegment", "boxSegment", "lassoSegment", "scribbleSegment"];

const MIN_DIAMETER_MM = 2;
const MAX_DIAMETER_MM = 40;

// Ribbon height, matches --atb-ribbon-h in CSS. Exported so SegmentsPopup
// can dock directly beneath the ribbon without duplicating the constant.
export const ANNOTATION_DOCK_WIDTH = 60;

function MagnetIcon({ active: _active }: { active?: boolean }) {
	// Always white — this row's background never goes solid light like an
	// .is-active MenuRow, so a dark stroke would be invisible here.
	const stroke = "#fff";
	return (
		<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
			<path
				d="M6 3 L6 10 A4 4 0 0 0 14 10 L14 3"
				stroke={stroke}
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<path d="M6 3 H3 V7 H6" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M14 3 H17 V7 H14" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M2.5 12.5 L4.5 11.2 M17.5 12.5 L15.5 11.2" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
		</svg>
	);
}

function DiameterFlyout({
	title, diameterMm, onDiameterChange, onPreviewChange, fieldRef,
}: {
	title: string;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onPreviewChange?: (active: boolean) => void;
	/** Wraps the slider field so the walkthrough can spotlight its live rect. */
	fieldRef?: React.RefObject<HTMLDivElement>;
}) {
	return (
		<div className="seg-effect">
			<div ref={fieldRef}>
				<NumberSliderField
					label={title}
					value={diameterMm}
					onChange={onDiameterChange}
					min={MIN_DIAMETER_MM}
					max={MAX_DIAMETER_MM}
					step={0.5}
					unit="mm"
					ariaLabel={`${title} diameter`}
					onPreviewChange={onPreviewChange}
				/>
			</div>
		</div>
	);
}

function ScissorsFlyout({ options, onChange, onCloseSettings }: {
	options: ScissorsOptions;
	onChange: (opts: ScissorsOptions) => void;
	pointCount: number;
	onCancel: () => void;
	/** Closes the Scissors settings flyout once an operation is picked;
	 *  scissors itself stays equipped. */
	onCloseSettings: () => void;
}) {
	const set = <K extends keyof ScissorsOptions>(key: K, value: ScissorsOptions[K]) =>
		onChange({ ...options, [key]: value });

	// Brief "picked" state on the row before the settings flyout collapses.
	const pickOperation = (op: ScissorsOperation) => {
		set("operation", op);
		window.setTimeout(() => onCloseSettings(), 320);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 190 }}>
			<MenuColumn>
				<label className="atb-menu-row atb-menu-row--checkbox" title="Snap each point to the nearest strong intensity edge, like Photoshop's magnetic lasso">
					<span className="atb-menu-row__label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<MagnetIcon active={options.magnetEnabled} />
						Magnetic snap
					</span>
					<input
						type="checkbox"
						className="atb-menu-row__checkbox-input"
						// Undefined (never touched) reads as ON — the default people
						// want nearly all the time — while an explicit false (user
						// unchecked it) is respected.
						checked={options.magnetEnabled !== false}
						onChange={(e) => set("magnetEnabled", e.target.checked)}
					/>
				</label>
			</MenuColumn>

			<MenuDivider />

			<MenuColumn>
				{SCISSORS_OPERATIONS.map((op) => (
					<MenuRow
						key={op.value}
						label={op.label}
						// Reflects `options.operation` directly (not some local
						// "just picked" flag), so re-opening later always shows
						// the operation that's actually active.
						open={op.value === options.operation}
						onClick={() => pickOperation(op.value)}
					/>
				))}
			</MenuColumn>
		</div>
	);
}



/** One icon slot on the ribbon (Brush, Eraser, or a user-pinned tool). The
 *  settings chevron only appears for equip-and-use tools, matching how every
 *  tool's settings are reached everywhere else. The icon itself is looked up
 *  from TOOL_DEFS so that stays the single source of truth for icons. */
function RibbonIcon({
	id, active, disabled, hasSettingsArrow, settingsOpen, onSelect, onToggleSettings,
	registerIconRef,
}: {
	id: EditTool;
	active: boolean;
	disabled: boolean;
	hasSettingsArrow: boolean;
	settingsOpen: boolean;
	onSelect: () => void;
	onToggleSettings: () => void;
	registerIconRef: (el: HTMLButtonElement | null) => void;
}) {
	const info = TOOL_INFO[id];
	const Icon = TOOL_DEFS.find((d) => d.id === id)?.Icon ?? IconBrush;
	return (
		<div
			className="atb__btn-wrap"
		>
			<button
				ref={registerIconRef}
				type="button"
				className={`atb__btn ${active ? "is-active" : ""}`}
				onClick={onSelect}
				aria-label={info.label}
				title={info.label}
				disabled={disabled}
			>
				<Icon size={20} />
			</button>
			{hasSettingsArrow && (
				<button
					type="button"
					className={`atb-pop__arrow ${settingsOpen ? "is-open" : ""}`}
					onClick={onToggleSettings}
					onMouseDown={(event) => event.stopPropagation()}
					aria-label={`${info.label} settings`}
					aria-expanded={settingsOpen}
					disabled={disabled}
				>
					<IconChevronDown size={14} stroke={2.25} />
				</button>
			)}
		</div>
	);
}

/** A row inside the AI / Edit flyouts: tool name and short description. */
function ToolRow({
	id, active, disabled, onSelect, registerRef, pinned, onTogglePin,
}: {
	id: EditTool;
	active: boolean;
	disabled?: boolean;
	onSelect: () => void;
	registerRef: (el: HTMLButtonElement | null) => void;
	pinned: boolean;
	onTogglePin: () => void;
}) {
	const info = TOOL_INFO[id];
	// "grandchild" scope: opening one row's menu must not close the Edit/AI
	// flyout it lives in (which owns the "top" scope).
	const menu = useFlyout(false, { scope: "grandchild" });
	const kebabRef = useRef<HTMLButtonElement | null>(null);
	return (
		<div className="atb-tool-row">
			<button
				ref={registerRef}
				type="button"
				className={`atb-menu-row atb-menu-row--stacked ${active ? "is-active" : ""}`}
				onClick={onSelect}
				disabled={disabled}
				title={disabled ? "This tool needs an existing mask" : undefined}
			>
				<span className="atb-menu-row__label">{info.label}</span>
			</button>
			<button
				ref={kebabRef}
				type="button"
				className={`atb-tool-row__kebab ${menu.open ? "is-open" : ""}`}
				aria-label={`${info.label} options`}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				disabled={disabled}
				onMouseDown={(e) => e.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					menu.anchorRef.current = kebabRef.current;
					menu.setOpen((v) => !v);
				}}
			>
				<IconDotsVertical size={15} />
			</button>
			<FlyoutPanel
				open={menu.open}
				anchorRef={menu.anchorRef}
				panelRef={menu.panelRef}
				placement="right"
				minWidth={170}
				anchorKey={`pin-${id}`}
			>
				<MenuColumn>
					<MenuRow
						label={pinned ? "Unpin from toolbar" : "Pin to toolbar"}
						onClick={() => { onTogglePin(); menu.setOpen(false); }}
						rightSection={pinned ? <IconPin size={14} /> : undefined}
					/>
				</MenuColumn>
			</FlyoutPanel>
		</div>
	);
}

export default function AnnotationToolbar({
	open, disabled, hasActiveTarget, activeTool, onToolChange,
	diameterMm, onDiameterChange, onDiameterPreviewChange, scissorsOptions, onScissorsOptionsChange,
	aiNegative, onAiNegativeChange,
	renderFlyout, scissorsPointCount, onScissorsCancel,
	targetKey, onAiCancel, aiRunBusy, onAiCancelRun,
	onGuidedPickingChange,
	onUndo, onRedo, onSave, saveStatus, saveError, onRetrySave, canUndo, canRedo, isSaving,
	hasTargetSegmentation, structures, colors, activeStructureId, onSelectStructure,
	onCreateStructure, onRenameStructure, onColorChange, onDeleteStructure,
	showOnlyTargetMask, onShowOnlyTargetMaskChange, managedStructureIds,
	visibility, onToggleVisibility,
}: AnnotationToolbarProps) {
	// Keyed to the icon <button> itself (not its wrapper, which also carries
	// the settings chevron) so a settings flyout anchored here centers its
	// pointer on the icon rather than on icon+chevron combined.
	const iconRefs = useRef<Record<string, HTMLElement | null>>({});
	const aiFlyout = useFlyout(false, { scope: "top" });
	const editFlyout = useFlyout(false, { scope: "top" });
	const aiBtnRef = useRef<HTMLButtonElement | null>(null);
	// The Edit button also anchors settings opened from its flyout rows.
	const editBtnRef = useRef<HTMLButtonElement | null>(null);
	// Row <button> per tool inside the Edit flyout, so a tool opened from there
	// can anchor its settings panel under the row that was actually clicked.
	const flyoutRowRefs = useRef<Record<string, HTMLElement | null>>({});
	// local fallback if parent does not control ± toggle
	const [localAiNegative, setLocalAiNegative] = useState(false);
	const aiNegativeEffective = aiNegative ?? localAiNegative;
	const setAiNegativeEffective = (v: boolean) => {
		if (onAiNegativeChange) onAiNegativeChange(v);
		else setLocalAiNegative(v);
	};
	const isAiActive = isAiTool(activeTool);

	const [pinnedTools, setPinnedTools] = useState<string[]>(() => {
		try {
			const stored = localStorage.getItem('bodymaps_pinned_tools');
			if (stored) return JSON.parse(stored);
		} catch {}
		return [];
	});
	// Pinning (spec §6): discoverability moved from an always-visible pin icon
	// on each flyout row to the row's "⋮" menu — the storage key and the
	// between-Edit-and-Undo placement are unchanged.
	const togglePin = (id: EditTool) => {
		setPinnedTools(prev => {
			const next = prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id];
			try { localStorage.setItem('bodymaps_pinned_tools', JSON.stringify(next)); } catch {}
			return next;
		});
	};


	const fieldRef = useRef<HTMLDivElement>(null);
	const panelBodyRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-panel-h (see JSX usage below
	// for why measuring the styled body directly caused runaway growth).
	const panelBodyContentRef = useRef<HTMLDivElement>(null);
	const dockElRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-ribbon-h. Observing the
	// styled dock element itself (which has `min-height: var(--atb-ribbon-h)`)
	// would be self-referential and grow without bound.
	const dockContentRef = useRef<HTMLDivElement>(null);

	// Measures the ribbon's real height into --atb-ribbon-h (consumed by
	// VisualizationPage.css to reserve space above the CT viewport), since a
	// hardcoded value drifts as row contents change.
	// useLayoutEffect so it lands before paint, avoiding a one-frame flash of
	// the CSS fallback height. Math.ceil + 1px pad absorbs sub-pixel rounding.
	useLayoutEffect(() => {
		const el = dockContentRef.current;
		if (!el) return;
		const sync = () => {
			const h = Math.ceil(el.getBoundingClientRect().height) + 1;
			document.documentElement.style.setProperty("--atb-ribbon-h", `${h}px`);
		};
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => ro.disconnect();
		// `open` is a dependency (not `[]`) so this re-runs and picks up the
		// real element once the ribbon actually mounts.
	}, [open]);

	// The per-tool settings panel floats over the viewer (anchored under
	// whichever icon opened it — see `toolFlyout` below), so it never needs
	// to reserve space below the ribbon.
	useEffect(() => {
		document.documentElement.style.setProperty("--atb-panel-h", "0px");
	}, []);

	// Settings flyout — the small rectangle that opens under a tool's arrow.
	// Only one tool's settings are open at a time, always for whichever tool
	// is active. Guided-overlay tools (Grow-from-Seeds, Fill/Copy-Across-
	// Slices) render `keepMounted` (see GUIDED_OVERLAY_TOOLS above), so an
	// outside click here just hides the box without tearing down their state.
	// Mirrored into a ref so the outside-click handler below (created before
	// `guidedControls` state exists in source order) always reads the latest
	// published guided flow.
	const guidedControlsRef = useRef<GuidedFlowControls | null>(null);

	const toolFlyout = useFlyout(false, {
		scope: "top",
		// Outside click = full deselect for most tools. For a guided-overlay
		// tool, route through its own Exit handler so scribbles/anchors/picks
		// get cleared too. LIVE_COMMIT_TOOLS (brush, erase, scissors, level
		// tracing/"smart fill") are the exception: an outside click there
		// should only close the settings flyout — the icon stays selected
		// (white background) because the tool itself is still "live" and
		// ready to paint/cut on the next pointer interaction.
		onOutsideClose: () => {
			if (guidedControlsRef.current) {
				guidedControlsRef.current.onExit();
				return;
			}
			if (activeTool && LIVE_COMMIT_TOOLS.includes(activeTool)) return;
			onToolChange(null);
		},
	});

	// This component stays mounted while the toolbar is toggled off (see
	// `if (!open) return null` further down), so state has to be reset
	// explicitly on close — otherwise the flyout reopens anchored to a
	// stale/detached icon ref, and the active tool stays visually selected.
	useEffect(() => {
		if (open) return;
		// Exit any running guided flow so placed seeds/anchors/picks clear.
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		toolFlyout.anchorRef.current = null;
		setGuidedControls(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Same reset, triggered by the TARGET changing (e.g. clicking a
	// different class) instead of the toolbar closing. Tracked via a ref so
	// this only fires on an actual change, not on first mount.
	const prevTargetKeyRef = useRef(targetKey);
	useEffect(() => {
		if (prevTargetKeyRef.current === targetKey) return;
		prevTargetKeyRef.current = targetKey;
		if (!open) return; // the toolbar-closed effect above already covers this case
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		setGuidedControls(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey, open]);

	const openToolSettings = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!hasActiveTarget || disabled || (!hasTargetSegmentation && tool !== "paint" && tool !== "erase")) return;
		if (activeTool !== tool) onToolChange(tool);
		// Anchor preference: the flyout row that was clicked, then the icon on
		// the ribbon (Brush/Eraser/pinned tools), then the Edit button that
		// opened the flyout in the first place — so the settings panel is never
		// stranded without an anchor.
		toolFlyout.anchorRef.current = flyoutRowRefs.current[tool] ?? iconRefs.current[tool] ?? editBtnRef.current;
		toolFlyout.setOpen(true);
	};


	const enabled = hasActiveTarget && !disabled;
	const pickerColors = colors ?? {};

	// --- Toolbar state machine ------------------------------------------------
	// Everything below renders off this rather than off ad-hoc conditions, so
	// "what shows when" lives in exactly one table (annotationToolbarState.ts):
	// which of the four states we're in, which slots that state exposes, and
	// whether the AI slot reads "AI segment" or "AI refine".
	const toolbarState = deriveToolbarState({ hasActiveTarget, hasTargetSegmentation, activeTool });
	const layout = toolbarLayout(toolbarState, activeTool);
	// A pinned tool that the current state already renders as its own slot
	// (Brush/Eraser while editing) must not be drawn twice.
	const pinnedVisible = layout.pinned
		? pinnedTools.filter((id) => !inlineToolIds(toolbarState).includes(id as EditTool))
		: [];

	/** Pick a tool from either flyout: close the flyout, then arm the tool
	 *  (equip-and-use: brush, eraser, scissors, level tracing, AI prompts) or
	 *  open its settings panel straight away (one-shot tools like Margin or
	 *  Smooth, which are "click once, configure, apply"). */
	const selectFromFlyout = (id: EditTool) => {
		if (!enabled || (!hasTargetSegmentation && !isAiTool(id) && id !== "paint" && id !== "erase")) return;
		aiFlyout.setOpen(false);
		editFlyout.setOpen(false);
		if (LIVE_COMMIT_TOOLS.includes(id)) {
			toolFlyout.setOpen(false);
			onToolChange(id);
			return;
		}
		openToolSettings(id);
	};

	// LIVE_COMMIT_TOOLS (paint/erase/scissors/level tracing) are "equip and
	// use" tools — clicking them just arms the tool, same as before, and they
	// stay equipped until something else is picked. Every other tool
	// (margin, smoothing, islands, logical operators, grow-from-seeds,
	// hollow, fill/copy across slices) is "click once, configure, apply" —
	// clicking the icon should immediately open its settings flyout right
	// there, the same way clicking Margin already opened its column of
	// options, instead of requiring a second click on the little arrow.
	const selectTool = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!enabled) return;
		if (activeTool === tool) {
			// Clicking the already-active tool again toggles it off entirely
			// (and closes whatever settings were open for it). For a guided
			// flow (Grow-from-Seeds, Fill/Copy-Across-Slices, Islands' pick
			// ops) this needs to be a real Exit — not just a deselect — so
			// any placed seeds/anchors/picks are cleared the same way they
			// would be if Exit had been pressed directly, rather than being
			// silently left behind for the next time this tool is opened.
			if (guidedControlsRef.current) { guidedControlsRef.current.onExit(); return; }
			toolFlyout.setOpen(false);
			onToolChange(null);
			return;
		}
		if (LIVE_COMMIT_TOOLS.includes(tool)) {
			toolFlyout.setOpen(false);
			// Arming an AI prompt tool from its pinned ribbon icon also dismisses
			// the AI flyout it may have been picked from.
			if (isAiTool(tool)) aiFlyout.setOpen(false);
			onToolChange(tool);
		} else {
			openToolSettings(tool);
		}
	};

	// Exit / Start over / Continue for whatever guided modal flow
	// (Grow-from-seeds, Copy/Fill-across-slices, Islands' pick ops) is
	// currently running, published up by the tool itself — rendered as
	// fixed black/white buttons in the ribbon below so they're always in
	// the same place regardless of which guided tool is active, instead of
	// each tool floating its own controls over the canvas.
	const [guidedControls, setGuidedControls] = useState<GuidedFlowControls | null>(null);
	useEffect(() => {
		guidedControlsRef.current = guidedControls;
	}, [guidedControls]);
	useEffect(() => {
		onGuidedPickingChange?.(guidedControls != null);
	}, [guidedControls, onGuidedPickingChange]);

	// Small non-blocking hint shown right next to the cursor when Continue
	// is clicked while `continueDisabled` — e.g. "Mark at least one point
	// first" for Grow-from-seeds before any seed scribble exists. Cleared
	// automatically after a beat, and any time the guided flow becomes
	// unblocked or exits.
	const [continueBlockedHint, setContinueBlockedHint] = useState<{ x: number; y: number; message: string } | null>(null);
	const continueBlockedHintTimeoutRef = useRef<number | null>(null);
	useEffect(() => {
		if (!guidedControls?.continueDisabled) setContinueBlockedHint(null);
	}, [guidedControls?.continueDisabled]);
	useEffect(() => () => {
		if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
	}, []);
	useEffect(() => {
		if (!activeTool) setGuidedControls(null);
	}, [activeTool]);

	// Signals "applied" from one-shot tool flyouts — closes settings and
	// clears the tool's active highlight, same as clicking the icon again.
	const handleToolApplied = useCallback(() => {
		toolFlyout.setOpen(false);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onToolChange]);

	const activeDef = activeTool ? TOOL_DEFS.find((t) => t.id === activeTool) : null;
	// Portal straight to <body>: VisualizationPage's root has
	// overflow:hidden, which clips fixed-position descendants' paint.
	if (typeof document === "undefined") return null;
	// Stays mounted always and lets CSS (is-open/is-closed) animate it,
	// instead of `open` gating a hard unmount that couldn't animate out.
	return createPortal(
		<>
		<div className={`atb-shell ${open ? "is-open" : "is-closed"}`} aria-hidden={!open} inert={!open}>
		<div
			ref={dockElRef}
			className={`atb atb--horizontal ${!enabled ? "atb--disabled" : ""}`}
			role="toolbar"
			aria-orientation="horizontal"
		>
			<div ref={dockContentRef} style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", width: "100%" }}>
			{/* Level 1 — exactly the slots the current state exposes, in spec
			    order: structure picker, AI segment, polarity, edit, inline/pinned
			    tools, then history + save. Driven entirely by `layout` above. */}
			<div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 10, width: "100%" }}>
				{/* 1 — Structure picker. */}
				{open && layout.structurePicker && (
					<StructurePicker
						disabled={disabled}
						structures={structures}
						colors={pickerColors}
						activeStructureId={activeStructureId}
						onSelectStructure={onSelectStructure}
						onCreateStructure={onCreateStructure}
						onRenameStructure={onRenameStructure}
						onColorChange={onColorChange}
						onDeleteStructure={onDeleteStructure}
						showOnlyTargetMask={showOnlyTargetMask}
						onShowOnlyTargetMaskChange={onShowOnlyTargetMaskChange}
						managedStructureIds={managedStructureIds}
						visibility={visibility}
						onToggleVisibility={onToggleVisibility}
					/>
				)}

				{/* 2 — AI Segment. One control wearing the label the situation
				    calls for: "AI segment" while the structure is empty,
				    "AI refine" once a mask exists, and — once an option has been
				    picked out of the flyout — the name of that option, so the
				    button reflects what is armed rather than the fact that you
				    intended to refine something. All of them open the same
				    three-option flyout. */}
				{layout.ai && (() => {
					const ai = aiSlotCopy(layout.ai, activeTool);
					const toggleAiFlyout = () => {
						if (!enabled) return;
						if (aiFlyout.open) { aiFlyout.setOpen(false); return; }
						aiFlyout.anchorRef.current = aiBtnRef.current;
						aiFlyout.setOpen(true);
					};
					return (
						<div
							className="atb__btn-wrap"
						>
							<button
								ref={aiBtnRef}
								type="button"
								className={`atb__label-btn ${layout.ai === "start" ? "atb__label-btn--primary" : ""} ${isAiActive ? "is-active" : ""}`}
								aria-haspopup="menu"
								aria-expanded={aiFlyout.open}
								disabled={!enabled}
								onClick={toggleAiFlyout}
							>
								✦ {ai.label} <IconChevronDown size={14} />
							</button>
						</div>
					);
				})()}

				{/* 3 — Polarity. Only while an AI prompt tool is armed (spec §5) —
				    during manual editing Brush/Eraser carry their own implicit
				    polarity, so a separate toggle there is noise. Shift-held
				    flipping is owned by the parent, which is where the value the
				    prompt tools actually read lives. */}
				{layout.polarity && (
					<div className="atb-polarity" role="group" aria-label="Add or remove">
						{([false, true] as const).map((negative) => (
							<button
								key={String(negative)}
								type="button"
								className={`atb-polarity__btn ${aiNegativeEffective === negative ? "is-active" : ""}`}
								onClick={() => setAiNegativeEffective(negative)}
								disabled={disabled}
								aria-pressed={aiNegativeEffective === negative}
							>
								{negative ? "Remove" : "Add"}
							</button>
						))}
					</div>
				)}
				{/* The one control that stays live while a run is in flight. Idle it
				    is the way out of the sticky (equip-and-use) AI tool — same
				    effect as Esc, cancelling any half-drawn outline and deselecting
				    the tool. While the model is working it becomes Stop, because
				    "wait for it and then undo" is the wrong answer to a click that
				    went to the wrong place. */}
				{(isAiActive || aiRunBusy) && (
					<button
						type="button"
						className={`atb__btn atb__btn--ai-cancel ${aiRunBusy ? "is-stop" : ""}`}
						onClick={() => (aiRunBusy ? onAiCancelRun?.() : onAiCancel?.())}
						title={aiRunBusy ? "Stop this AI step (Esc)" : "Cancel AI tool (Esc)"}
						aria-label={aiRunBusy ? "Stop this AI step" : "Cancel AI tool"}
					>
						{aiRunBusy ? <IconPlayerStop size={18} /> : <IconX size={20} />}
					</button>
				)}

				{/* 4 — Edit ▾ (or ⋯ More once editing is already armed). Both open
				    the same Edit flyout. */}
				{(layout.edit || layout.more) && (() => {
					return (
						<button
							ref={editBtnRef}
							type="button"
							className="atb__label-btn"
							aria-haspopup="menu"
							aria-expanded={editFlyout.open}
							disabled={!enabled}
							onClick={() => {
								if (!enabled) return;
								if (editFlyout.open) { editFlyout.setOpen(false); return; }
								editFlyout.anchorRef.current = editBtnRef.current;
								editFlyout.setOpen(true);
							}}
						>
							{layout.more ? "⋯ More" : hasTargetSegmentation ? "Edit tools" : "Draw"} <IconChevronDown size={14} />
						</button>
					);
				})()}

				{/* Inline manual tools while EDITING: the two people actually reach
				    for, with every other tool behind ⋯ More. */}
				{(["paint", "erase"] as const).map((id) => {
					if (!(id === "paint" ? layout.brush : layout.eraser)) return null;
					return (
						<RibbonIcon
							key={id}
							id={id}
							active={activeTool === id}
							disabled={!enabled}
							hasSettingsArrow
							settingsOpen={toolFlyout.open && activeTool === id}
							onSelect={() => selectTool(id)}
							onToggleSettings={() => {
								if (toolFlyout.open && activeTool === id) toolFlyout.setOpen(false);
								else openToolSettings(id);
							}}
							registerIconRef={(el) => { iconRefs.current[id] = el; }}
						/>
					);
				})}

				{/* Pinned tools (spec §6) — between Edit and Undo. The pin itself is
				    reached from each flyout row's ⋮ menu; storage is unchanged. */}
				{pinnedVisible.map((id) => (
					<RibbonIcon
						key={id}
						id={id as EditTool}
						active={activeTool === id}
						disabled={!enabled}
						hasSettingsArrow={LIVE_COMMIT_TOOLS.includes(id as EditTool) && !isAiTool(id as EditTool)}
						settingsOpen={toolFlyout.open && activeTool === id}
						onSelect={() => selectTool(id as EditTool)}
						onToggleSettings={() => {
							if (toolFlyout.open && activeTool === id) toolFlyout.setOpen(false);
							else openToolSettings(id as EditTool);
						}}
						registerIconRef={(el) => { iconRefs.current[id] = el; }}
					/>
				))}

				{(layout.undo || layout.redo || layout.save || layout.finishEditing) && (
					<span className="atb__divider" aria-hidden="true" />
				)}

				{/* 5 — Undo / Redo. Icons only: they're used constantly and a label
				    would eat the ribbon's width. */}
				{layout.undo && (
					<button
						type="button"
						className="atb__btn"
						onClick={() => onUndo()}
						disabled={!canUndo || disabled}
						aria-label={CONTROL_INFO.undo.label}
					>
						<IconArrowBackUp size={20} />
					</button>
				)}
				{layout.redo && (
					<button
						type="button"
						className="atb__btn"
						onClick={() => onRedo()}
						disabled={!canRedo || disabled}
						aria-label={CONTROL_INFO.redo.label}
					>
						<IconArrowForwardUp size={20} />
					</button>
				)}

				{/* Save remains available while the target is being edited. */}
				{layout.save && (
					<>
						<button
							type="button"
							className="atb__label-btn atb__label-btn--primary"
							onClick={() => onSave()}
							disabled={isSaving || saveStatus === "saving" || disabled}
							aria-label={CONTROL_INFO.save.label}
						>
							{isSaving || saveStatus === "saving" ? <IconLoader size={15} className="spin" /> : <IconDeviceFloppy size={15} />}
							Save
						</button>
						{saveStatus === "dirty" && <span className="atb-save-status" role="status">Unsaved</span>}
						{saveStatus === "saved" && <span className="atb-save-status" role="status">Saved</span>}
						{saveStatus === "error" && (
							<span className="atb-save-status atb-save-status--error" role="status" title={saveError}>
								Save failed
								{onRetrySave && <button type="button" className="atb-save-status__retry" onClick={onRetrySave} disabled={disabled || isSaving}>Retry</button>}
							</span>
						)}
					</>
				)}

				{/* Leaves manual editing without saving. */}
				{layout.finishEditing && (
					<button
						type="button"
						className="atb__label-btn"
						onClick={() => onToolChange(null)}
						disabled={disabled}
					>
						Finish editing
					</button>
				)}
			</div>

			{/* Exit / Start over / Continue for the running guided flow
			    (Grow-from-seeds, Copy/Fill-across-slices, Islands) — fixed in
			    the ribbon, not floating over the canvas. No title/label text
			    identifying which guided flow is running is shown here — just
			    the controls themselves (see guidedControlsBoxRef below, used
			    only to anchor the one-time Continue/Start over/Exit explainer
			    popup, not for a visible label). */}
			{guidedControls && (
				<div
					style={{
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						gap: 15,
						marginLeft: 14,
						paddingLeft: 14,
						borderLeft: "1px solid rgba(255, 255, 255, 0.09)",
					}}
				>
					{/* Local, self-contained keyframes for the Continue button's
					    glow-pulse below — kept here rather than in the shared
					    stylesheet since it's only ever used by this one button. */}
					<style>{`
						@keyframes seg-effect-continue-pulse {
							0% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0.55); }
							70% { box-shadow: 0 0 0 8px rgba(104, 172, 229, 0); }
							100% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0); }
						}
					`}</style>

					{guidedControls.busy ? (
						// Once the commit is running there's nothing left to cancel
						// or restart, so swap to the same pulsing-dot indicator.
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								fontSize: 11.5,
								fontWeight: 700,
								color: "rgba(255,255,255,0.75)",
								whiteSpace: "nowrap",
							}}
						>
							<span
								aria-hidden="true"
								style={{
									width: 7,
									height: 7,
									borderRadius: "50%",
									background: "var(--jhu-blue-accent, #68ACE5)",
									animation: "seg-effect-render-pulse 0.9s ease-in-out infinite",
								}}
							/>
							Applying…
						</span>
					) : (
						<>
							{/* Continue is shown whenever the guided flow provides a
							    handler for it (e.g. Grow from Seeds), always alongside
							    Start over and Exit. It stays clickable-looking but is
							    only actually enabled once `continueDisabled` clears
							    (e.g. after at least one seed point is marked) — a
							    click while still blocked doesn't call onContinue, it
							    just surfaces a small hint near the cursor instead. */}
							{guidedControls.onContinue && (
								<button
									type="button"
									onClick={(e) => {
										if (guidedControls.continueDisabled) {
											if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
											setContinueBlockedHint({
												x: e.clientX,
												y: e.clientY,
												message: guidedControls.continueHint || "Mark at least one point first",
											});
											continueBlockedHintTimeoutRef.current = window.setTimeout(() => setContinueBlockedHint(null), 1800);
											return;
										}
										guidedControls.onContinue?.();
									}}
									disabled={!!guidedControls.continueDisabled || !!disabled}
									className="atb-guided__btn atb-guided__btn--continue"
									style={{
										animation: guidedControls.continueDisabled ? undefined : "seg-effect-continue-pulse 1.6s ease-in-out infinite",
										opacity: guidedControls.continueDisabled ? 0.5 : 1,
										cursor: guidedControls.continueDisabled ? "default" : "pointer",
									}}
								>
									{guidedControls.continueLabel || "Continue"}
								</button>
							)}
							<button
								type="button"
								onClick={guidedControls.onStartOver}
								className="atb-guided__btn atb-guided__btn--startover"
							>
								Start over
							</button>
							<button
								type="button"
								onClick={guidedControls.onExit}
								className="atb-guided__btn atb-guided__btn--exit"
							>
								Exit
							</button>
						</>
					)}
				</div>
			)}

			</div>{/* /dockContentRef */}
		</div>

			<FlyoutPanel
				open={enabled && !!activeTool && !!activeDef && toolFlyout.open}
				anchorRef={toolFlyout.anchorRef}
				panelRef={toolFlyout.panelRef}
				placement="below"
				// 200 matches MenuColumn's natural floor + panel padding, so
				// short one-shot flyouts (e.g. Smoothing) shrink to fit instead
				// of using a flat width regardless of content.
				minWidth={200}
				// Forces a reposition when settings reopen for a different tool
				// icon, so the panel doesn't stay glued under the previous one.
				anchorKey={activeTool}
				// Guided-overlay tools (GrowFromSeeds, Copy/FillAcrossSlices,
				// Islands) close settings the instant their overlay takes over
				// picking; keepMounted stops that from unmounting the picker
				// state and its body-portaled overlay. The tool itself still
				// unmounts normally when deselected (activeDef goes null).
				keepMounted
			>
				{activeDef && (
					<div
						ref={panelBodyRef}
						className="atb-corner-panel atb-corner-panel--floating"
					>
						<div className="atb-corner-panel__body">
							{/* Measured for --atb-panel-h. Deliberately unstyled — observing
							    the body div directly (which has min-height: var(--atb-panel-h))
							    would be self-referential and grow without bound. */}
							<div ref={panelBodyContentRef} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "inherit", flexWrap: "inherit" }}>
								<div ref={fieldRef}>
									{(activeTool === "paint" || activeTool === "erase") && (
										// NumberSliderField's own `label` prop already shows
										// "Brush"/"Erase" above the slider.
										<DiameterFlyout
											title={activeTool === "paint" ? "Brush Size" : "Eraser Size"}
											diameterMm={diameterMm}
											onDiameterChange={onDiameterChange}
											onPreviewChange={onDiameterPreviewChange}
										/>
									)}
									{activeTool === "scissors" && (
										<ScissorsFlyout
											options={scissorsOptions}
											onChange={onScissorsOptionsChange}
											pointCount={scissorsPointCount}
											onCancel={onScissorsCancel}
											onCloseSettings={() => toolFlyout.setOpen(false)}
										/>
									)}
									{activeTool && !["paint", "erase", "scissors", "pointSegment", "boxSegment", "lassoSegment", "scribbleSegment"].includes(activeTool) && renderFlyout(activeTool, handleToolApplied, () => toolFlyout.setOpen(false), setGuidedControls)}
								</div>
							</div>
						</div>
					</div>
				)}
			</FlyoutPanel>
			{/* AI segment flyout (spec §2): exactly three options, each described in
			    plain English. No internal model/implementation names anywhere. */}
			<FlyoutPanel
				open={enabled && aiFlyout.open}
				anchorRef={aiFlyout.anchorRef}
				panelRef={aiFlyout.panelRef}
				placement="below"
				minWidth={260}
				anchorKey="__ai"
			>
				<div className="atb-flyout__col atb-flyout__col--menu">
					<div className="atb-menu-section">Segment with AI</div>
					<MenuColumn>
						{AI_FLYOUT_OPTIONS.map((id) => (
							<ToolRow
								key={id}
								id={id}
								active={activeTool === id}
								onSelect={() => selectFromFlyout(id)}
								registerRef={(el) => { flyoutRowRefs.current[id] = el; }}
								pinned={pinnedTools.includes(id)}
								onTogglePin={() => togglePin(id)}
							/>
						))}
					</MenuColumn>
				</div>
			</FlyoutPanel>

			{/* Edit flyout (spec §3): Basic / Advanced / Across slices, with the
			    long tail behind a collapsed More section. */}
			<FlyoutPanel
				open={enabled && editFlyout.open}
				anchorRef={editFlyout.anchorRef}
				panelRef={editFlyout.panelRef}
				placement="below"
				minWidth={280}
				anchorKey="__edit"
			>
				<div className="atb-flyout__col atb-flyout__col--menu">
					{EDIT_SECTIONS.map((section) => {
						const availableTools = section.tools.filter((id) =>
							hasTargetSegmentation || id === "paint" || id === "erase",
						);
						if (availableTools.length === 0) return null;
						const rows = (
							<MenuColumn>
								{availableTools.map((id) => (
									<ToolRow
										key={id}
										id={id}
										active={activeTool === id}
										onSelect={() => selectFromFlyout(id)}
										registerRef={(el) => { flyoutRowRefs.current[id] = el; }}
										pinned={pinnedTools.includes(id)}
										onTogglePin={() => togglePin(id)}
									/>
								))}
							</MenuColumn>
						);
						if (section.collapsed) {
							return (
								<GrandchildRow key={section.title} label={section.title}>
									{rows}
								</GrandchildRow>
							);
						}
						return (
							<div key={section.title} className="atb-flyout__section atb-flyout__section--tight">
								<div className="atb-menu-section">{section.title}</div>
								{rows}
							</div>
						);
					})}
				</div>
			</FlyoutPanel>
		</div>{/* /.atb-shell */}

		{/* Small blue rectangle pinned near the cursor when Continue is
		    clicked while the guided flow still has nothing to continue
		    with (e.g. no seed point marked yet). Same visual language as
		    SliceAnchorPickerUI's PickErrorHint, kept local here since this
		    fires from the ribbon's Continue button, not from a canvas
		    click. */}
		{continueBlockedHint && (
			<div
				role="alert"
				style={{
					position: "fixed",
					left: Math.max(12, Math.min(continueBlockedHint.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - 260)),
					top: Math.max(12, Math.min(continueBlockedHint.y + 14, (typeof window !== "undefined" ? window.innerHeight : 768) - 60)),
					zIndex: 1300,
					pointerEvents: "none",
					maxWidth: 240,
					padding: "8px 12px",
					borderRadius: 10,
					background: "#002d72",
					border: "1px solid rgba(255, 255, 255, 0.25)",
					color: "#ffffff",
					fontSize: 12.5,
					fontWeight: 600,
					lineHeight: 1.35,
					fontFamily: "\"Space Grotesk\", system-ui, sans-serif",
					boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
				}}
			>
				{continueBlockedHint.message}
			</div>
		)}

		</>,
		document.body
	);
}
