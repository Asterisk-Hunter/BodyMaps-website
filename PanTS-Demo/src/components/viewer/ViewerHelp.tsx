import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconBulb, IconCheck, IconKeyboard, IconX } from "@tabler/icons-react";
import { SHORTCUT_GROUPS } from "../../helpers/viewer/shortcuts";
import "./ViewerHelp.css";

/** First-run flag for the tip strip. Browser-local (like the annotation tour's
 *  flag) because the point is "has this device shown the basics yet". */
export const VIEWER_TIPS_SEEN_KEY = "viewer_tips_seen";

export function hasSeenViewerTips(): boolean {
	try {
		if (typeof window === "undefined") return true;
		return window.localStorage.getItem(VIEWER_TIPS_SEEN_KEY) === "true";
	} catch {
		// Storage blocked (private mode) — treat as seen rather than nagging on
		// every single load.
		return true;
	}
}

export function markViewerTipsSeen(): void {
	try {
		window.localStorage.setItem(VIEWER_TIPS_SEEN_KEY, "true");
	} catch {
		/* nothing to do */
	}
}

/** The four things a first-time reader actually gets stuck on. Deliberately
 *  short and concrete: the crosshair linkage and the fact that tools act on the
 *  *focused* pane are the two ideas the UI can't express on its own, so they
 *  get the space; everything else is left to the shortcut sheet.
 *
 *  The hover-to-identify line is here because that setting ships OFF and lives
 *  three levels into View ▾, so nothing else in the UI ever hints that naming
 *  an organ by pointing at it is even possible. */
export const VIEWER_TIPS: readonly string[] = [
	"Scroll or press [ and ] to step through slices — the focused pane (bright outline) is the one that moves.",
	"Left-drag places the crosshair across all three planes at once. Click a pane to focus it.",
	"Window ▾ applies a CT preset. Adjust ▾ holds brightness, contrast and zoom.",
	"Press H, then hover a pane to name the organ under the pointer.",
	"Measure ▾ draws lengths, angles and ROIs — press ? for every shortcut.",
];

/**
 * One-time "getting started" card for the viewer.
 *
 * Non-blocking and dismissible on purpose: it appears beside the scan, never
 * over it, and the scan stays fully interactive underneath while it's up, so a
 * reader can simply scroll away and ignore it. It is not a tour — nothing is
 * highlighted, nothing is intercepted, and there is no stepper.
 */
export function ViewerTips({
	open, onDismiss, onShowShortcuts,
}: {
	open: boolean;
	onDismiss: () => void;
	onShowShortcuts: () => void;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			onDismiss();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onDismiss]);

	if (!open || typeof document === "undefined") return null;

	return createPortal(
		<aside className="vp-help__tips" role="complementary" aria-label="Getting started">
			<div className="vp-help__eyebrow">
				<IconBulb size={12} />
				Getting started
			</div>
			<div className="vp-help__title">Reading a scan</div>
			<ul className="vp-help__list">
				{VIEWER_TIPS.map((tip) => (
					<li key={tip} className="vp-help__item">
						<span className="vp-help__dot" aria-hidden="true" />
						<span>{tip}</span>
					</li>
				))}
			</ul>
			<div className="vp-help__actions">
				<button type="button" className="vp-help__btn vp-help__btn--ghost" onClick={onShowShortcuts}>
					<IconKeyboard size={13} />
					All shortcuts
				</button>
				<button type="button" className="vp-help__btn vp-help__btn--primary" onClick={onDismiss}>
					<IconCheck size={13} />
					Got it
				</button>
			</div>
		</aside>,
		document.body
	);
}

/**
 * The keyboard cheat sheet: every binding the viewer actually has, grouped the
 * way the work is grouped. Blocking (a scrim, Esc / backdrop / ✕ to close),
 * because unlike the tip strip this is something you explicitly asked to see.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
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
			<div className="vp-help__sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
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
