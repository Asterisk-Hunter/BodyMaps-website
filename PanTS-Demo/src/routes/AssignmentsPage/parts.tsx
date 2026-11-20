import { type Assignment, dueLabel, dueState, percentDone, rangeLabel } from "../../helpers/assignments";

/** A progress bar for one assignment: green for done, orange for flagged; the whole bar turns amber when it is overdue. */
export function Progress({ a }: { a: Assignment }) {
	const pct = percentDone(a);
	const flaggedPct = a.total ? (100 * a.flagged) / a.total : 0;
	const late = a.todo > 0 && dueState(a.due_at) === "overdue";
	return (
		<div className="asg-progress">
			<div
				className={`asg-track ${late ? "asg-track--late" : ""}`}
				role="progressbar"
				aria-label={`${a.task}, cases ${rangeLabel(a)}`}
				aria-valuemin={0}
				aria-valuemax={a.total}
				aria-valuenow={a.done}
			>
				<div className="asg-fill" style={{ width: `${pct}%` }} />
				<div className="asg-fill asg-fill--flag" style={{ width: `${flaggedPct}%` }} />
			</div>
			<span className="asg-count">
				{a.done} of {a.total} done{a.flagged > 0 ? `, ${a.flagged} flagged` : ""}
			</span>
		</div>
	);
}

export function Due({ iso }: { iso: string | null }) {
	const state = dueState(iso);
	if (state === "none" || !dueLabel(iso)) return null;
	return <span className={`asg-due asg-due--${state}`}>{state === "overdue" ? "Overdue, was due" : "Due"} {dueLabel(iso)}</span>;
}

/** Two letters for a round avatar. */
export const initialsOf = (label: string): string =>
	label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
