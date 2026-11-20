import { useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import AssignmentCaseCard from "../../components/AssignmentCaseCard";
import { useAuth } from "../../contexts/authContext";
import { type Assignment, type CaseStatus, dueLabel, dueState, nextTodo, rangeLabel, statusOf } from "../../helpers/assignments";
import { useMyAssignments } from "../../helpers/useMyAssignments";
import home from "../Homepage/Homepage.module.css";
import "./AssignmentsPage.css";

// The direct range-handout queue is one part of the unified Assignments workspace.

type Filter = "all" | CaseStatus;
const PAGE = 24;
const FILTERS: { value: Filter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "todo", label: "Pending" },
	{ value: "done", label: "Complete" },
	{ value: "flagged", label: "Flagged" },
];

type Row = { a: Assignment; n: number; status: CaseStatus };

export default function DirectRangeAssignments() {
	const { user, loading, isAuthenticated } = useAuth();
	const eligible = !!user;
	const { assignments, error, reload } = useMyAssignments(eligible);
	// Until they choose, show what is left to do: finished cases would otherwise fill the top of the list.
	const [picked, setPicked] = useState<Filter | null>(null);
	const [which, setWhich] = useState("all");
	const [shown, setShown] = useState(PAGE);

	const chosen = useMemo(() => (assignments ?? []).filter((a) => which === "all" || a.id === which), [assignments, which]);
	const counts = useMemo(() => chosen.reduce((c, a) => ({ todo: c.todo + a.todo, done: c.done + a.done, flagged: c.flagged + a.flagged }), { todo: 0, done: 0, flagged: 0 }), [chosen]);
	const total = counts.todo + counts.done + counts.flagged;
	const filter: Filter = picked ?? (counts.todo > 0 ? "todo" : "all");

	// Only the cards on screen are built: an assignment can hold tens of thousands of cases.
	const rows = useMemo(() => {
		const out: Row[] = [];
		const heads = chosen.map((a) => ({ a, at: a.start }));
		while (out.length <= shown) {
			let best: { a: Assignment; at: number } | null = null;
			for (const h of heads) if (h.at <= h.a.end && (best === null || h.at < best.at)) best = h;
			if (!best) break;
			const n = best.at++;
			const status = statusOf(best.a, n);
			if (filter === "all" || filter === status) out.push({ a: best.a, n, status });
		}
		return out;
	}, [chosen, filter, shown]);
	const more = rows.length > shown;
	const visible = rows.slice(0, shown);

	if (!loading && !isAuthenticated) return <Navigate to="/" replace />;
	if (!loading && !eligible) return <Navigate to="/dashboard" replace />;

	const pick = (value: Filter) => { setPicked(value); setShown(PAGE); };
	const pickAssignment = (value: string) => { setWhich(value); setShown(PAGE); };
	const resume = chosen.map((a) => ({ a, n: nextTodo(a) })).find((x) => x.n !== null);
	const dueSoonest = chosen.filter((a) => a.todo > 0 && a.due_at).sort((x, y) => Date.parse(x.due_at!) - Date.parse(y.due_at!))[0];

	return (
		<section className={home.page} aria-labelledby="range-work-title" data-testid="direct-range-work">
			<div className={home.heading}>
				<span className={home.eyebrow}>Direct handouts</span>
				<h2 id="range-work-title">Case-range assignments</h2>
				<p>Cases assigned to you directly. Open one, annotate it, then mark it done or flag it.</p>
			</div>

			{error && <p className={home.error} role="alert">{error} <button type="button" className="asg-link-btn" onClick={reload}>Try again</button></p>}
			{assignments === null && !error && <p className="asg-page-note">Loading…</p>}

			{assignments !== null && assignments.length === 0 && (
					<div className="asg-empty" data-testid="no-assignments">
						<h3>No direct case ranges</h3>
						<p>Project assignments appear in the Project work section above.</p>
					</div>
				)}

			{assignments !== null && assignments.length > 0 && (
					<>
						<section className="asg-summary-card" aria-label="Progress">
							<div className="asg-summary-top">
								<div>
									<strong data-testid="summary">{counts.done} of {total} complete</strong>
									<span className="asg-summary-sub">
										{counts.todo} pending{counts.flagged ? `, ${counts.flagged} flagged` : ""}
										{dueSoonest && dueLabel(dueSoonest.due_at) ? <span className={`asg-due asg-due--${dueState(dueSoonest.due_at)}`}>{dueState(dueSoonest.due_at) === "overdue" ? "Overdue, was due" : "Next due"} {dueLabel(dueSoonest.due_at)}</span> : null}
									</span>
								</div>
								{resume ? (
									<Link className="asg-primary" to={`/case/${resume.n}`}>
										{counts.done + counts.flagged === 0 ? "Start" : "Continue"} with case {resume.n}
									</Link>
								) : <span className="asg-finished" role="status">Everything is marked. Nice work.</span>}
							</div>
							<div className="asg-bar-track" role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={counts.done}>
								<div className="asg-bar-done" style={{ width: `${total ? (100 * counts.done) / total : 0}%` }} />
								<div className="asg-bar-flag" style={{ width: `${total ? (100 * counts.flagged) / total : 0}%` }} />
							</div>
						</section>

						<div className="asg-toolbar">
							<div className="asg-filters" role="group" aria-label="Show cases">
								{FILTERS.map((f) => (
									<button key={f.value} type="button" className={`asg-pill ${filter === f.value ? "asg-pill--on" : ""}`} aria-pressed={filter === f.value} onClick={() => pick(f.value)}>
										{f.label} <span className="asg-pill-count">{f.value === "all" ? total : counts[f.value]}</span>
									</button>
								))}
							</div>
							{assignments.length > 1 && (
								<label className="asg-which">
									<span>Assignment</span>
									<select value={which} onChange={(e) => pickAssignment(e.target.value)}>
										<option value="all">All assignments</option>
										{assignments.map((a) => <option key={a.id} value={a.id}>{a.task}, cases {rangeLabel(a)}</option>)}
									</select>
								</label>
							)}
						</div>

						{chosen.length === 1 && (
							<section className="asg-task-card" data-testid="task-line" aria-label="What to annotate">
								<div className="asg-task-main">
									<span className="asg-task-label">What to annotate</span>
									<h2>{chosen[0].task}</h2>
								</div>
								<span className="asg-task-range">Cases {rangeLabel(chosen[0])}</span>
								{chosen[0].note && <p className="asg-task-note">{chosen[0].note}</p>}
							</section>
						)}

						{visible.length === 0 ? (
							<p className="asg-page-note" data-testid="no-matches">
								{filter === "todo" ? "No pending cases. Everything is marked." : filter === "done" ? "No cases are complete yet." : filter === "flagged" ? "No cases are flagged." : "No cases."}
							</p>
						) : (
							<ul className="asg-grid" aria-label="Cases">
								{visible.map(({ a, n, status }) => (
									<li key={`${a.id}-${n}`}>
										<AssignmentCaseCard number={n} status={status} task={assignments.length > 1 && which === "all" ? a.task : undefined} next={status === "todo" && resume?.a.id === a.id && resume.n === n} />
									</li>
								))}
							</ul>
						)}
						{more && (
							<div className="asg-more">
								<button type="button" className="asg-secondary" onClick={() => setShown((s) => s + PAGE)}>Show more</button>
							</div>
						)}
					</>
				)}
		</section>
	);
}
