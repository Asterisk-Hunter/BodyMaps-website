import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { type Assignment, dueLabel, rangeLabel } from "../helpers/assignments";
import "./AssignmentNotice.css";

// A one-time notice when someone opens the website after being handed cases (or being made an annotator): what they
// were given and a button to the Assignments page. What has been shown is remembered in this browser, per account, so
// it appears once for each new hand-out and not on every visit. The Assignments tab keeps showing the pending count.

const seenKey = (userId: string) => `bodymaps.assignments.seen.${userId}`;
const welcomedKey = (userId: string) => `bodymaps.annotator.welcomed.${userId}`;

function read(key: string): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}
function write(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* private mode or blocked storage: the notice may appear again next time, which is harmless */
	}
}

export default function AssignmentNotice({ userId, assignments, canWelcome }: { userId: string; assignments: Assignment[] | null; canWelcome: boolean }) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const [dismissed, setDismissed] = useState(false);
	const primary = useRef<HTMLButtonElement>(null);

	const seen = new Set(read(seenKey(userId)));
	const fresh = (assignments ?? []).filter((a) => !seen.has(a.id) && a.todo > 0);
	const welcome = canWelcome && assignments !== null && assignments.length === 0 && read(welcomedKey(userId)).length === 0;
	const open = !dismissed && pathname !== "/assignments" && (fresh.length > 0 || welcome);

	useEffect(() => {
		if (open) primary.current?.focus();
	}, [open]);

	if (!open) return null;

	const close = (go: boolean) => {
		write(seenKey(userId), [...new Set([...seen, ...(assignments ?? []).map((a) => a.id)])]);
		write(welcomedKey(userId), ["yes"]);
		setDismissed(true);
		if (go) navigate("/assignments");
	};
	const totalCases = fresh.reduce((n, a) => n + a.todo, 0);

	return (
		<div className="asg-notice-backdrop" role="presentation" onKeyDown={(e) => { if (e.key === "Escape") close(false); }}>
			<div className="asg-notice" role="dialog" aria-modal="true" aria-labelledby="asg-notice-title" data-testid="assignment-notice">
				{fresh.length > 0 ? (
					<>
						<h2 id="asg-notice-title">You have {totalCases} {totalCases === 1 ? "case" : "cases"} to annotate</h2>
						<ul className="asg-notice-list">
							{fresh.map((a) => (
								<li key={a.id}>
									<strong>{a.task}</strong>
									<span>Cases {rangeLabel(a)}, {a.todo} to do{dueLabel(a.due_at) ? `, due ${dueLabel(a.due_at)}` : ""}</span>
									{a.note && <em>{a.note}</em>}
								</li>
							))}
						</ul>
					</>
				) : (
					<>
						<h2 id="asg-notice-title">You are now an annotator</h2>
						<p>Cases handed to you will appear in the Assignments tab on the left, and you will see a notice like this one.</p>
					</>
				)}
				<div className="asg-notice-actions">
					<button ref={primary} type="button" className="asg-notice-primary" onClick={() => close(true)}>Open my assignments</button>
					<button type="button" className="asg-notice-later" onClick={() => close(false)}>Not now</button>
				</div>
			</div>
		</div>
	);
}
