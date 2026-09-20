import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconArrowRight, IconCheck, IconX } from "@tabler/icons-react";
import { ONBOARDING_STEPS } from "./annotationToolbarState";

interface AnnotationOnboardingProps {
	/** 0-based index into ONBOARDING_STEPS. */
	step: number;
	/** Live rect of whatever the current step points at — null renders a
	 *  centered card with no spotlight (used by the final text-only step). */
	targetRect: DOMRect | null;
	onNext: () => void;
	onSkip: () => void;
}

const CARD_WIDTH = 300;
const GAP = 12;
const EDGE = 12;

/**
 * First-run guided tour for the annotation ribbon.
 *
 * Non-blocking on purpose (unlike the read-only tour engine this replaced,
 * which put a scrim over the whole viewer and swallowed every pointer event):
 * the whole point of steps 1-3 is that the person performs the action while the
 * card is up — pick a structure, run the AI, then brush/erase — and each step
 * advances off that real interaction. So this renders a purely visual spotlight
 * (`pointer-events: none`) plus a card, and never intercepts a click.
 */
export default function AnnotationOnboarding({ step, targetRect, onNext, onSkip }: AnnotationOnboardingProps) {
	const cardRef = useRef<HTMLDivElement>(null);
	const [cardPos, setCardPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
	const total = ONBOARDING_STEPS.length;
	const clampedStep = Math.max(0, Math.min(step, total - 1));
	const current = ONBOARDING_STEPS[clampedStep];
	const isLast = clampedStep >= total - 1;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// Esc ends the tour without pretending the user finished it — same
			// outcome as Skip, since the flag is set either way (a tour that
			// keeps reappearing after being dismissed is worse than one that
			// never shows twice).
			onSkip();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onSkip]);

	// Measured post-render so tall steps can't be positioned off-screen.
	useLayoutEffect(() => {
		if (!cardRef.current) return;
		const el = cardRef.current;
		const w = el.offsetWidth || CARD_WIDTH;
		const h = el.offsetHeight || 150;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		if (!targetRect) {
			setCardPos({ top: Math.max(EDGE, (vh - h) / 2), left: Math.max(EDGE, (vw - w) / 2) });
			return;
		}
		// Below the target if it fits, otherwise above — the ribbon sits near
		// the top of the page, so below is the normal case.
		let top = targetRect.bottom + GAP;
		if (top + h > vh - EDGE) {
			const above = targetRect.top - h - GAP;
			top = above >= EDGE ? above : Math.max(EDGE, vh - h - EDGE);
		}
		let left = targetRect.left + targetRect.width / 2 - w / 2;
		left = Math.max(EDGE, Math.min(vw - w - EDGE, left));
		setCardPos({ top, left });
	}, [clampedStep, targetRect?.top, targetRect?.left, targetRect?.width, targetRect?.height]);

	if (typeof document === "undefined") return null;

	return createPortal(
		<>
			{targetRect && (
				<div
					aria-hidden="true"
					className="atb-onb__spotlight"
					style={{
						top: targetRect.top - 6,
						left: targetRect.left - 6,
						width: targetRect.width + 12,
						height: targetRect.height + 12,
					}}
				/>
			)}
			<div
				ref={cardRef}
				className="atb-onb__card"
				role="dialog"
				aria-label="Annotation tour"
				style={{ top: cardPos.top, left: cardPos.left }}
			>
				<div className="atb-onb__eyebrow">
					Step {clampedStep + 1} of {total}
				</div>
				<div className="atb-onb__title">{current.title}</div>
				<div className="atb-onb__text">{current.text}</div>

				<div className="atb-onb__footer">
					<div className="atb-onb__dots">
						{ONBOARDING_STEPS.map((_, i) => (
							<span key={i} className={`atb-onb__dot ${i === clampedStep ? "is-active" : ""}`} />
						))}
					</div>
					<div className="atb-onb__actions">
						<button type="button" className="atb-onb__btn atb-onb__btn--skip" onClick={onSkip}>
							<IconX size={12} />
							Skip tour
						</button>
						<button type="button" className="atb-onb__btn atb-onb__btn--next" onClick={onNext}>
							{isLast ? (
								<>
									<IconCheck size={13} />
									Got it
								</>
							) : (
								<>
									Next
									<IconArrowRight size={13} />
								</>
							)}
						</button>
					</div>
				</div>
			</div>
		</>,
		document.body
	);
}
