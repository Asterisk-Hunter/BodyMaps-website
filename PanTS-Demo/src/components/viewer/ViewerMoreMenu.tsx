import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { IconDotsVertical } from "@tabler/icons-react";
import "./ViewerMoreMenu.css";

export interface ViewerMoreAction {
	id: string;
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	disabled?: boolean;
	active?: boolean;
}

interface ViewerMoreMenuProps {
	actions: readonly ViewerMoreAction[];
}

interface MenuPosition {
	left: number;
	top: number;
}

const VIEWPORT_GUTTER = 10;
const TRIGGER_GAP = 8;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

export default function ViewerMoreMenu({ actions }: ViewerMoreMenuProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<MenuPosition | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	const updatePosition = useCallback(() => {
		const trigger = triggerRef.current;
		const panel = panelRef.current;
		if (!trigger || !panel) return;

		const triggerRect = trigger.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		const left = clamp(
			triggerRect.right - panelRect.width,
			VIEWPORT_GUTTER,
			window.innerWidth - panelRect.width - VIEWPORT_GUTTER,
		);
		const roomBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_GUTTER;
		const roomAbove = triggerRect.top - VIEWPORT_GUTTER;
		const top = roomBelow >= panelRect.height || roomBelow >= roomAbove
			? clamp(triggerRect.bottom + TRIGGER_GAP, VIEWPORT_GUTTER, window.innerHeight - panelRect.height - VIEWPORT_GUTTER)
			: clamp(triggerRect.top - panelRect.height - TRIGGER_GAP, VIEWPORT_GUTTER, window.innerHeight - panelRect.height - VIEWPORT_GUTTER);

		setPosition({ left, top });
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	}, [open, updatePosition]);

	useEffect(() => {
		if (!open) return;

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
		};
		const onReflow = () => updatePosition();

		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onReflow);
		window.addEventListener("scroll", onReflow, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onReflow);
			window.removeEventListener("scroll", onReflow, true);
		};
	}, [open, updatePosition]);

	const selectAction = (action: ViewerMoreAction) => {
		if (action.disabled) return;
		// Commit the close before a callback opens a sidebar or another dialog.
		// Deliberately do not restore trigger focus: the action may move focus itself.
		flushSync(() => setOpen(false));
		action.onSelect();
	};

	return (
		<div className="viewer-more-menu" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				className="vp-tool vp-tool--named viewer-more-menu__trigger"
				aria-label="More viewer tools"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<IconDotsVertical size={18} aria-hidden="true" />
				<span>More</span>
			</button>

			{open && createPortal(
				<div
					ref={panelRef}
					className="vp-flyout viewer-more-menu__panel"
					role="dialog"
					aria-label="More viewer tools"
					style={{ left: position?.left ?? VIEWPORT_GUTTER, top: position?.top ?? VIEWPORT_GUTTER }}
				>
					{actions.map((action) => (
						<button
							key={action.id}
							type="button"
							className={`vp-flyout__item viewer-more-menu__action${action.active ? " is-active" : ""}`}
							aria-pressed={action.active}
							disabled={action.disabled}
							onClick={() => selectAction(action)}
						>
							<span className="viewer-more-menu__icon" aria-hidden="true">{action.icon}</span>
							<span>{action.label}</span>
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}
