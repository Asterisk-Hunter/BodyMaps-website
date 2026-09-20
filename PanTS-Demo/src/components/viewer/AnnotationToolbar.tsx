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
	IconCheck,
	IconLoader,
} from "@tabler/icons-react";
import "./AnnotationToolbar.css";
import NumberSliderField from "../NumberSliderField";
import { FlyoutArrow, FlyoutPanel, GrandchildRow, MenuColumn, MenuRow, MenuDivider, useFlyout } from "./FlyoutPrimitives";
import type { GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";
import AnnotationOnboarding from "./AnnotationOnboarding";
import {
	AI_FLYOUT_OPTIONS,
	CONTROL_INFO,
	EDIT_SECTIONS,
	ONBOARDING_STEPS,
	TOOL_INFO,
	aiSlotCopy,
	deriveToolbarState,
	hasCompletedOnboarding,
	inlineToolIds,
	isAiTool,
	markOnboardingComplete,
	toolbarLayout,
	type EditTool,
	type TooltipInfo,
} from "./annotationToolbarState";

// sessionStorage key for the guided-flow (Continue / Start over / Exit)
// explainer. Session-scoped on purpose so it re-appears on a fresh page load
// rather than only ever once per browser.
// Guided-flow (Continue / Start over / Exit) explainer. Each guided tool
// (Grow from Seeds, Copy across slices, Fill between slices, Islands) gets
// its OWN "seen" flag — so seeing the explainer for one doesn't suppress it
// for the others — even though several of them share the same wording.
const GUIDED_HINT_SEEN_KEY_PREFIX = "mm_annotation_guided_hint_seen_";

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
	canUndo: boolean;
	canRedo: boolean;
	isSaving: boolean;

	// ------------------------------------------------------------------
	// Toolbar state machine inputs (see annotationToolbarState.ts)
	// ------------------------------------------------------------------
	/** Whether the currently targeted structure already contains mask voxels.
	 *  Together with `hasActiveTarget` and `activeTool` this decides which of
	 *  the four toolbar states renders — and therefore whether the AI slot
	 *  reads "Start segmentation" or "Refine", and whether Edit/Undo/Save are
	 *  on the ribbon at all. */
	hasTargetSegmentation: boolean;

	// ------------------------------------------------------------------
	// Structure picker
	// ------------------------------------------------------------------
	/** Structures the Level 1 picker offers: the catalog organs present in this
	 *  scan plus any custom classes. The right-hand class panel is untouched —
	 *  this is a compact mirror of the same selection. */
	structures: { id: number; label: string }[];
	activeStructureId: number | null;
	onSelectStructure: (id: number | null) => void;

	/** The pencil/Annotate button in the main toolbar (VisualizationPage)
	 *  that opens this ribbon. The ribbon itself renders as a centered
	 *  popout regardless of where that button sits, but this ref lets it
	 *  draw a small pointer arrow back up to the button — see the
	 *  pointer-tracking effect below and .atb--horizontal__pointer. */
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
// Hover tooltips wait this long before appearing (spec §8) so sweeping the
// mouse across the ribbon doesn't strobe cards on every icon it passes over.
const TOOLTIP_DELAY_MS = 300;

/** Cheap rect equality — lets the onboarding spotlight re-measure on a timer
 *  without re-rendering the ribbon on every tick where nothing has moved. */
function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
	if (!a || !b) return a === b;
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}
const MAX_DIAMETER_MM = 40;

// Which "explain Continue / Start over / Exit" message a guided tool falls
// under. Grow from Seeds gets its own copy; the slice-range tools (Copy/Fill
// across slices) and Islands' pick-based ops (Remove picked/Keep picked)
// all drive the exact same three controls, so they share one message keyed
// off a single "seen" flag rather than repeating the popup three times.
type GuidedHintGroup = "growSeeds" | "sliceOps";
function guidedHintGroup(tool: PrimaryEditTool): GuidedHintGroup | null {
	if (tool === "growFromSeeds") return "growSeeds";
	if (tool === "copyAcrossSlices" || tool === "fillBetweenSlices" || tool === "islands") return "sliceOps";
	return null;
}
const GUIDED_HINT_COPY: Record<GuidedHintGroup, string> = {
	growSeeds:
		"Continue moves on once you've placed your seed scribbles. Start over clears every seed and lets you begin again. Exit leaves Grow from Seeds without changing anything.",
	sliceOps:
		"Start over clears any choices made and lets you pick again. Exit leaves the tool without changing anything.",
};

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



