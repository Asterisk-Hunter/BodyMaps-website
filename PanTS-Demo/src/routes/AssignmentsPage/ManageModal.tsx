import { type ReactNode, useEffect, useId, useRef } from "react";

// A small window over the page for the manager's two occasional jobs (handing out cases, choosing annotators). It closes
// with the X, Escape or a click on the dimmed page, keeps the keyboard inside while it is open, stops the page behind it
// from scrolling, and gives focus back to the button that opened it.
//
// The keyboard is listened to on the whole document, not just inside the window: pressing a button can remove that
// button (a person who has just been made an annotator no longer needs the button), which drops focus onto the page, and
// Escape and Tab must keep working from there.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function ManageModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const close = useRef(onClose);
	close.current = onClose;

	useEffect(() => {
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const first = dialog.current?.querySelector<HTMLElement>("input, textarea, select");
		(first ?? dialog.current)?.focus();

		const onKeyDown = (e: KeyboardEvent) => {
			const box = dialog.current;
			if (!box) return;
			if (e.key === "Escape") {
				e.preventDefault();
				close.current();
				return;
			}
			if (e.key !== "Tab") return;
			const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
			if (items.length === 0) return;
			const active = document.activeElement;
			const inside = active instanceof Node && box.contains(active);
			const firstItem = items[0];
			const lastItem = items[items.length - 1];
			if (!inside) {
				e.preventDefault();
				(e.shiftKey ? lastItem : firstItem).focus();
			} else if (e.shiftKey && (active === firstItem || active === box)) {
				e.preventDefault();
				lastItem.focus();
			} else if (!e.shiftKey && active === lastItem) {
				e.preventDefault();
				firstItem.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);

		const restore = opener.current;
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
			restore?.focus?.();
		};
	}, []);

	return (
		<div className="asg-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div ref={dialog} className="asg-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
				<div className="asg-modal-head">
					<h2 id={titleId}>{title}</h2>
					<button type="button" className="asg-modal-x" aria-label="Close" onClick={onClose}>×</button>
				</div>
				<div className="asg-modal-body">{children}</div>
			</div>
		</div>
	);
}
