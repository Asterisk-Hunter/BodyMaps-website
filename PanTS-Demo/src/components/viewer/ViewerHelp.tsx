import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconKeyboard, IconX } from "@tabler/icons-react";
import { SHORTCUT_GROUPS } from "../../helpers/viewer/shortcuts";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import "./ViewerHelp.css";

/**
 * The keyboard cheat sheet: every binding the viewer actually has, grouped the
 * way the work is grouped. Blocking (a scrim, Esc / backdrop / ✕ to close),
 * because unlike a passive hint this is something you explicitly asked to see.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const dialogRef = useRef<HTMLDivElement>(null);
	useDialogFocus(open, dialogRef);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" || e.key === "?") {
				e.preventDefault();
				e.stopImmediatePropagation();
				onClose();
			}
		};
		// Capture phase so Esc closes the sheet instead of also reaching the
		// viewer's own handlers (which would cancel an armed tool underneath).
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	if (!open || typeof document === "undefined") return null;

	return createPortal(
		<div
			className="vp-help__sheet-scrim"
			role="presentation"
			onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div ref={dialogRef} className="vp-help__sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
				<div className="vp-help__sheet-head">
					<div>
						<div className="vp-help__eyebrow">
							<IconKeyboard size={12} />
							Keyboard
						</div>
						<div className="vp-help__sheet-title">Shortcuts</div>
					</div>
					<button type="button" className="vp-help__close" onClick={onClose} aria-label="Close shortcuts">
						<IconX size={16} />
					</button>
				</div>
				<div className="vp-help__sheet-body">
					{SHORTCUT_GROUPS.map((group) => (
						<section key={group.title} className="vp-help__group">
							<h3 className="vp-help__group-title">{group.title}</h3>
							<ul className="vp-help__list vp-help__list--sheet">
								{group.items.map((item) => (
									<li key={`${group.title}-${item.keys.join("+")}-${item.desc}`} className="vp-help__row">
										<span className="vp-help__keys">
											{item.keys.map((key, i) => (
												<span key={key} className="vp-help__key-wrap">
													{i > 0 && <span className="vp-help__plus" aria-hidden="true">+</span>}
													<kbd className="vp-help__key">{key}</kbd>
												</span>
											))}
										</span>
										<span className="vp-help__desc">{item.desc}</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			</div>
		</div>,
		document.body
	);
}

export default ShortcutSheet;
