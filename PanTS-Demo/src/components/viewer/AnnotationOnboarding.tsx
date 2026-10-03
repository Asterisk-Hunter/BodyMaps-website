import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ONBOARDING_STEPS } from "./annotationToolbarState";
import "./AnnotationOnboarding.css";

interface AnnotationOnboardingProps {
	/** 0-based index into ONBOARDING_STEPS. */
	step: number;
	/** Anchor for the compact tour card; null falls back to the toolbar's right edge. */
	targetRect: DOMRect | null;
	onNext: () => void;
	onSkip: () => void;
	onBack?: () => void;
}

interface CardPosition {
	top: number;
	left: number;
}

const EDGE = 12;
const TARGET_GAP = 10;
const TOOLBAR_GAP = 10;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

export default function AnnotationOnboarding({ step, targetRect, onNext, onSkip, onBack }: AnnotationOnboardingProps) {
	const cardRef = useRef<HTMLDivElement>(null);
	const nextRef = useRef<HTMLButtonElement>(null);
	const [cardPosition, setCardPosition] = useState<CardPosition>({ top: EDGE, left: EDGE });
	const total = ONBOARDING_STEPS.length;
	const currentStep = clamp(step, 0, total - 1);
	const currentCopy = ONBOARDING_STEPS[currentStep];
	const isLast = currentStep === total - 1;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Once someone returns to the scan or picker, Escape belongs to that action.
			if (!(event.target instanceof Node) || !cardRef.current?.contains(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			onSkip();
		};

		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onSkip]);

	useLayoutEffect(() => {
		const card = cardRef.current;
		if (!card) return;

		const measureAndPlace = () => {
			const rect = card.getBoundingClientRect();
			const width = rect.width || Math.min(340, window.innerWidth - EDGE * 2);
			const height = rect.height || 190;
			const maxLeft = window.innerWidth - width - EDGE;
			const maxTop = window.innerHeight - height - EDGE;

			if (!targetRect) {
				const rootStyles = getComputedStyle(document.documentElement);
				const topbarHeight = Number.parseFloat(rootStyles.getPropertyValue("--vp-topbar-h")) || 0;
				const ribbonHeight = Number.parseFloat(rootStyles.getPropertyValue("--atb-ribbon-h")) || 0;
				setCardPosition({
					top: clamp(topbarHeight + ribbonHeight + TOOLBAR_GAP, EDGE, maxTop),
					left: clamp(window.innerWidth - width - EDGE, EDGE, maxLeft),
				});
				return;
			}

			const left = clamp(
				targetRect.left + targetRect.width / 2 - width / 2,
				EDGE,
				maxLeft,
			);
			const below = targetRect.bottom + TARGET_GAP;
			const above = targetRect.top - height - TARGET_GAP;
			const top = below + height <= window.innerHeight - EDGE
				? below
				: above >= EDGE
					? above
					: clamp(below, EDGE, maxTop);

			setCardPosition({ top, left });
		};

		measureAndPlace();
		window.addEventListener("resize", measureAndPlace);
		window.addEventListener("scroll", measureAndPlace, true);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureAndPlace);
		observer?.observe(card);
		return () => {
			window.removeEventListener("resize", measureAndPlace);
			window.removeEventListener("scroll", measureAndPlace, true);
			observer?.disconnect();
		};
	}, [currentStep, targetRect?.top, targetRect?.left, targetRect?.width, targetRect?.height]);

	useLayoutEffect(() => {
		nextRef.current?.focus();
	}, [currentStep]);

	if (typeof document === "undefined") return null;

	return createPortal(
		<>
			<div
				ref={cardRef}
				className="atb-onb__card"
				role="dialog"
				aria-labelledby="atb-onb-title"
				aria-describedby="atb-onb-description"
				style={{ top: cardPosition.top, left: cardPosition.left }}
			>
				<div className="atb-onb__progress-row">
					<span className="atb-onb__step-count">Step {currentStep + 1} of {total}</span>
					<div className="atb-onb__dots" aria-hidden="true">
						{Array.from({ length: total }, (_, index) => (
							<span key={index} className={`atb-onb__dot${index === currentStep ? " is-active" : ""}`} />
						))}
					</div>
				</div>
				<h2 id="atb-onb-title" className="atb-onb__title">{currentCopy.title}</h2>
				<p id="atb-onb-description" className="atb-onb__text">{currentCopy.text}</p>

				<div className="atb-onb__footer">
					<button type="button" className="atb-onb__skip" onClick={onSkip}>Skip tour</button>
					<div className="atb-onb__actions">
						{currentStep > 0 && onBack && (
							<button type="button" className="atb-onb__back" onClick={onBack}>Back</button>
						)}
						<button ref={nextRef} type="button" className="atb-onb__next" onClick={onNext}>
							{isLast ? "Get started" : "Next"}
						</button>
					</div>
				</div>
			</div>
		</>,
		document.body,
	);
}