// Portal-rendered tooltip — rendered to document.body and positioned via
// getBoundingClientRect of the hovered icon, so it's never clipped by the
// dock's own overflow:hidden/auto rules.
function IconTooltip({
	info, anchorRect,
}: {
	/** The full tooltip contract — name, what it does, when to use it, and a
	 *  real key binding when one exists (spec §8). */
	info: TooltipInfo;
	anchorRect: DOMRect | null;
}) {
	if (!anchorRect) return null;
	// Tooltip is centered above its icon by default (so it reads as an
	// annotation on the icon rather than colliding with whatever settings
	// flyout opens below the ribbon), but that puts it offscreen for icons
	// near either edge (Brush on the left, Hollow on the right) — clamp the
	// center point so the box (max-width 240) always stays fully within the
	// viewport, with a small margin.
	const halfWidth = 120;
	const margin = 8;
	const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
	const idealCenter = anchorRect.left + anchorRect.width / 2;
	const clampedCenter = Math.min(
		Math.max(idealCenter, halfWidth + margin),
		viewportWidth - halfWidth - margin
	);
	
	const goesBelow = anchorRect.top < 140;
	const topPos = goesBelow ? anchorRect.bottom + 10 : anchorRect.top - 10;
	const transformY = goesBelow ? "0" : "-100%";

	return createPortal(
		<div
			style={{
				position: "fixed",
				top: topPos,
				left: clampedCenter,
				transform: `translate(-50%, ${transformY})`,
				background: "#fff",
				color: "#111",
				borderRadius: 8,
				padding: "8px 10px",
				minWidth: 180,
				maxWidth: 260,
				boxShadow: "0 8px 24px -6px rgba(0,0,0,0.45)",
				zIndex: 500,
				pointerEvents: "none",
				fontFamily: "system-ui, sans-serif",
				whiteSpace: "normal",
			}}
		>
			<div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 3 }}>{info.label}</div>
			<div style={{ fontSize: 11.5, lineHeight: 1.4, color: "#333" }}>{info.what}</div>
			<div style={{ fontSize: 11.5, lineHeight: 1.4, color: "#555", marginTop: 3 }}>
				Use when: {info.useWhen}
			</div>
			{info.shortcut && (
				<div style={{ fontSize: 11, lineHeight: 1.4, color: "#002d72", fontWeight: 700, marginTop: 5 }}>
					Shortcut: {info.shortcut}
				</div>
			)}
		</div>,
		document.body
	);
}

/** One icon slot on the ribbon (Brush, Eraser, or a user-pinned tool). The
 *  settings chevron only appears for equip-and-use tools, matching how every
 *  tool's settings are reached everywhere else. The icon itself is looked up
 *  from TOOL_DEFS so that stays the single source of truth for icons. */
function RibbonIcon({
	id, active, disabled, hasSettingsArrow, settingsOpen, onSelect, onToggleSettings,
	onHover, onLeave, registerIconRef,
}: {
	id: EditTool;
	active: boolean;
	disabled: boolean;
	hasSettingsArrow: boolean;
	settingsOpen: boolean;
	onSelect: () => void;
	onToggleSettings: () => void;
	onHover: (el: HTMLElement) => void;
	onLeave: () => void;
	registerIconRef: (el: HTMLButtonElement | null) => void;
}) {
	const info = TOOL_INFO[id];
	const Icon = TOOL_DEFS.find((d) => d.id === id)?.Icon ?? IconBrush;
	return (
		<div
			className="atb__btn-wrap"
			onMouseEnter={(e) => onHover(e.currentTarget)}
			onMouseLeave={onLeave}
		>
			<button
				ref={registerIconRef}
				type="button"
				className={`atb__btn ${active ? "is-active" : ""}`}
				onClick={onSelect}
				aria-label={info.label}
				aria-disabled={disabled}
				onFocus={(e) => onHover(e.currentTarget.parentElement ?? e.currentTarget)}
				onBlur={onLeave}
			>
				<Icon size={20} />
			</button>
			{hasSettingsArrow && (
				<FlyoutArrow open={settingsOpen} onClick={onToggleSettings} label={`${info.label} settings`} />
			)}
		</div>
	);
}

/** A row inside the AI / Edit flyouts: tool name plus the one-line
 *  plain-English description the redesign asks for, a trailing ⋮ menu, and
 *  the full tooltip on hover. Two-line by design — "no icon-only labels"
 *  means the explanation lives on the row rather than behind a hover. */
