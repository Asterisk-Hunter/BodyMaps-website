import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconArrowLeft, IconArrowRight, IconCheck } from "@tabler/icons-react";
import "./AnnotationTour.css";

/** Browser-local first-run flag, like the workspace tour's — the point is
 *  "has this device shown the basics yet", not the account. */
export const ANNOTATION_TOUR_SEEN_KEY = "bodymaps.annotation-tour.v1";

export function hasSeenAnnotationTour(): boolean {
	try {
		if (typeof window === "undefined") return true;
		return window.localStorage.getItem(ANNOTATION_TOUR_SEEN_KEY) === "true";
	} catch {
		// Storage blocked (private mode) — treat as seen rather than nagging on
		// every single load.
		return true;
	}
}

export function markAnnotationTourSeen(): void {
	try {
		window.localStorage.setItem(ANNOTATION_TOUR_SEEN_KEY, "true");
	} catch {
		/* nothing to do */
	}
}

interface TourStep {
	title: string;
	text: string;
	/** Ribbon controls to outline. Missing targets simply mean no ring. */
	targets: readonly string[];
}

/** The three things editing a scan actually asks for, in order. Deliberately
 *  short: the tooltips explain individual tools, so the tour only has to make
 *  the structure → mask → refine loop legible. */
export const ANNOTATION_TOUR_STEPS: readonly TourStep[] = [
	{
		title: "Pick a structure",
		text: "Select the structure you want to annotate.",
		targets: ['[data-atb-tour="structure"]'],
	},
	{
		title: "Create a mask",
		text: "Use an AI prompt — point, box, or scribble — or draw the mask with a manual tool.",
		targets: ['[data-atb-tour="ai"]', '[data-atb-tour="manual"]'],
	},
	{
		title: "Refine the mask",
		text: "Refine with the model, or adjust by hand with Brush and Eraser.",
		targets: ['[data-atb-tour="ai"]', '[data-atb-tour="manual"]'],
	},
];

interface Ring {
	left: number;
	top: number;
	width: number;
	height: number;
}

export default function AnnotationTour({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [step, setStep] = useState(0);
	const [rings, setRings] = useState<Ring[]>([]);
	const nextRef = useRef<HTMLButtonElement>(null);
	const currentStep = Math.min(step, ANNOTATION_TOUR_STEPS.length - 1);
	const current = ANNOTATION_TOUR_STEPS[currentStep];
	const isLast = currentStep === ANNOTATION_TOUR_STEPS.length - 1;

	// The parent only mounts this while the tour is open, so closing it (skip,
	// Escape, or Get started) discards the step state and the next open starts
	// at step one again.
	useLayoutEffect(() => {
		if (!open) return;
		let frame = 0;
		const measure = () => {
			const next: Ring[] = [];
			for (const selector of current.targets) {
				document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
					const rect = element.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						next.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
					}
				});
			}
			setRings(next);
		};
		// The ribbon slides in, so measure on the next frame rather than during
		// the open render (when its final position is not known yet).
		frame = window.requestAnimationFrame(measure);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [open, current]);

	// Keep the primary action under the keyboard's focus as the steps advance.
	useLayoutEffect(() => {
		if (open) nextRef.current?.focus({ preventScroll: true });
	}, [open, currentStep]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// Own Escape while the tour is up: it must not also disarm the
			// prompt tool underneath.
			e.preventDefault();
			e.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	if (!open || typeof document === "undefined") return null;

	return createPortal(
		<>
			{rings.map((ring, index) => (
				<span
					key={`${currentStep}-${index}`}
					className="atb-tour__ring"
					aria-hidden="true"
					style={{ left: ring.left - 4, top: ring.top - 4, width: ring.width + 8, height: ring.height + 8 }}
				/>
			))}
			<div
				className="atb-tour"
				role="dialog"
				aria-labelledby="atb-tour-title"
				aria-describedby="atb-tour-text"
			>
				<div className="atb-tour__count">Step {currentStep + 1} of {ANNOTATION_TOUR_STEPS.length}</div>
				<h2 id="atb-tour-title" className="atb-tour__title">{current.title}</h2>
				<p id="atb-tour-text" className="atb-tour__text">{current.text}</p>
				<div className="atb-tour__actions">
					<button type="button" className="atb-tour__skip" onClick={onClose}>Skip tour</button>
					<div className="atb-tour__nav">
						{currentStep > 0 && (
							<button type="button" className="atb-tour__back" onClick={() => setStep(currentStep - 1)}>
								<IconArrowLeft size={14} aria-hidden="true" />
								Back
							</button>
						)}
						<button
							ref={nextRef}
							type="button"
							className="atb-tour__next"
							onClick={() => (isLast ? onClose() : setStep(currentStep + 1))}
						>
							{isLast ? (
								<>
									<IconCheck size={14} aria-hidden="true" />
									Get started
								</>
							) : (
								<>
									Next
									<IconArrowRight size={14} aria-hidden="true" />
								</>
							)}
						</button>
					</div>
				</div>
			</div>
		</>,
		document.body,
	);
}
