import { useEffect, useRef, useState } from "react";
import NumberSliderField from "../NumberSliderField";
import { ActionButton, ActionList, MenuDivider } from "../viewer/FlyoutPrimitives";
import type { SmoothingMethod } from "../../helpers/CornerstoneNifti2";

interface Props {
	onApply: (method: SmoothingMethod, kernelMm: number) => void;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const MAX_KERNEL_MM = 3;
const MIN_KERNEL_MM = 0.5;

// Same column layout as Scissors/Margin/Hollow: a slider, a divider, then
// the action. Smooth is a single ActionButton since it has only one method.
export default function SmoothingFlyout({ onApply, onApplied, onBusyChange }: Props) {
	const [kernelMm, setKernelMm] = useState(3);
	const [applying, setApplying] = useState(false);
	// Shows the checkmark beat before onApplied fires, so the confirmation
	// is seen rather than disappearing the instant it appears.
	const [success, setSuccess] = useState(false);
	const timers = useRef<{ first: number | null; second: number | null; busy: boolean }>({ first: null, second: null, busy: false });
	const busyChangeRef = useRef(onBusyChange);
	busyChangeRef.current = onBusyChange;
	useEffect(() => () => {
		if (timers.current.first != null) window.clearTimeout(timers.current.first);
		if (timers.current.second != null) window.clearTimeout(timers.current.second);
		if (timers.current.busy) {
			timers.current.busy = false;
			busyChangeRef.current?.(false);
		}
	}, []);

	const run = () => {
		if (applying || success) return;
		setApplying(true);
		onBusyChange?.(true);
		timers.current.busy = true;
		onApply("median", kernelMm);
		// Keep the button "running" for a beat before the flyout collapses.
		timers.current.first = window.setTimeout(() => {
			timers.current.first = null;
			setApplying(false);
			setSuccess(true);
			timers.current.second = window.setTimeout(() => {
				timers.current.second = null;
				setSuccess(false);
				timers.current.busy = false;
				onBusyChange?.(false);
				onApplied?.();
			}, 650);
		}, 550);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<NumberSliderField
				label="Kernel size"
				value={kernelMm}
				onChange={setKernelMm}
				min={MIN_KERNEL_MM}
				max={MAX_KERNEL_MM}
				step={0.1}
				unit="mm"
				ariaLabel="Smoothing kernel size"
			/>
			<MenuDivider />
			<ActionList>
				{/* Label tracks the slider live, same as Margin's Grow/Shrink. */}
				<ActionButton
					label={`Smooth by ${kernelMm.toFixed(1)}mm`}
					runningLabel="Smoothing…"
					busy={applying}
					success={success}
					successLabel="Smoothed"
					disabled={applying || success}
					onClick={run}
				/>
			</ActionList>
		</div>
	);
}
