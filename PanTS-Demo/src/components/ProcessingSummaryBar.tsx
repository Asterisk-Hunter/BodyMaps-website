import React from "react";

// One consolidated bar for all in-flight scans, instead of a card per scan.
// The wheel measures successful scans, not estimated model progress. Include
// every terminal outcome in the denominator so failures cannot shrink a batch
// into a falsely successful 1/1 or 100% result.
type Props = {
	running: number; // scans still uploading / queued / running
	done: number; // scans completed successfully
	failed?: number;
	cancelled?: number;
	statusLabel: string; // dominant phase, e.g. "Running…"
	title?: string; // defaults to "Processing scans"
	closeNote?: string; // e.g. "safe to close" - whether the tab is still needed
	closeReady?: boolean; // true once nothing is uploading (tints the note green)
	onViewDetails?: () => void; // per-scan status / view / download for the batch
	onCancelAll?: () => void;
};

const SIZE = 46;
const STROKE = 4;

const ProcessingSummaryBar: React.FC<Props> = ({ running, done, failed = 0, cancelled = 0, statusLabel, title = "Processing scans", closeNote, closeReady, onViewDetails, onCancelAll }) => {
	const total = running + done + failed + cancelled;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const allSucceeded = total > 0 && done === total;

	const r = (SIZE - STROKE) / 2;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - pct / 100);

	return (
		<div className="proc-bar">
			<div className="proc-wheel" style={{ width: SIZE, height: SIZE }} role="img"
				aria-label={`${done} of ${total} scans completed successfully`}
				title="Percentage of scans completed successfully">
				<svg width={SIZE} height={SIZE} aria-hidden="true">
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="rgba(0,45,114,0.12)"
						strokeWidth={STROKE}
					/>
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="#002D72"
						strokeWidth={STROKE}
						strokeLinecap="round"
						strokeDasharray={circ}
						strokeDashoffset={offset}
						transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
						style={{ transition: "stroke-dashoffset 0.4s ease" }}
					/>
				</svg>
				<span className="proc-wheel-pct" aria-hidden="true">{pct}%</span>
			</div>

			<div className="proc-info">
				<div className="proc-title">
					{title} <span className="proc-counter">{done}/{total} successful</span>
				</div>
				<div className="proc-sub">
					{/* The spin is "something is still happening" - once nothing is
					    running anymore it should stop, not keep spinning next to
					    "Inference complete" forever. */}
					{running > 0 ? (
						<span className="upload-spinner proc-spinner" />
					) : allSucceeded ? (
						<span className="proc-done-icon" aria-hidden="true">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<path d="M20 6 9 17l-5-5" />
							</svg>
						</span>
					) : total > 0 ? (
						<span className="proc-attention-icon" aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, color: "#a44316" }}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M10.3 3.5 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.5a2 2 0 0 0-3.4 0Z" />
								<path d="M12 9v4M12 17h.01" />
							</svg>
						</span>
					) : null}
					{/* One text run, not sibling flex items - otherwise the row's gap
					    opens a hole before the note and wraps it onto its own line. */}
					<span>
						{statusLabel}
						{running > 0 && ` · ${running} in progress`}
						{failed > 0 && ` · ${failed} failed`}
						{cancelled > 0 && ` · ${cancelled} cancelled`}
						{closeNote && (
							<span className={`proc-close-note${closeReady ? " proc-close-note--ready" : ""}`}>
								{" "}· {closeNote}
							</span>
						)}
					</span>
				</div>
			</div>

			{onViewDetails && (
				<button type="button" className="proc-details-btn" onClick={onViewDetails}>
					View details
				</button>
			)}
			{onCancelAll && (
				<button type="button" className="active-cancel-btn proc-cancel" onClick={onCancelAll}>
					Cancel all
				</button>
			)}
		</div>
	);
};

export default ProcessingSummaryBar;
