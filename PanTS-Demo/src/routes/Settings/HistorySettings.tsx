import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
	formatRelativeTime,
	groupUploads,
	isGroupInFlight,
	loadRecentUploads,
	markRecentUploadViewed,
	isRecentUploadsStorageKey,
	RECENT_UPLOADS_CHANGED,
	removeRecentUpload,
	splitByAge,
	type RecentUpload,
	type UploadGroup,
} from "../../helpers/recentUploads";
import "./HistorySettings.css";

const groupKey = (g: UploadGroup) => (g.kind === "single" ? g.upload.sessionId : g.batchId);

// History: every scan that's either already been viewed, or has sat unviewed
// for more than a day. The Upload page only keeps unviewed, recent scans so
// it stays a workbench rather than a filing cabinet; everything else lives
// here (see splitByAge).
//
// Labels and grouping use the same account-scoped browser history as Upload.
// The legacy list is visible only after server-side ownership verification.
const HistorySettings: React.FC = () => {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const [uploads, setUploads] = useState<RecentUpload[]>(() => loadRecentUploads());
	const batchId = searchParams.get("batch");
	const sessionId = searchParams.get("session");
	const [expandedBatch, setExpandedBatch] = useState<string | null>(batchId);
	const selectedRow = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const refresh = () => setUploads(loadRecentUploads());
		const storage = (event: StorageEvent) => { if (isRecentUploadsStorageKey(event.key)) refresh(); };
		window.addEventListener(RECENT_UPLOADS_CHANGED, refresh);
		window.addEventListener("storage", storage);
		return () => {
			window.removeEventListener(RECENT_UPLOADS_CHANGED, refresh);
			window.removeEventListener("storage", storage);
		};
	}, []);

	const finished = groupUploads(uploads).filter((g) => !isGroupInFlight(g));
	const { older } = splitByAge(finished);
	const selected = finished.find((group) => group.kind === "batch"
		? group.batchId === batchId : group.upload.sessionId === sessionId);
	// A direct sidebar link can refer to a finished run less than a day old.
	// Include it without moving or changing the run's viewed state.
	const groups = selected && !older.includes(selected) ? [selected, ...older] : older;
	const selectionExists = Boolean(selected);
	useEffect(() => { setExpandedBatch(batchId); }, [batchId]);
	useEffect(() => {
		if (!selectionExists) return;
		selectedRow.current?.scrollIntoView?.({ block: "center" });
		selectedRow.current?.focus();
	}, [batchId, sessionId, selectionExists]);

	// Removing a row unmounts the button that had focus, which would drop it to
	// the page. The row to land on is chosen before the removal and focused
	// once the list has re-rendered: the next row's Remove, else the previous
	// one's, else the empty message. Only when focus was on that Remove, so a
	// mouse press elsewhere on the page is not pulled back here.
	const removeButtons = useRef(new Map<string, HTMLButtonElement>());
	const emptyNote = useRef<HTMLDivElement>(null);
	const focusAfter = useRef<string | null>(null);
	useEffect(() => {
		const key = focusAfter.current;
		if (key === null) return;
		focusAfter.current = null;
		(key === "" ? emptyNote.current : removeButtons.current.get(key))?.focus();
	}, [uploads]);

	const remove = (group: UploadGroup) => {
		if (document.activeElement === removeButtons.current.get(groupKey(group))) {
			const at = groups.indexOf(group);
			const neighbour = groups[at + 1] ?? groups[at - 1];
			focusAfter.current = neighbour ? groupKey(neighbour) : "";
		}
		const ids =
			group.kind === "single" ? [group.upload.sessionId] : group.uploads.map((u) => u.sessionId);
		let next = uploads;
		ids.forEach((id) => { next = removeRecentUpload(id); });
		setUploads(next);
		if (group === selected) setSearchParams({}, { replace: true });
	};

	const open = (u: RecentUpload) => {
		if (u.status !== "Completed") return;
		markRecentUploadViewed(u.sessionId);
		navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${encodeURIComponent(u.sessionId)}`);
	};

	return (
		<div className="set-group">
			<h2 className="set-heading">History</h2>
			<p className="set-sub">
				Viewed scans and scans older than a day. Newer, unviewed scans stay in your workspace.
			</p>

			{(batchId || sessionId) && !selected && <p role="status" className="set-sub">This run is no longer available in this browser's history.</p>}
			{groups.length === 0 ? (
				<div className="set-empty" ref={emptyNote} tabIndex={-1}>Nothing here yet.</div>
			) : (
				<div className="set-history-list">
					{groups.map((g) => {
						const first = g.kind === "single" ? g.upload : g.uploads[0];
						const label = g.kind === "single" ? g.upload.label : g.label;
						const meta =
							g.kind === "single"
								? `${g.upload.model ? `${g.upload.model} · ` : ""}${g.upload.status} · ${formatRelativeTime(g.timestamp)}`
								: `${g.uploads.filter((u) => u.status === "Completed").length} of ${g.uploads.length} completed · ${formatRelativeTime(g.timestamp)}`;
						const expanded = g.kind === "batch" && expandedBatch === g.batchId;
						const detailsId = g.kind === "batch" ? `history-batch-${encodeURIComponent(g.batchId)}` : undefined;
						return (
							<div key={g.kind === "single" ? g.upload.sessionId : g.batchId}
								ref={g === selected ? selectedRow : undefined} tabIndex={g === selected ? -1 : undefined}
								className="set-history-entry">
							<div className="set-history-row">
								<div style={{ minWidth: 0 }}>
									<div className="set-history-name">{label}</div>
									<div className="set-history-meta">{meta}</div>
								</div>
								<div className="set-history-actions">
									{g.kind === "batch" ? (
										<button type="button" className="set-btn" aria-expanded={expanded} aria-controls={detailsId}
											onClick={() => setExpandedBatch(expanded ? null : g.batchId)}>
											{expanded ? "Hide details" : "View details"}
										</button>
									) : first.status === "Completed" && (
										<button type="button" className="set-btn" onClick={() => open(first)}>
											View
										</button>
									)}
									<button
										type="button"
										className="set-btn"
										ref={(el) => {
											if (el) removeButtons.current.set(groupKey(g), el);
											else removeButtons.current.delete(groupKey(g));
										}}
										onClick={() => remove(g)}
									>
										Remove
									</button>
								</div>
							</div>
							{g.kind === "batch" && expanded && <div id={detailsId} className="set-history-batch" role="region" aria-label={`${label} scans`}>
								{g.uploads.map((upload) => <div key={upload.sessionId} className="set-history-row">
									<div style={{ minWidth: 0 }}><div className="set-history-name">{upload.label}</div><div className="set-history-meta">{upload.model} · {upload.status}</div></div>
									{upload.status === "Completed" && <button type="button" className="set-btn" aria-label={`View ${upload.label}`} onClick={() => open(upload)}>View</button>}
								</div>)}
							</div>}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

export default HistorySettings;