function ToolRow({
	id, active, onSelect, onHover, onLeave, registerRef, pinned, onTogglePin,
}: {
	id: EditTool;
	active: boolean;
	onSelect: () => void;
	onHover: (el: HTMLElement) => void;
	onLeave: () => void;
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
				onMouseEnter={(e) => onHover(e.currentTarget)}
				onMouseLeave={onLeave}
				onFocus={(e) => onHover(e.currentTarget)}
				onBlur={onLeave}
			>
				<span className="atb-menu-row__label">{info.label}</span>
				<span className="atb-tool-row__desc">{info.what}</span>
			</button>
			<button
				ref={kebabRef}
				type="button"
				className={`atb-tool-row__kebab ${menu.open ? "is-open" : ""}`}
				aria-label={`${info.label} options`}
				aria-haspopup="menu"
				aria-expanded={menu.open}
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
	open, disabled, hasSegments, hasActiveTarget, activeTool, onToolChange,
	diameterMm, onDiameterChange, onDiameterPreviewChange, scissorsOptions, onScissorsOptionsChange,
	aiNegative, onAiNegativeChange,
	renderFlyout, scissorsPointCount, onScissorsCancel,
	targetKey, onAiCancel, aiRunBusy, onAiCancelRun,
	onGuidedPickingChange, anchorRef,
	onUndo, onRedo, onSave, canUndo, canRedo, isSaving,
	hasTargetSegmentation, structures, activeStructureId, onSelectStructure,
}: AnnotationToolbarProps) {
	// Single tooltip slot. Every hoverable control in the ribbon — icons, the
	// structure picker, flyout rows, the polarity toggle — funnels through
	// scheduleTooltip, so there is exactly one card on screen and one timer
	// driving it, and a 300ms delay applies uniformly (spec §8).
	const [tooltip, setTooltip] = useState<{ info: TooltipInfo; rect: DOMRect } | null>(null);
	const tooltipTimerRef = useRef<number | null>(null);
	const tooltipKeyRef = useRef<string | null>(null);
	const scheduleTooltip = useCallback((key: string, info: TooltipInfo, el: HTMLElement | null, immediate = false) => {
		if (tooltipTimerRef.current != null) { window.clearTimeout(tooltipTimerRef.current); tooltipTimerRef.current = null; }
		tooltipKeyRef.current = key;
		if (!el) return;
		const show = () => {
			// Guard against a stale timer firing after the pointer moved on.
			if (tooltipKeyRef.current !== key) return;
			setTooltip({ info, rect: el.getBoundingClientRect() });
		};
		if (immediate) { show(); return; }
		tooltipTimerRef.current = window.setTimeout(show, TOOLTIP_DELAY_MS);
	}, []);
	const cancelTooltip = useCallback((key: string) => {
		if (tooltipKeyRef.current !== key) return;
		tooltipKeyRef.current = null;
		if (tooltipTimerRef.current != null) { window.clearTimeout(tooltipTimerRef.current); tooltipTimerRef.current = null; }
		setTooltip(null);
	}, []);
	useEffect(() => () => {
		if (tooltipTimerRef.current != null) window.clearTimeout(tooltipTimerRef.current);
	}, []);
	// Keyed to the icon <button> itself (not its wrapper, which also carries
	// the settings chevron) so a settings flyout anchored here centers its
	// pointer on the icon rather than on icon+chevron combined.
	const iconRefs = useRef<Record<string, HTMLElement | null>>({});
	const aiFlyout = useFlyout(false, { scope: "top" });
	const structureFlyout = useFlyout(false, { scope: "top" });
	const editFlyout = useFlyout(false, { scope: "top" });
	const aiBtnRef = useRef<HTMLButtonElement | null>(null);
	const aiWrapRef = useRef<HTMLDivElement | null>(null);
	// Level 1 control refs. Both double as the anchor for their own flyout and
	// as the fallback anchor for a tool's settings panel when the tool was
	// picked from a flyout row rather than from an icon on the ribbon.
	const structBtnRef = useRef<HTMLButtonElement | null>(null);
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


	// "Explain Continue/Start over/Exit" — shown the first time a guided flow
	// (Grow from Seeds, Copy/Fill-across-slices, Islands' pick ops) actually
	// surfaces those controls, once per flow family per session.
	const [guidedHintOpen, setGuidedHintOpen] = useState(false);
	const [guidedHintRect, setGuidedHintRect] = useState<DOMRect | null>(null);
	const [guidedHintText, setGuidedHintText] = useState<string>("");
	const guidedControlsBoxRef = useRef<HTMLDivElement>(null);
	const prevGuidedControlsRef = useRef<GuidedFlowControls | null>(null);

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

	// Pointer-arrow tracking — keeps the little up-chevron
	// (.atb--horizontal__pointer) aligned under the pencil button and just
	// above the ribbon, regardless of where the screen-centered ribbon or
	// the button end up (window resizes, sidebar open/close reflowing the
	// main toolbar, etc). Stored as fixed viewport coordinates (not an
	// offset within the ribbon) since the chevron is rendered as a sibling
	// of the ribbon — see the render comment below for why. `null` hides
	// the chevron entirely rather than falling back to a guessed position,
	// since a wrong guess would point at nothing.
	// Size of the little rotated-square notch below, so the position math
	// and the CSS agree on how far it should straddle the ribbon's own
	// top border (half on each side, same technique FlyoutPrimitives uses
	// for `.atb-pop__pointer`).
	const POINTER_NOTCH_SIZE = 13;
	const [pointerPos, setPointerPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const sync = () => {
			const anchorEl = anchorRef?.current;
			const ribbonEl = dockElRef.current;
			if (!anchorEl || !ribbonEl) { setPointerPos(null); return; }
			const anchorRect = anchorEl.getBoundingClientRect();
			const ribbonRect = ribbonEl.getBoundingClientRect();
			const anchorCenterX = anchorRect.left + anchorRect.width / 2;
			// Clamped inside the ribbon's own horizontal bounds (with a
			// little inset) so a pencil button sitting far to one side
			// never pushes the notch off the ribbon's rounded corner.
			const left = Math.min(
				Math.max(anchorCenterX, ribbonRect.left + 14),
				ribbonRect.right - 14,
			);
			// Sits ON the ribbon's own top border (straddling it, half
			// above/half below) rather than floating free in the gap
			// above the ribbon — this is what actually reads as "grown
			// out of the ribbon" the way FlyoutPanel's own pointer grows
			// out of a settings flyout, instead of a separate decoration
			// hovering between the button and the ribbon with visible
			// space on both sides.
			setPointerPos({ left, top: ribbonRect.top - POINTER_NOTCH_SIZE / 2 });
		};
		sync();
		window.addEventListener("resize", sync);
		// Anchor and ribbon can both move without a window resize (e.g. the
		// AI sidebar toggling shifts the main toolbar's layout), so re-check
		// on any observed size change of either element too.
		const ro = new ResizeObserver(sync);
		if (anchorRef?.current) ro.observe(anchorRef.current);
		if (dockElRef.current) ro.observe(dockElRef.current);
		return () => {
			window.removeEventListener("resize", sync);
			ro.disconnect();
		};
	}, [open, anchorRef]);

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
		setTooltip(null);
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
		setTooltip(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey, open]);

	const openToolSettings = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!hasSegments || !hasActiveTarget) return;
		if (activeTool !== tool) onToolChange(tool);
		// Anchor preference: the flyout row that was clicked, then the icon on
		// the ribbon (Brush/Eraser/pinned tools), then the Edit button that
		// opened the flyout in the first place — so the settings panel is never
		// stranded without an anchor.
		toolFlyout.anchorRef.current = flyoutRowRefs.current[tool] ?? iconRefs.current[tool] ?? editBtnRef.current;
		toolFlyout.setOpen(true);
	};


	// --- Onboarding (spec §7) -------------------------------------------------
	// First run only, tracked in localStorage. The tour is deliberately
	// non-blocking: steps 1-3 point at real work the person does while the card
	// is up (pick a structure, run AI, brush/erase), so each step advances off
	// that interaction instead of off a Next click.
	const [onboardingStep, setOnboardingStep] = useState<number | null>(() => (
		typeof window !== "undefined" && !hasCompletedOnboarding() ? 0 : null
	));
	const [onboardingRect, setOnboardingRect] = useState<DOMRect | null>(null);
	const onboardingTarget = onboardingStep == null ? null : ONBOARDING_STEPS[onboardingStep]?.target ?? null;

	const finishOnboarding = useCallback(() => {
		setOnboardingStep(null);
		markOnboardingComplete();
	}, []);
	const advanceOnboarding = () => {
		if (onboardingStep == null) return;
		if (onboardingStep >= ONBOARDING_STEPS.length - 1) { finishOnboarding(); return; }
		setOnboardingStep(onboardingStep + 1);
	};

	// Step 1 -> 2: a structure was selected from the picker.
	useEffect(() => {
		if (onboardingStep === 0 && hasActiveTarget) setOnboardingStep(1);
	}, [onboardingStep, hasActiveTarget]);
	// Step 2 -> 3: AI ran (or any edit) and the structure now has a mask.
	useEffect(() => {
		if (onboardingStep === 1 && hasTargetSegmentation) setOnboardingStep(2);
	}, [onboardingStep, hasTargetSegmentation]);
	// Step 3 points at Brush and Eraser, which in SEGMENTATION_EXISTS live in
	// the Edit flyout rather than on the ribbon — so open it for the duration
	// of the step. (The state table itself is untouched: this only changes what
	// happens to be open behind the card.)
	useEffect(() => {
		if (onboardingStep !== 2 || editFlyout.open) return;
		editFlyout.anchorRef.current = editBtnRef.current;
		editFlyout.setOpen(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onboardingStep, editFlyout.open]);
	// Step 3 -> 4: they actually used one of the two tools.
	useEffect(() => {
		if (onboardingStep === 2 && (activeTool === "paint" || activeTool === "erase")) setOnboardingStep(3);
	}, [onboardingStep, activeTool]);
	// Step 4 is the text-only wrap-up, and it talks about Save — put the
	// ribbon back in its normal, unobstructed shape for it.
	useEffect(() => {
		if (onboardingStep === 3) editFlyout.setOpen(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onboardingStep]);

	// Live rect for whatever the current step highlights. Re-measured on a
	// short interval (plus resize/scroll) because there is no single event that
	// fires when the ribbon re-renders into a new state or when a flyout
	// finishes positioning itself. Identical rects are dropped so the interval
	// doesn't re-render the ribbon twice a second.
	useLayoutEffect(() => {
		if (!open || onboardingTarget == null) { setOnboardingRect(null); return; }
		const measure = () => {
			let next: DOMRect | null = null;
			if (onboardingTarget === "structurePicker") {
				next = structBtnRef.current?.getBoundingClientRect() ?? null;
			} else if (onboardingTarget === "aiSegment") {
				next = aiBtnRef.current?.getBoundingClientRect() ?? null;
			} else {
				// Brush + Eraser: the union of their two rows, falling back to the
				// inline ribbon icons once editing has actually been armed.
				const rects = (["paint", "erase"] as EditTool[])
					.map((t) => (flyoutRowRefs.current[t] ?? iconRefs.current[t])?.getBoundingClientRect())
					.filter((r): r is DOMRect => !!r);
				if (rects.length) {
					const top = Math.min(...rects.map((r) => r.top));
					const left = Math.min(...rects.map((r) => r.left));
					const right = Math.max(...rects.map((r) => r.right));
					const bottom = Math.max(...rects.map((r) => r.bottom));
					next = new DOMRect(left, top, right - left, bottom - top);
				}
			}
			setOnboardingRect((prev) => (sameRect(prev, next) ? prev : next));
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 250);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [open, onboardingTarget, activeTool, pinnedTools]);

	const enabled = hasSegments && hasActiveTarget && !disabled;

	// --- Toolbar state machine ------------------------------------------------
	// Everything below renders off this rather than off ad-hoc conditions, so
	// "what shows when" lives in exactly one table (annotationToolbarState.ts):
	// which of the four states we're in, which slots that state exposes, and
	// whether the AI slot reads "Start segmentation" or "Refine".
	const toolbarState = deriveToolbarState({ hasActiveTarget, hasTargetSegmentation, activeTool });
	const layout = toolbarLayout(toolbarState, activeTool);
	const activeStructureLabel = structures.find((s) => s.id === activeStructureId)?.label ?? null;
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
		if (!enabled) return;
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

	// Fires once, on the null -> present transition (not on every re-render
	// while a flow is already running), the first time this session that a
	// given guided-flow family actually shows its Continue/Start over/Exit
	// controls. Skipped while `busy` — those controls aren't on screen yet
	// (see the `guidedControls.busy` branch in the render below).
	useEffect(() => {
		const wasPresent = prevGuidedControlsRef.current;
		prevGuidedControlsRef.current = guidedControls;
		if (wasPresent || !guidedControls || guidedControls.busy) return;
		const group = guidedHintGroup(activeTool);
		if (!group || !activeTool) return;
		// Per-tool key (not per-group) — Grow from Seeds having been seen
		// shouldn't suppress the explainer for Copy across slices, Fill
		// between slices, or Islands, and vice versa between those three.
		const seenKey = `${GUIDED_HINT_SEEN_KEY_PREFIX}${activeTool}`;
		let alreadySeen = false;
		try {
			alreadySeen = typeof window !== "undefined" && window.sessionStorage.getItem(seenKey) === "1";
		} catch { /* sessionStorage unavailable — just show it */ }
		if (alreadySeen) return;
		setGuidedHintText(GUIDED_HINT_COPY[group]);
		setGuidedHintOpen(true);
		try {
			if (typeof window !== "undefined") window.sessionStorage.setItem(seenKey, "1");
		} catch { /* not worth blocking on */ }
	}, [guidedControls, activeTool]);

	// Once the flow's controls go away (tool exited/deselected) or flip into
	// `busy` (buttons swap for the "Applying…" indicator), the hint no
	// longer has anything to point at, so close it automatically.
	useEffect(() => {
		if (!guidedControls || guidedControls.busy) setGuidedHintOpen(false);
	}, [guidedControls]);

	useLayoutEffect(() => {
		if (!guidedHintOpen) return;
		const measure = () => setGuidedHintRect(guidedControlsBoxRef.current ? guidedControlsBoxRef.current.getBoundingClientRect() : null);
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200); // controls sit in a fixed ribbon, but keep parity with the other live-measured hints
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [guidedHintOpen]);

	const dismissGuidedHint = useCallback(() => setGuidedHintOpen(false), []);

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
		{/* Connects the ribbon back to the pencil button that opened it —
			now built the exact same way FlyoutPanel connects its own
			settings panels to the icon/row that spawned them (see
			`.atb-pop__pointer` in FlyoutPrimitives.css): a small square,
			rotated 45°, colored and bordered to match the ribbon itself,
			straddling the ribbon's own top edge so it visibly grows out
			of the ribbon's shape instead of floating as a separate glyph
			in the gap above it (which is what the plain IconChevronUp
			here used to do, and why it never read as "connected").

			Rendered as a SIBLING of `.atb-shell` (not a descendant of it)
			for the same reason as before: `.atb-shell` carries a CSS
			`transform` for its open/close slide + centering, and per spec
			any transformed ancestor becomes the containing block for its
			`position: fixed` descendants — a notch nested inside it would
			have its "fixed" left/top resolved against the shell's own
			box, not the viewport, even though pointerPos below is real
			viewport coordinates from getBoundingClientRect(). Only
			rendered once we have a real measured position, so it never
			flashes at a wrong default location. */}
		{pointerPos !== null && (
			<div
				className="atb--horizontal__pointer"
				style={{ left: pointerPos.left, top: pointerPos.top }}
				aria-hidden="true"
			/>
		)}
		<div className={`atb-shell ${open ? "is-open" : "is-closed"}`}>
		<div
			ref={dockElRef}
			className={`atb atb--horizontal ${!enabled ? "atb--disabled" : ""}`}
			role="toolbar"
			aria-orientation="horizontal"
		>
			<div ref={dockContentRef} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
			{/* Level 1 — exactly the slots the current state exposes, in spec
			    order: structure picker, AI segment, polarity, edit, inline/pinned
			    tools, then history + save. Driven entirely by `layout` above. */}
			<div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
				{/* 1 — Structure picker. The only control NO_STRUCTURE_SELECTED
				    renders, and what onboarding step 1 spotlights. */}
				{layout.structurePicker && (
					<div className="atb-struct">
						<button
							ref={structBtnRef}
							type="button"
							className={`atb-struct__btn ${activeStructureLabel ? "" : "is-placeholder"}`}
							aria-haspopup="menu"
							aria-expanded={structureFlyout.open}
							onClick={() => {
								if (structureFlyout.open) { structureFlyout.setOpen(false); return; }
								structureFlyout.anchorRef.current = structBtnRef.current;
								structureFlyout.setOpen(true);
							}}
							onMouseEnter={(e) => scheduleTooltip("__structure", CONTROL_INFO.structurePicker, e.currentTarget)}
							onMouseLeave={() => cancelTooltip("__structure")}
							onFocus={(e) => scheduleTooltip("__structure", CONTROL_INFO.structurePicker, e.currentTarget, true)}
							onBlur={() => cancelTooltip("__structure")}
						>
							<span className="atb-struct__label">{activeStructureLabel ?? "Select structure"}</span>
							<IconChevronDown size={14} stroke={2.25} />
						</button>
					</div>
				)}

				{/* 2 — AI Segment. One control wearing the label the situation
				    calls for: "Start segmentation" while the structure is empty,
				    "Refine" once a mask exists, and — once an option has been
				    picked out of the flyout — the name of that option, so the
				    button reflects what is armed rather than the fact that you
				    intended to refine something. All of them open the same
				    three-option flyout. */}
				{layout.ai && (() => {
					const ai = aiSlotCopy(layout.ai, activeTool);
					const info = ai.info;
					const toggleAiFlyout = () => {
						if (!enabled) return;
						if (aiFlyout.open) { aiFlyout.setOpen(false); return; }
						aiFlyout.anchorRef.current = aiBtnRef.current;
						aiFlyout.setOpen(true);
					};
					return (
						<div
							ref={aiWrapRef}
							className="atb__btn-wrap"
							onMouseEnter={(e) => scheduleTooltip("__ai", info, e.currentTarget)}
							onMouseLeave={() => cancelTooltip("__ai")}
						>
							<button
								ref={aiBtnRef}
								type="button"
								className={`atb__label-btn ${layout.ai === "start" ? "atb__label-btn--primary" : ""} ${isAiActive ? "is-active" : ""}`}
								aria-haspopup="menu"
								aria-expanded={aiFlyout.open}
								aria-disabled={!enabled}
								onClick={toggleAiFlyout}
								onFocus={(e) => scheduleTooltip("__ai", info, e.currentTarget, true)}
								onBlur={() => cancelTooltip("__ai")}
							>
								✦ {ai.label}
							</button>
							<FlyoutArrow open={aiFlyout.open} onClick={toggleAiFlyout} label="AI segment options" />
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
								aria-pressed={aiNegativeEffective === negative}
								onMouseEnter={(e) => scheduleTooltip("__polarity", CONTROL_INFO.polarity, e.currentTarget)}
								onMouseLeave={() => cancelTooltip("__polarity")}
								onFocus={(e) => scheduleTooltip("__polarity", CONTROL_INFO.polarity, e.currentTarget, true)}
								onBlur={() => cancelTooltip("__polarity")}
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
					const info = layout.more ? CONTROL_INFO.more : CONTROL_INFO.edit;
					return (
						<button
							ref={editBtnRef}
							type="button"
							className="atb__label-btn"
							aria-haspopup="menu"
							aria-expanded={editFlyout.open}
							aria-disabled={!enabled}
							onClick={() => {
								if (!enabled) return;
								if (editFlyout.open) { editFlyout.setOpen(false); return; }
								editFlyout.anchorRef.current = editBtnRef.current;
								editFlyout.setOpen(true);
							}}
							onMouseEnter={(e) => scheduleTooltip("__edit", info, e.currentTarget)}
							onMouseLeave={() => cancelTooltip("__edit")}
							onFocus={(e) => scheduleTooltip("__edit", info, e.currentTarget, true)}
							onBlur={() => cancelTooltip("__edit")}
						>
							{layout.more ? "⋯ More" : "Edit ▾"}
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
							onHover={(el) => scheduleTooltip(id, TOOL_INFO[id], el)}
							onLeave={() => cancelTooltip(id)}
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
						onHover={(el) => scheduleTooltip(id, TOOL_INFO[id as EditTool], el)}
						onLeave={() => cancelTooltip(id)}
						registerIconRef={(el) => { iconRefs.current[id] = el; }}
					/>
				))}

				{(layout.undo || layout.redo || layout.save || layout.done) && (
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
						onMouseEnter={(e) => scheduleTooltip("__undo", CONTROL_INFO.undo, e.currentTarget)}
						onMouseLeave={() => cancelTooltip("__undo")}
						onFocus={(e) => scheduleTooltip("__undo", CONTROL_INFO.undo, e.currentTarget, true)}
						onBlur={() => cancelTooltip("__undo")}
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
						onMouseEnter={(e) => scheduleTooltip("__redo", CONTROL_INFO.redo, e.currentTarget)}
						onMouseLeave={() => cancelTooltip("__redo")}
						onFocus={(e) => scheduleTooltip("__redo", CONTROL_INFO.redo, e.currentTarget, true)}
						onBlur={() => cancelTooltip("__redo")}
					>
						<IconArrowForwardUp size={20} />
					</button>
				)}

				{/* 6 — Save / confirm. Labeled rather than a bare floppy icon: it's
				    the one action here that writes to the master record. */}
				{layout.save && (
					<button
						type="button"
						className="atb__label-btn atb__label-btn--primary"
						onClick={() => onSave()}
						disabled={isSaving || disabled}
						aria-label={CONTROL_INFO.save.label}
						onMouseEnter={(e) => scheduleTooltip("__save", CONTROL_INFO.save, e.currentTarget)}
						onMouseLeave={() => cancelTooltip("__save")}
						onFocus={(e) => scheduleTooltip("__save", CONTROL_INFO.save, e.currentTarget, true)}
						onBlur={() => cancelTooltip("__save")}
					>
						{isSaving ? <IconLoader size={15} className="spin" /> : <IconDeviceFloppy size={15} />}
						Save
					</button>
				)}

				{/* EDITING's exit — leaves manual editing without saving (Save is
				    deliberately not on screen during editing). */}
				{layout.done && (
					<button
						type="button"
						className="atb__label-btn"
						onClick={() => onToolChange(null)}
						onMouseEnter={(e) => scheduleTooltip("__done", CONTROL_INFO.done, e.currentTarget)}
						onMouseLeave={() => cancelTooltip("__done")}
						onFocus={(e) => scheduleTooltip("__done", CONTROL_INFO.done, e.currentTarget, true)}
						onBlur={() => cancelTooltip("__done")}
					>
						<IconCheck size={14} /> Done
					</button>
				)}
			</div>

			{/* One portaled tooltip for whichever control is hovered — rendered
			    here rather than per-item so it's never clipped by the ribbon's
			    own overflow rules. */}
			{tooltip && <IconTooltip info={tooltip.info} anchorRect={tooltip.rect} />}

			{/* Exit / Start over / Continue for the running guided flow
			    (Grow-from-seeds, Copy/Fill-across-slices, Islands) — fixed in
			    the ribbon, not floating over the canvas. No title/label text
			    identifying which guided flow is running is shown here — just
			    the controls themselves (see guidedControlsBoxRef below, used
			    only to anchor the one-time Continue/Start over/Exit explainer
			    popup, not for a visible label). */}
			{guidedControls && (
				<div
					ref={guidedControlsBoxRef}
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
									aria-disabled={!!guidedControls.continueDisabled}
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
								onHover={(el) => scheduleTooltip(id, TOOL_INFO[id], el)}
								onLeave={() => cancelTooltip(id)}
								registerRef={(el) => { flyoutRowRefs.current[id] = el; }}
								pinned={pinnedTools.includes(id)}
								onTogglePin={() => togglePin(id)}
							/>
						))}
					</MenuColumn>
				</div>
			</FlyoutPanel>

			{/* Structure picker (Level 1 slot 1). A compact mirror of the
			    right-hand class panel — that panel itself is untouched. */}
			<FlyoutPanel
				open={enabled && structureFlyout.open}
				anchorRef={structureFlyout.anchorRef}
				panelRef={structureFlyout.panelRef}
				placement="below"
				minWidth={220}
				anchorKey="__structure"
			>
				<div className="atb-flyout__col atb-flyout__col--menu">
					<div className="atb-menu-section">Structure</div>
					{structures.length === 0 ? (
						<div className="atb-flyout__hint">No structures in this scan.</div>
					) : (
						<MenuColumn>
							{structures.map((s) => (
								<MenuRow
									key={s.id}
									label={s.label}
									open={s.id === activeStructureId}
									onClick={() => {
										onSelectStructure(s.id);
										structureFlyout.setOpen(false);
									}}
								/>
							))}
						</MenuColumn>
					)}
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
						const rows = (
							<MenuColumn>
								{section.tools.map((id) => (
									<ToolRow
										key={id}
										id={id}
										active={activeTool === id}
										onSelect={() => selectFromFlyout(id)}
										onHover={(el) => scheduleTooltip(id, TOOL_INFO[id], el)}
										onLeave={() => cancelTooltip(id)}
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

		{/* First-run onboarding (spec §7). Rendered outside .atb-shell for the
		    same reason the ribbon's own pointer is: the shell carries a CSS
		    transform, which would make it the containing block for the card's
		    position:fixed coordinates. */}
		{open && onboardingStep != null && (
			<AnnotationOnboarding
				step={onboardingStep}
				targetRect={onboardingRect}
				onNext={advanceOnboarding}
				onSkip={finishOnboarding}
			/>
		)}

		{open && guidedHintOpen && guidedHintRect && (
			<>
				{/* Same dashed-spotlight treatment as the pick-class/first-target
				    hints above, but wrapping the Continue/Start over/Exit cluster
				    itself so it's obvious which controls the card is describing. */}
				<div
					aria-hidden="true"
					style={{
						position: "fixed",
						top: guidedHintRect.top - 8,
						left: guidedHintRect.left - 8,
						width: guidedHintRect.width + 16,
						height: guidedHintRect.height + 16,
						border: "2px dashed var(--jhu-blue-accent, #68ACE5)",
						borderRadius: 12,
						pointerEvents: "none",
						zIndex: 120,
						boxShadow: "0 0 0 4000px rgba(0,0,0,0.35)",
					}}
				/>
				<div
					role="dialog"
					aria-label="Guided flow controls"
					style={{
						position: "fixed",
						top: guidedHintRect.bottom + 10,
						left: Math.max(12, Math.min(guidedHintRect.left, window.innerWidth - 292)),
						width: 260,
						background: "#16181d",
						border: "1px solid rgba(255,255,255,0.14)",
						borderRadius: 12,
						boxShadow: "0 18px 44px -12px rgba(0,0,0,0.75)",
						padding: "14px 16px",
						zIndex: 121,
						color: "#fff",
					}}
				>
					<div style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.9)" }}>
						{guidedHintText}
					</div>
					<button
						type="button"
						onClick={dismissGuidedHint}
						style={{
							marginTop: 12,
							width: "100%",
							background: "#fff",
							color: "#08090b",
							border: "none",
							borderRadius: 8,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "8px 0",
							cursor: "pointer",
						}}
					>
						Got it
					</button>
				</div>
			</>
		)}

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