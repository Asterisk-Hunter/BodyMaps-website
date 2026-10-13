import React, { useId, useRef } from "react";
import { formatRelativeTime, recentStatusColor, type RecentUpload } from "../helpers/recentUploads";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";
import WorkspaceRunCard from "./WorkspaceRunCard";
import "./BatchDetailsModal.css";

// Popup listing every scan in a batch, each with its own status / View / Download
// — the same affordances an individual completed upload gets. Takes up most of
// the screen (not all) and closes via the X or a backdrop click / Esc.
type Props = {
	label: string;
	uploads: RecentUpload[];
	phases?: Record<string, string | undefined>;
	onClose: () => void;
	onView: (upload: RecentUpload) => void;
	onDownloadScan: (upload: RecentUpload) => void;
	onDownloadAll: () => void;
	downloadBusy?: boolean;
	downloadMessage?: string;
};

// Only a finished scan can be viewed/downloaded; a still-processing one just
// shows its status (this modal is now reachable from a live batch too).
const isDone = (s: RecentUpload["status"]) => s === "Completed";

const BatchDetailsModal: React.FC<Props> = ({
	label,
	uploads,
	phases,
	onClose,
	onView,
	onDownloadScan,
	onDownloadAll,
	downloadBusy = false,
	downloadMessage,
}) => {
	// Focus moves into the dialog when it opens, Tab and Shift+Tab stay inside it,
	// Escape closes it and focus returns to the button that opened it. The page behind
	// scrolls in its own pane, not the body, so there is no body scroll to lock.
	const panelRef = useRef<HTMLDivElement>(null);
	useDialogFocus(true, panelRef, { onEscape: onClose, lockScroll: false });
	// A drag that starts on the panel (selecting a file name) and ends on the backdrop
	// is not a click on the backdrop.
	const backdropDismiss = useBackdropDismiss(onClose);
	const rowId = useId();

	const done = uploads.filter((u) => u.status === "Completed").length;

	return (
		<div className="bdm-backdrop" {...backdropDismiss}>
			<div
				ref={panelRef}
				className="bdm-panel"
				role="dialog"
				aria-modal="true"
				aria-label={`${label} details`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="bdm-header">
					<div>
						<div className="bdm-title">{label}</div>
						<div className="bdm-subtitle">
							{done}/{uploads.length} complete
						</div>
					</div>
					<div className="bdm-header-actions">
						<button type="button" className="bdm-download-all" disabled={downloadBusy || done === 0} onClick={onDownloadAll}>
							{downloadBusy ? "Preparing..." : "Download completed"}
						</button>
						<button type="button" className="bdm-close" aria-label="Close" onClick={onClose}>
							×
						</button>
					</div>
				</div>

				{downloadMessage && <p role="status" style={{ margin: "0 24px 16px", fontSize: 14 }}>{downloadMessage}</p>}
				<div className="bdm-list">
					{uploads.map((u, index) => {
						const done = isDone(u.status);
						// Every row's buttons read "View" and "Download"; the row's name and line
						// tell a screen reader which scan they belong to.
						const describedBy = `${rowId}-${index}-title ${rowId}-${index}-sub`;
						// Keep each preview's provenance and animation visible per scan.
						// Stable keys preserve the observed active-to-completed transition.
						if (u.preprocessingPreview || u.postprocessingPreview) return <WorkspaceRunCard
							key={u.sessionId} upload={u} phase={phases?.[u.sessionId]}
							actions={done ? <>
								<button type="button" onClick={() => onView(u)}>View</button>
								<button type="button" disabled={downloadBusy} onClick={() => onDownloadScan(u)}>Download</button>
							</> : undefined}
						/>;
						return (
							<div key={u.sessionId} className="bdm-row">
								<div className="bdm-row-main">
									<div className="bdm-row-title" id={`${rowId}-${index}-title`}>{u.label}</div>
									<div className="bdm-row-sub" id={`${rowId}-${index}-sub`}>
										{u.model ? `${u.model} · ` : ""}
										{formatRelativeTime(u.timestamp)}
									</div>
								</div>
								<div className="bdm-row-actions">
									<span className="bdm-status" style={{ color: recentStatusColor(u.status) }}>
										{u.status}
									</span>
									{done && (
										<>
											<button type="button" className="bdm-btn" aria-describedby={describedBy} onClick={() => onView(u)}>
												View
											</button>
											<button type="button" className="bdm-btn" aria-describedby={describedBy} disabled={downloadBusy} onClick={() => onDownloadScan(u)}>
												Download
											</button>
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};

export default BatchDetailsModal;
