import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconPlus, IconSettings, IconX } from "@tabler/icons-react";
import "./StructurePicker.css";

export interface StructureOption {
	id: number;
	label: string;
}

export interface StructurePickerProps {
	structures: StructureOption[];
	colors: Record<number, string>;
	activeStructureId: number | null;
	onSelectStructure: (id: number | null) => void;
	onCreateStructure?: (name: string, color: string) => StructureOption | null;
	onRenameStructure?: (id: number, name: string) => boolean;
	onColorChange?: (id: number, color: string) => void;
	onDeleteStructure?: (id: number) => void;
	showOnlyTargetMask?: boolean;
	onShowOnlyTargetMaskChange?: (value: boolean) => void;
	managedStructureIds?: readonly number[];
	disabled?: boolean;
	visibility?: Record<number, boolean>;
	onToggleVisibility?: (id: number) => void;
}

const DEFAULT_COLOR = "#72b7e8";
const DEFAULT_NEW_COLOR = "#38bdf8";

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

export default function StructurePicker({
	structures,
	colors,
	activeStructureId,
	onSelectStructure,
	onCreateStructure,
	onRenameStructure,
	onColorChange,
	onDeleteStructure,
	showOnlyTargetMask = false,
	onShowOnlyTargetMaskChange,
	managedStructureIds,
	disabled = false,
	visibility,
	onToggleVisibility,
}: StructurePickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newColor, setNewColor] = useState(DEFAULT_NEW_COLOR);
	const [createError, setCreateError] = useState("");
	const [manageOpen, setManageOpen] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [renameError, setRenameError] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const newNameRef = useRef<HTMLInputElement>(null);

	const activeStructure = structures.find((structure) => structure.id === activeStructureId);
	const canManageActive = !!activeStructure && (managedStructureIds
		? managedStructureIds.includes(activeStructure.id)
		: !!(onRenameStructure || onColorChange || onDeleteStructure));
	const filteredStructures = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		return normalizedQuery
			? structures.filter((structure) => structure.label.toLocaleLowerCase().includes(normalizedQuery))
			: structures;
	}, [query, structures]);

	const updatePosition = useCallback(() => {
		const trigger = triggerRef.current;
		const panel = panelRef.current;
		if (!trigger || !panel) return;
		const triggerRect = trigger.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		const gutter = 10;
		const left = clamp(triggerRect.left, gutter, window.innerWidth - panelRect.width - gutter);
		const below = window.innerHeight - triggerRect.bottom - gutter;
		const above = triggerRect.top - gutter;
		const top = below >= Math.min(panelRect.height, 260) || below >= above
			? clamp(triggerRect.bottom + 7, gutter, window.innerHeight - panelRect.height - gutter)
			: clamp(triggerRect.top - panelRect.height - 7, gutter, window.innerHeight - panelRect.height - gutter);
		setPanelPosition({ left, top });
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		searchRef.current?.focus();
	}, [open, updatePosition]);

	useLayoutEffect(() => {
		if (open) updatePosition();
	}, [open, query, filteredStructures.length, creating, manageOpen, confirmDelete, updatePosition]);

	useEffect(() => {
		if (!open || !panelRef.current) return;
		const observer = new ResizeObserver(updatePosition);
		observer.observe(panelRef.current);
		updatePosition();
		return () => observer.disconnect();
	}, [open, updatePosition]);

	const resetTransientState = useCallback(() => {
		setQuery("");
		setHighlightedIndex(structures.findIndex((structure) => structure.id === activeStructureId));
		setCreating(false);
		setNewName("");
		setNewColor(DEFAULT_NEW_COLOR);
		setCreateError("");
		setManageOpen(false);
		setConfirmDelete(false);
		setRenameValue(activeStructure?.label ?? "");
		setRenameError("");
	}, [activeStructure?.label, activeStructureId, structures]);

	const closePicker = useCallback((restoreFocus = false) => {
		setOpen(false);
		resetTransientState();
		if (restoreFocus) triggerRef.current?.focus();
	}, [resetTransientState]);

	const openPicker = useCallback(() => {
		resetTransientState();
		setOpen(true);
	}, [resetTransientState]);

	useEffect(() => {
		if (disabled && open) closePicker();
	}, [disabled, open, closePicker]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			closePicker();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				closePicker(true);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open, updatePosition, closePicker]);

	useEffect(() => {
		setRenameValue(activeStructure?.label ?? "");
		setRenameError("");
		setManageOpen(false);
		setConfirmDelete(false);
	}, [activeStructureId, activeStructure?.label]);

	useEffect(() => {
		if (creating) newNameRef.current?.focus();
	}, [creating]);

	const select = (id: number | null) => {
		onSelectStructure(id);
		closePicker(true);
	};

	const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (filteredStructures.length === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setHighlightedIndex((index) => index < 0
				? (step > 0 ? 0 : filteredStructures.length - 1)
				: (index + step + filteredStructures.length) % filteredStructures.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const highlighted = filteredStructures[highlightedIndex] ?? filteredStructures[0];
			if (highlighted) select(highlighted.id);
		}
	};

	const createStructure = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const name = newName.trim();
		if (!name) {
			setCreateError("Enter a structure name.");
			return;
		}
		if (structures.some((structure) => structure.label.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
			setCreateError("That structure already exists.");
			return;
		}
		const created = onCreateStructure?.(name, newColor);
		if (!created) {
			setCreateError("Structure could not be created.");
			return;
		}
		setNewName("");
		setCreateError("");
		setCreating(false);
		select(created.id);
	};

	const saveRename = () => {
		const name = renameValue.trim();
		if (!activeStructure || !name) {
			setRenameError("Enter a structure name.");
			return;
		}
		if (structures.some((structure) => structure.id !== activeStructure.id && structure.label.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
			setRenameError("That structure already exists.");
			return;
		}
		if (name !== activeStructure.label && onRenameStructure?.(activeStructure.id, name) === false) {
			setRenameError("Structure name could not be changed.");
			return;
		}
		setRenameError("");
	};

	return (
		<div className="structure-picker" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				className={`structure-picker__trigger${activeStructure ? " is-selected" : ""}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={activeStructure ? `Change structure, ${activeStructure.label}` : "Select structure"}
				disabled={disabled}
				onClick={() => open ? closePicker() : openPicker()}
			>
				{activeStructure ? <span className="structure-picker__swatch" style={{ backgroundColor: colors[activeStructure.id] ?? DEFAULT_COLOR }} aria-hidden="true" /> : <span className="structure-picker__target" aria-hidden="true" />}
				<span className="structure-picker__trigger-label">{activeStructure?.label ?? "Select structure"}</span>
				<IconChevronDown size={14} aria-hidden="true" />
			</button>

			{open && createPortal(
				<div
					ref={panelRef}
					className="structure-picker__panel"
					role="dialog"
					aria-label="Choose a structure"
					style={{ left: panelPosition?.left ?? 10, top: panelPosition?.top ?? 10 }}
				>
					<div className="structure-picker__search-wrap">
						<input
							ref={searchRef}
							className="structure-picker__search"
							value={query}
							onChange={(event) => { setQuery(event.currentTarget.value); setHighlightedIndex(-1); }}
							onKeyDown={handleSearchKeyDown}
							aria-activedescendant={filteredStructures[highlightedIndex] ? `structure-option-${filteredStructures[highlightedIndex].id}` : undefined}
							placeholder="Search structures"
							aria-label="Search structures"
						/>
						<button type="button" className="structure-picker__close" onClick={() => closePicker(true)} aria-label="Close structure picker"><IconX size={16} /></button>
					</div>

					{activeStructure && onShowOnlyTargetMaskChange && (
						<label className="structure-picker__isolate">
							<input type="checkbox" checked={showOnlyTargetMask} onChange={(event) => onShowOnlyTargetMaskChange(event.currentTarget.checked)} />
							<span>Isolate structure</span>
						</label>
					)}

					<div className="structure-picker__list" aria-label="Structures">
						{filteredStructures.map((structure) => {
							const selected = structure.id === activeStructureId;
							return (
								<button
									key={structure.id}
									id={`structure-option-${structure.id}`}
									type="button"
									className={`structure-picker__option${selected ? " is-active" : ""}${filteredStructures[highlightedIndex]?.id === structure.id ? " is-keyboard-active" : ""}`}
									aria-current={selected ? "true" : undefined}
									onClick={() => select(selected ? null : structure.id)}
								>
									<span className="structure-picker__swatch" style={{ backgroundColor: colors[structure.id] ?? DEFAULT_COLOR }} aria-hidden="true" />
									<span className="structure-picker__option-label">{structure.label}</span>
										{selected && <IconCheck size={15} aria-hidden="true" />}
								</button>
							);
						})}
						{filteredStructures.length === 0 && <p className="structure-picker__empty">No structures found.</p>}
					</div>

					{activeStructure && canManageActive && (onRenameStructure || onColorChange || onDeleteStructure) && (
						<div className="structure-picker__manage">
							<button type="button" className="structure-picker__manage-toggle" aria-expanded={manageOpen} onClick={() => setManageOpen((value) => !value)}>
								<IconSettings size={14} /> Manage structure
							</button>
							{manageOpen && (
								<div className="structure-picker__manage-content">
									{onToggleVisibility && <label className="structure-picker__visibility-row"><input type="checkbox" checked={visibility?.[activeStructure.id] ?? true} onChange={() => onToggleVisibility(activeStructure.id)} /><span>Show structure</span></label>}
									{onRenameStructure && <div className="structure-picker__rename-row">
										<input aria-label="Rename structure" value={renameValue} maxLength={64} onChange={(event) => { setRenameValue(event.currentTarget.value); setRenameError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveRename(); } }} />
										<button type="button" onClick={saveRename}>Save</button>
									</div>}
									{onColorChange && <label className="structure-picker__color-row"><span>Color</span><input type="color" aria-label="Structure color" value={colors[activeStructure.id] ?? DEFAULT_COLOR} onChange={(event) => onColorChange(activeStructure.id, event.currentTarget.value)} /></label>}
									{renameError && <p className="structure-picker__error" role="alert">{renameError}</p>}
									{onDeleteStructure && (confirmDelete ? <div className="structure-picker__delete-confirm"><span>Delete this structure?</span><button type="button" onClick={() => { onDeleteStructure(activeStructure.id); select(null); }}>Delete</button><button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button></div> : <button type="button" className="structure-picker__delete" onClick={() => setConfirmDelete(true)}>Delete structure</button>)}
								</div>
							)}
						</div>
					)}

					{onCreateStructure && <div className="structure-picker__create-area">
						{creating ? <form className="structure-picker__create-form" onSubmit={createStructure}>
							<label htmlFor="structure-picker-new-name">New structure</label>
							<div className="structure-picker__create-row">
								<input ref={newNameRef} id="structure-picker-new-name" value={newName} maxLength={64} onChange={(event) => { setNewName(event.currentTarget.value); setCreateError(""); }} autoComplete="off" />
								<input type="color" value={newColor} aria-label="New structure color" onChange={(event) => setNewColor(event.currentTarget.value)} />
							</div>
							{createError && <p className="structure-picker__error" role="alert">{createError}</p>}
							<div className="structure-picker__form-actions"><button type="submit">Create structure</button><button type="button" onClick={() => { setCreating(false); setCreateError(""); }}>Cancel</button></div>
						</form> : <button type="button" className="structure-picker__create-toggle" onClick={() => setCreating(true)}><IconPlus size={15} /> Create structure</button>}
					</div>}
				</div>, document.body,
			)}
		</div>
	);
}
