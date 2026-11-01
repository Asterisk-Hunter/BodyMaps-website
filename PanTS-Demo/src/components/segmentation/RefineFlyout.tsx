import { useEffect, useRef, useState } from "react";
import { ActionButton, MenuDivider } from "../viewer/FlyoutPrimitives";

const REFINE_TIMEOUT_MS = 60_000;

interface Props {
	classLabel: string;
	refine: (signal: AbortSignal) => Promise<number>;
	onApplied?: () => void;
}

const FRIENDLY_ERRORS = new Set([
	"Pick a structure to refine first.",
	"This class has no voxels to refine yet. Draw or segment it first.",
	"No segmentation loaded for this case.",
	"CT not found for this case on the server.",
	"Refine with model is available for cases loaded from the dataset.",
	"This model checkpoint can't refine a label on its own.",
	"The interactive model is unavailable for mask refinement.",
	"The model found nothing to keep in this class, so it was left as it was.",
	"The interactive model is busy. Wait a moment and try again.",
]);

function refineErrorMessage(error: unknown): string {
	if (error instanceof TypeError) return "Could not reach the model server. Check your connection and try again.";
	if (error instanceof Error && FRIENDLY_ERRORS.has(error.message)) return error.message;
	return "Refining failed. Try again.";
}

export default function RefineFlyout({ classLabel, refine, onApplied }: Props) {
	const [running, setRunning] = useState(false);
	const [success, setSuccess] = useState(false);
	const [changed, setChanged] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	const flight = useRef<{ controller: AbortController; stopped: "cancel" | "timeout" | null } | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const active = flight.current;
			if (active && !active.stopped) {
				active.stopped = "cancel";
				active.controller.abort();
			}
		};
	}, []);
	useEffect(() => {
		if (!running) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			const active = flight.current;
			if (active && !active.stopped) {
				active.stopped = "cancel";
				active.controller.abort();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [running]);

	const cancel = () => {
		const active = flight.current;
		if (!active || active.stopped) return;
		active.stopped = "cancel";
		active.controller.abort();
	};

	const run = async () => {
		if (running || success) return;
		setRunning(true);
		setError(null);
		const active = { controller: new AbortController(), stopped: null as "cancel" | "timeout" | null };
		flight.current = active;
		const deadline = window.setTimeout(() => {
			active.stopped = "timeout";
			active.controller.abort();
		}, REFINE_TIMEOUT_MS);
		try {
			const changedVoxels = await refine(active.controller.signal);
			if (!mounted.current) return;
			setRunning(false);
			setChanged(changedVoxels > 0);
			setSuccess(true);
			window.setTimeout(() => {
				if (!mounted.current) return;
				setSuccess(false);
				onApplied?.();
			}, 650);
		} catch (e) {
			if (!mounted.current) return;
			setRunning(false);
			if (active.stopped === "timeout") setError(`The model took longer than ${REFINE_TIMEOUT_MS / 60000} minutes, so refining was stopped and nothing was changed. Try again in a moment.`);
			else if (active.stopped !== "cancel") setError(refineErrorMessage(e));
		} finally {
			window.clearTimeout(deadline);
			if (flight.current === active) flight.current = null;
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<p className="atb-flyout-note">
				The model redraws this class's outline from its current voxels, with no clicks. It only grows into unlabeled voxels, and Undo reverses it.
			</p>
			{error && <p className="atb-flyout-note atb-flyout-note--error" role="alert">{error}</p>}
			<MenuDivider />
			<div className="atb-flyout__actions">
				<ActionButton
					label={`Refine ${classLabel}`}
					runningLabel="Refining…"
					busy={running}
					success={success}
					successLabel={changed ? "Refined" : "Already a good fit"}
					disabled={running || success}
					onClick={() => void run()}
				/>
				{running && <ActionButton label="Cancel" onClick={cancel} />}
			</div>
		</div>
	);
}
