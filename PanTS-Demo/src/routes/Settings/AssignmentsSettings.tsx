import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import {
	type Assignment,
	type Overlap,
	type Person,
	createAssignment,
	deleteAssignment,
	dueLabel,
	dueState,
	fetchAll,
	fetchMine,
	fetchPeople,
	libraryMaxNumber,
	nextTodo,
	parseRange,
	percentDone,
	rangeLabel,
	splitRange,
	statusOf,
	updateAssignment,
	whoLabel,
} from "../../helpers/assignments";
import "./AssignmentsSettings.css";

// Assignments: who annotates which cases.
//
// An annotator sees "My cases": each hand-out with its progress and a Continue button that opens the next case still
// to do. An annotation manager also sees "Hand out cases" (a range, a task, one or more people) and "Everyone's
// progress". Both halves are for the people holding those roles; the server checks the role on every call, so hiding
// a section here is presentation, not access control.

const CHIPS_AT_A_TIME = 200;

function Progress({ a }: { a: Assignment }) {
	const pct = percentDone(a);
	const flaggedPct = a.total ? (100 * a.flagged) / a.total : 0;
	return (
		<div className="asg-progress">
			<div
				className="asg-track"
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

function Due({ iso }: { iso: string | null }) {
	const state = dueState(iso);
	if (state === "none" || !dueLabel(iso)) return null;
	return <span className={`asg-due asg-due--${state}`}>{state === "overdue" ? "Overdue, was due" : "Due"} {dueLabel(iso)}</span>;
}

function MyCard({ a }: { a: Assignment }) {
	const [open, setOpen] = useState(false);
	const [shown, setShown] = useState(CHIPS_AT_A_TIME);
	const next = nextTodo(a);
	const cases = useMemo(() => {
		const out: number[] = [];
		for (let n = a.start; n <= a.end && out.length < shown; n++) out.push(n);
		return out;
	}, [a.start, a.end, shown]);
	return (
		<article className="asg-card" data-testid="my-assignment">
			<header className="asg-card-head">
				<div>
					<h3 className="asg-task">{a.task}</h3>
					<p className="asg-range">Cases {rangeLabel(a)}</p>
				</div>
				<Due iso={a.due_at} />
			</header>
			{a.note && <p className="asg-note">{a.note}</p>}
			<Progress a={a} />
			<div className="asg-actions">
				{next !== null ? (
					<Link className="set-btn set-btn--primary" to={`/case/${next}`}>
						{a.done + a.flagged === 0 ? "Start" : "Continue"} with case {next}
					</Link>
				) : (
					<span className="asg-finished" role="status">All {a.total} cases are marked. Nice work.</span>
				)}
				<button type="button" className="set-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
					{open ? "Hide cases" : "Show all cases"}
				</button>
			</div>
			{open && (
				<>
					<ul className="asg-chips" aria-label="Cases in this assignment">
						{cases.map((n) => {
							const status = statusOf(a, n);
							return (
								<li key={n}>
									<Link className={`asg-chip asg-chip--${status}`} to={`/case/${n}`} title={status === "todo" ? "To do" : status === "done" ? "Done" : "Flagged for a second look"}>
										{n}
									</Link>
								</li>
							);
						})}
					</ul>
					{shown < a.total && (
						<button type="button" className="set-btn" onClick={() => setShown((s) => s + CHIPS_AT_A_TIME)}>
							Show more
						</button>
					)}
					<p className="set-row-note asg-legend">
						<span className="asg-chip asg-chip--todo">To do</span> <span className="asg-chip asg-chip--done">Done</span> <span className="asg-chip asg-chip--flagged">Flagged</span>
					</p>
				</>
			)}
		</article>
	);
}

type Pending = { person: Person; range: [number, number] }[];

function HandOut({ people, tasks, onCreated }: { people: Person[]; tasks: string[]; onCreated: () => void }) {
	const [cases, setCases] = useState("");
	const [task, setTask] = useState("");
	const [due, setDue] = useState("");
	const [note, setNote] = useState("");
	const [chosen, setChosen] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const [overlaps, setOverlaps] = useState<{ who: string; list: Overlap[] } | null>(null);
	const [pending, setPending] = useState<Pending>([]);
	// How many cases the library really has, so a range past the end is caught here and not on an annotator's screen.
	const [libraryMax, setLibraryMax] = useState<number | null>(null);
	useEffect(() => {
		let cancelled = false;
		void libraryMaxNumber().then((max) => { if (!cancelled) setLibraryMax(max); }).catch(() => undefined);
		return () => { cancelled = true; };
	}, []);

	const range = parseRange(cases);
	const picked = people.filter((p) => chosen.includes(p.id));
	const blocks = range && picked.length ? splitRange(range[0], range[1], picked.length) : null;
	const visible = people.filter((p) => `${p.name ?? ""} ${p.email}`.toLowerCase().includes(filter.trim().toLowerCase()));

	const problem = (() => {
		if (!cases.trim()) return "Type the cases, for example 55 to 95.";
		if (!range) return "Write the cases as two numbers, for example 55 to 95.";
		if (libraryMax !== null && range[1] > libraryMax) return `The library has cases 1 to ${libraryMax}. Choose cases up to ${libraryMax}.`;
		if (!task.trim()) return "Say what to annotate, for example Veins and arteries.";
		if (!picked.length) return "Choose at least one person.";
		if (!blocks) return `That is ${range[1] - range[0] + 1} cases for ${picked.length} people. Choose fewer people or a bigger range.`;
		return null;
	})();

	const run = async (queue: Pending, force: boolean) => {
		setBusy(true);
		setError(null);
		setOverlaps(null);
		let made = 0;
		for (let i = 0; i < queue.length; i++) {
			const { person, range: r } = queue[i];
			const res = await createAssignment({
				assignee_id: person.id, start: r[0], end: r[1], task: task.trim(), note: note.trim() || undefined, due: due || undefined, force,
			});
			if (res.ok) {
				made++;
				continue;
			}
			setPending(queue.slice(i));
			if (res.reason === "overlap" && res.overlaps) setOverlaps({ who: whoLabel(person), list: res.overlaps });
			else setError(`${whoLabel(person)}: ${res.message}`);
			if (made) onCreated();
			setBusy(false);
			return;
		}
		setPending([]);
		setDone(`Handed out ${made} ${made === 1 ? "assignment" : "assignments"}.`);
		setCases("");
		setNote("");
		setChosen([]);
		onCreated();
		setBusy(false);
	};

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setDone(null);
		if (problem || !blocks) return;
		void run(picked.map((person, i) => ({ person, range: blocks[i] })), false);
	};

	const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

	return (
		<form className="asg-form" onSubmit={submit} data-testid="hand-out">
			<div className="asg-grid">
				<label className="asg-field">
					<span>Cases</span>
					<input className="set-input" inputMode="numeric" placeholder="55 to 95" value={cases} onChange={(e) => setCases(e.target.value)} disabled={busy} />
				</label>
				<label className="asg-field">
					<span>What to annotate</span>
					<input className="set-input" list="asg-tasks" placeholder="Veins and arteries" value={task} onChange={(e) => setTask(e.target.value)} disabled={busy} maxLength={120} />
					<datalist id="asg-tasks">{tasks.map((t) => <option key={t} value={t} />)}</datalist>
				</label>
				<label className="asg-field">
					<span>Due (optional)</span>
					<input className="set-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={busy} />
				</label>
			</div>
			<label className="asg-field">
				<span>Note for the annotator (optional)</span>
				<textarea className="set-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={2000} />
			</label>
			<fieldset className="asg-people" disabled={busy}>
				<legend>Who</legend>
				{people.length === 0 ? (
					<p className="set-row-note">Nobody can be given cases yet. Make someone an annotator first (Account, People).</p>
				) : (
					<>
						<input className="set-input" type="search" placeholder="Find a person" aria-label="Find a person" value={filter} onChange={(e) => setFilter(e.target.value)} />
						<ul className="asg-picklist">
							{visible.map((p) => (
								<li key={p.id}>
									<label>
										<input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
										<span>{whoLabel(p)}</span>
										{p.name && <span className="set-row-note"> {p.email}</span>}
									</label>
								</li>
							))}
							{visible.length === 0 && <li className="set-row-note">No one matches.</li>}
						</ul>
					</>
				)}
			</fieldset>

			{blocks && range && (
				<div className="asg-preview" aria-live="polite" data-testid="split-preview">
					{picked.length === 1
						? <p>{whoLabel(picked[0])} gets cases {rangeLabel({ start: range[0], end: range[1] })}.</p>
						: (
							<>
								<p>Cases {rangeLabel({ start: range[0], end: range[1] })} are split evenly, in the order shown:</p>
								<ul>{picked.map((p, i) => <li key={p.id}>{whoLabel(p)}: {rangeLabel({ start: blocks[i][0], end: blocks[i][1] })} ({blocks[i][1] - blocks[i][0] + 1} cases)</li>)}</ul>
							</>
						)}
				</div>
			)}

			{overlaps && (
				<div className="set-banner set-banner--error" role="alert" data-testid="overlap-warning">
					<p>
						Some of these cases are already handed out for the same task:
					</p>
					<ul>
						{overlaps.list.map((o) => <li key={o.id}>{o.assignee} has {rangeLabel({ start: o.start, end: o.end })} (shared: {rangeLabel({ start: o.shared_start, end: o.shared_end })})</li>)}
					</ul>
					<p className="set-row-note">Giving the same cases to two people is right for a second reader, and a slip otherwise.</p>
					<div className="asg-actions">
						<button type="button" className="set-btn set-btn--danger" disabled={busy} onClick={() => void run(pending, true)}>Hand out anyway</button>
						<button type="button" className="set-btn" disabled={busy} onClick={() => { setOverlaps(null); setPending([]); }}>Change the cases</button>
					</div>
				</div>
			)}
			{error && <p className="set-banner set-banner--error" role="alert">{error}</p>}
			{done && <p className="set-banner" role="status">{done}</p>}

			<div className="asg-actions">
				<button className="set-btn set-btn--primary" type="submit" disabled={busy || !!problem}>
					{busy ? "Handing out…" : picked.length > 1 ? `Hand out to ${picked.length} people` : "Hand out cases"}
				</button>
				{problem && cases.trim() !== "" && <span className="set-row-note">{problem}</span>}
			</div>
		</form>
	);
}

function Everyone({ all, people, onChanged }: { all: Assignment[]; people: Person[]; onChanged: () => void }) {
	const [removing, setRemoving] = useState<string | null>(null);
	const [moving, setMoving] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const byPerson = useMemo(() => {
		const map = new Map<string, { label: string; items: Assignment[] }>();
		for (const a of all) {
			const entry = map.get(a.assignee.id) ?? { label: whoLabel(a.assignee), items: [] };
			entry.items.push(a);
			map.set(a.assignee.id, entry);
		}
		return [...map.entries()].sort((x, y) => x[1].label.localeCompare(y[1].label));
	}, [all]);

	const totals = useMemo(() => all.reduce((t, a) => ({ total: t.total + a.total, done: t.done + a.done, flagged: t.flagged + a.flagged }), { total: 0, done: 0, flagged: 0 }), [all]);

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

	if (!all.length) return <p className="set-row-note">Nothing has been handed out yet.</p>;
	return (
		<div data-testid="everyone">
			<p className="asg-summary">
				{byPerson.length} {byPerson.length === 1 ? "person" : "people"}, {all.length} {all.length === 1 ? "assignment" : "assignments"}, {totals.done} of {totals.total} cases done{totals.flagged ? `, ${totals.flagged} flagged` : ""}.
			</p>
			{error && <p className="set-banner set-banner--error" role="alert">{error}</p>}
			{byPerson.map(([id, { label, items }]) => (
				<section key={id} className="asg-person" aria-label={label}>
					<h3 className="asg-person-name">{label}</h3>
					{items.sort((x, y) => x.start - y.start).map((a) => (
						<div key={a.id} className="asg-row" data-testid="assignment-row">
							<div className="asg-row-main">
								<strong>{a.task}</strong>
								<span className="asg-range">Cases {rangeLabel(a)}</span>
								<Due iso={a.due_at} />
							</div>
							<Progress a={a} />
							<div className="asg-actions">
								{moving === a.id ? (
									<>
										<select className="set-input" aria-label={`Give ${a.task} cases ${rangeLabel(a)} to`} defaultValue="" disabled={busy}
											onChange={(e) => e.target.value && void act(() => updateAssignment(a.id, { assignee_id: e.target.value }))}>
											<option value="" disabled>Choose a person</option>
											{people.filter((p) => p.id !== a.assignee.id).map((p) => <option key={p.id} value={p.id}>{whoLabel(p)}</option>)}
										</select>
										<button type="button" className="set-btn" onClick={() => setMoving(null)}>Cancel</button>
									</>
								) : removing === a.id ? (
									<>
										<span className="set-confirm-text">
											Remove {a.task}, cases {rangeLabel(a)}{a.done + a.flagged ? `, and the ${a.done + a.flagged} marks already made` : ""}?
										</span>
										<button type="button" className="set-btn set-btn--danger" disabled={busy} onClick={() => void act(() => deleteAssignment(a.id))}>Yes, remove</button>
										<button type="button" className="set-btn" onClick={() => setRemoving(null)}>Keep</button>
									</>
								) : (
									<>
										<button type="button" className="set-btn" onClick={() => { setMoving(a.id); setRemoving(null); }}>Give to someone else</button>
										<button type="button" className="set-btn" onClick={() => { setRemoving(a.id); setMoving(null); }}>Remove</button>
									</>
								)}
							</div>
						</div>
					))}
				</section>
			))}
		</div>
	);
}

const AssignmentsSettings: React.FC = () => {
	const { user } = useAuth();
	const roles = user?.roles ?? [];
	const isManager = roles.includes("annotation_manager");
	const isAnnotator = isManager || roles.includes("annotator");

	const [mine, setMine] = useState<Assignment[] | null>(null);
	const [all, setAll] = useState<Assignment[]>([]);
	const [people, setPeople] = useState<Person[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		const [m, a, p] = await Promise.all([
			isAnnotator ? fetchMine() : null,
			isManager ? fetchAll() : null,
			isManager ? fetchPeople() : null,
		]);
		for (const r of [m, a, p]) if (r && !r.ok) setError(r.message);
		if (m?.ok) setMine(m.data.assignments);
		if (a?.ok) setAll(a.data.assignments);
		if (p?.ok) setPeople(p.data.people);
		if (!isAnnotator) setMine([]);
	}, [isAnnotator, isManager]);

	useEffect(() => { void load(); }, [load]);

	const tasks = useMemo(() => [...new Set(all.map((a) => a.task))].sort(), [all]);

	if (!isAnnotator) {
		return (
			<div className="set-group" data-testid="assignments-none">
				<h2 className="set-heading">Assignments</h2>
				<p className="set-sub">Assignments are for annotators. Ask an annotation manager to make your account an annotator.</p>
			</div>
		);
	}

	return (
		<div className="set-group asg" data-testid="assignments">
			<h2 className="set-heading">My cases</h2>
			<p className="set-sub">The cases handed to you. Open one, annotate it, then mark it done, or flag it if it needs a second look.</p>
			{error && <p className="set-banner set-banner--error" role="alert">{error} <button type="button" className="set-btn" onClick={() => void load()}>Try again</button></p>}
			{mine === null ? (
				<p className="set-row-note">Loading…</p>
			) : mine.length === 0 ? (
				<p className="set-row-note" data-testid="no-assignments">Nothing has been handed to you yet. When it is, it appears here.</p>
			) : (
				mine.map((a) => <MyCard key={a.id} a={a} />)
			)}

			{isManager && (
				<>
					<h2 className="set-heading asg-section">Hand out cases</h2>
					<p className="set-sub">Give a range of cases to one person, or split it evenly between several.</p>
					<HandOut people={people} tasks={tasks} onCreated={() => void load()} />

					<h2 className="set-heading asg-section">Everyone's progress</h2>
					<Everyone all={all} people={people} onChanged={() => void load()} />
				</>
			)}
		</div>
	);
};

export default AssignmentsSettings;
