import { useMemo, useState } from "react";
import {
	type Assignment,
	type Person,
	deleteAssignment,
	dueState,
	rangeLabel,
	updateAssignment,
	whoLabel,
} from "../../helpers/assignments";
import { Due, Progress, initialsOf } from "./parts";

// One card per person: what they have, how far along they are, and the two things you do with it (give it to someone
// else, remove it). A person with nothing yet gets a dashed card with a button that opens the Hand out window with
// them already ticked.

type Filter = "all" | "late" | "none" | "done";

type Entry = { id: string; label: string; email: string | null; assignments: Assignment[]; late: boolean; finished: boolean };

export function buildEntries(all: Assignment[], people: Person[]): Entry[] {
	const byPerson = new Map<string, Entry>();
	for (const p of people) {
		if (!p.annotator && !p.manager) continue;
		byPerson.set(p.id, { id: p.id, label: whoLabel(p), email: p.name ? p.email : null, assignments: [], late: false, finished: false });
	}
	for (const a of all) {
		// someone who has since stopped being an annotator still has their cases on record
		const entry = byPerson.get(a.assignee.id) ?? { id: a.assignee.id, label: whoLabel(a.assignee), email: a.assignee.name ? a.assignee.email : null, assignments: [], late: false, finished: false };
		entry.assignments.push(a);
		byPerson.set(a.assignee.id, entry);
	}
	const out = [...byPerson.values()];
	for (const e of out) {
		e.assignments.sort((x, y) => x.start - y.start);
		e.late = e.assignments.some((a) => a.todo > 0 && dueState(a.due_at) === "overdue");
		e.finished = e.assignments.length > 0 && e.assignments.every((a) => a.todo === 0);
	}
	// people with cases first, then the ones still waiting; alphabetical inside each group
	return out.sort((x, y) => Number(x.assignments.length === 0) - Number(y.assignments.length === 0) || x.label.localeCompare(y.label));
}

const FILTERS: { value: Filter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "late", label: "Overdue" },
	{ value: "none", label: "No cases yet" },
	{ value: "done", label: "Done" },
];

const matches = (e: Entry, f: Filter) => f === "all" || (f === "late" && e.late) || (f === "none" && e.assignments.length === 0) || (f === "done" && e.finished);

export default function PeopleCards({ all, people, onChanged, onHandOut }: {
	all: Assignment[];
	people: Person[];
	onChanged: () => void;
	onHandOut: (personId: string) => void;
}) {
	const [removing, setRemoving] = useState<string | null>(null);
	const [moving, setMoving] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");

	const entries = useMemo(() => buildEntries(all, people), [all, people]);
	const needle = query.trim().toLowerCase();
	const shown = entries.filter((e) => matches(e, filter) && (!needle || `${e.label} ${e.email ?? ""}`.toLowerCase().includes(needle)));
	const crowded = entries.length > 8; // with a handful of people the search and filters would only be in the way
	const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, entries.filter((e) => matches(e, f.value)).length])), [entries]);
	const targets = people.filter((p) => p.annotator || p.manager);

	const act = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
		setBusy(true);
		setError(null);
		const res = await fn();
		setBusy(false);
		if (!res.ok) {
			setError(res.message ?? "Something went wrong. Try again.");
			return;
		}
		setRemoving(null);
		setMoving(null);
		onChanged();
	};

	if (entries.length === 0) {
		return <p className="asg-note asg-empty" data-testid="no-people">There are no annotators yet. Press Annotators to add people, then hand out cases.</p>;
	}

	return (
		<div data-testid="everyone">
			{crowded && (
				<div className="asg-find">
					<input className="asg-input" type="search" placeholder="Find a person" aria-label="Find a person in the cards" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
					<div className="asg-filter-row" role="group" aria-label="Show people">
						{FILTERS.map((f) => (
							<button key={f.value} type="button" className={`asg-pill ${filter === f.value ? "asg-pill--on" : ""}`} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
								{f.label} <span className="asg-pill-count">{counts[f.value]}</span>
							</button>
						))}
					</div>
				</div>
			)}
			{error && <p className="asg-banner asg-banner--error" role="alert">{error}</p>}
			{shown.length === 0 ? (
				<p className="asg-note asg-empty" data-testid="no-match">No one matches.</p>
			) : (
				<div className="asg-pgrid">
					{shown.map((e) => (
						<article key={e.id} className={`asg-pcard ${e.assignments.length === 0 ? "asg-pcard--empty" : ""} ${e.late ? "asg-pcard--late" : ""}`} data-testid="person-card" aria-label={e.label}>
							<header className="asg-pcard-head">
								<span className="asg-avatar" aria-hidden="true">{initialsOf(e.label)}</span>
								<div>
									<strong>{e.label}</strong>
									{e.email && <span className="asg-pcard-email">{e.email}</span>}
								</div>
							</header>

							{e.assignments.length === 0 ? (
								<>
									<p className="asg-pcard-none">No cases yet</p>
									<button type="button" className="asg-btn asg-btn--primary" onClick={() => onHandOut(e.id)}>+ Hand out cases</button>
								</>
							) : (
								e.assignments.map((a) => (
									<div key={a.id} className="asg-pa" data-testid="assignment-row">
										<div className="asg-pa-head">
											<strong>{a.task}</strong>
											<span className="asg-range">Cases {rangeLabel(a)}</span>
										</div>
										<Progress a={a} />
										<div className="asg-pa-foot">
											<Due iso={a.due_at} />
											{moving === a.id ? (
												<span className="asg-inline">
													<select className="asg-input asg-input--small" aria-label={`Give ${a.task} cases ${rangeLabel(a)} to`} defaultValue="" disabled={busy}
														onChange={(ev) => ev.target.value && void act(() => updateAssignment(a.id, { assignee_id: ev.target.value }))}>
														<option value="" disabled>Choose a person</option>
														{targets.filter((p) => p.id !== a.assignee.id).map((p) => <option key={p.id} value={p.id}>{whoLabel(p)}</option>)}
													</select>
													<button type="button" className="asg-link" onClick={() => setMoving(null)}>Cancel</button>
												</span>
											) : removing === a.id ? (
												<span className="asg-inline asg-inline--wrap">
													<span className="asg-confirm-text">
														Remove {a.task}, cases {rangeLabel(a)}{a.done + a.flagged ? `, and the ${a.done + a.flagged} marks already made` : ""}?
													</span>
													<button type="button" className="asg-btn asg-btn--danger asg-btn--small" disabled={busy} onClick={() => void act(() => deleteAssignment(a.id))}>Yes, remove</button>
													<button type="button" className="asg-btn asg-btn--small" onClick={() => setRemoving(null)}>Keep</button>
												</span>
											) : (
												<span className="asg-inline">
													<button type="button" className="asg-link" onClick={() => { setMoving(a.id); setRemoving(null); }}>Give to someone else ›</button>
													<button type="button" className="asg-link asg-link--muted" onClick={() => { setRemoving(a.id); setMoving(null); }}>Remove</button>
												</span>
											)}
										</div>
									</div>
								))
							)}
						</article>
					))}
				</div>
			)}
		</div>
	);
}
