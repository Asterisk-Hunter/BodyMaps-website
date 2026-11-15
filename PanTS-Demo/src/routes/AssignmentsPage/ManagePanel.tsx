import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type Assignment,
	type Overlap,
	type Person,
	createAssignment,
	deleteAssignment,
	MIN_ACCOUNT_SEARCH,
	makeAnnotator,
	removeAnnotator,
	searchAccounts,
	type Account,
	dueLabel,
	dueState,
	fetchAll,
	fetchPeople,
	libraryMaxNumber,
	parseRange,
	percentDone,
	rangeLabel,
	splitRange,
	updateAssignment,
	whoLabel,
} from "../../helpers/assignments";
import "./ManagePanel.css";

// The manager's half of the Assignments page: hand out cases (a range, a task, one or more people), follow everyone's
// progress, and choose who is an annotator. Only annotation managers are shown this, and the server checks the role on
// every call, so hiding it from others is presentation, not access control.

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

	const recent = tasks.slice(0, 6);
	const matched = range ? range[1] - range[0] + 1 : null;
	const stillNeeded = problem ?? null;

	return (
		<form className="asg-form" onSubmit={submit} data-testid="hand-out">
			<div className="asg-step">
				<span className="asg-step-num" aria-hidden="true">1</span>
				<div className="asg-step-body">
					<label className="asg-step-label" htmlFor="asg-cases">Cases</label>
					<input id="asg-cases" className="asg-input asg-input--big" inputMode="numeric" autoComplete="off" placeholder="Type the cases, like 55 to 95" aria-describedby="asg-cases-hint" value={cases} onChange={(e) => setCases(e.target.value)} disabled={busy} />
					<p id="asg-cases-hint" className="asg-hint">
						The first and last case number.
						{matched !== null && <strong className="asg-matched"> That is {matched} {matched === 1 ? "case" : "cases"}.</strong>}
					</p>
				</div>
			</div>

			<div className="asg-step">
				<span className="asg-step-num" aria-hidden="true">2</span>
				<div className="asg-step-body">
					<label className="asg-step-label" htmlFor="asg-task">What to annotate</label>
					<input id="asg-task" className="asg-input asg-input--big" list="asg-tasks" autoComplete="off" placeholder="Type what to annotate, like Veins and arteries" aria-describedby="asg-task-hint" value={task} onChange={(e) => setTask(e.target.value)} disabled={busy} maxLength={120} />
					<datalist id="asg-tasks">{tasks.map((t) => <option key={t} value={t} />)}</datalist>
					<p id="asg-task-hint" className="asg-hint">The structure or job they should do on each case.</p>
					{recent.length > 0 && (
						<div className="asg-chips" role="group" aria-label="Used before">
							<span className="asg-chips-label">Used before:</span>
							{recent.map((t) => (
								<button key={t} type="button" className={`asg-chip ${task.trim().toLowerCase() === t.toLowerCase() ? "asg-chip--on" : ""}`} disabled={busy} onClick={() => setTask(t)}>{t}</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="asg-step">
				<span className="asg-step-num" aria-hidden="true">3</span>
				<div className="asg-step-body">
					<fieldset className="asg-people" disabled={busy}>
						<legend className="asg-step-label">Who</legend>
						<p className="asg-hint">Tick one person. Tick several to split the cases evenly between them.</p>
						{people.length === 0 ? (
							<p className="asg-note">Nobody can be given cases yet. Make someone an annotator first (see Annotators below).</p>
						) : (
							<>
								{people.length > 6 && (
									<input className="asg-input" type="search" placeholder="Find a person" aria-label="Find a person" autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} />
								)}
								<ul className="asg-picklist">
									{visible.map((p) => (
										<li key={p.id}>
											<label className={chosen.includes(p.id) ? "is-on" : ""}>
												<input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
												<span className="asg-pick-name">{whoLabel(p)}</span>
												{p.name && <span className="asg-note"> {p.email}</span>}
											</label>
										</li>
									))}
									{visible.length === 0 && <li className="asg-note">No one matches.</li>}
								</ul>
								{picked.length > 0 && <p className="asg-selected" aria-live="polite">{picked.length} selected</p>}
							</>
						)}
					</fieldset>
				</div>
			</div>

			<details className="asg-more">
				<summary>Add a due date or a note (optional)</summary>
				<div className="asg-grid">
					<label className="asg-field">
						<span>Due (optional)</span>
						<input className="asg-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={busy} />
					</label>
					<label className="asg-field asg-field--wide">
						<span>Note for the annotator (optional)</span>
						<textarea className="asg-input" rows={2} placeholder="Anything they should know before they start" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={2000} />
					</label>
				</div>
			</details>

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
				<div className="asg-banner asg-banner--error" role="alert" data-testid="overlap-warning">
					<p>
						Some of these cases are already handed out for the same task:
					</p>
					<ul>
						{overlaps.list.map((o) => <li key={o.id}>{o.assignee} has {rangeLabel({ start: o.start, end: o.end })} (shared: {rangeLabel({ start: o.shared_start, end: o.shared_end })})</li>)}
					</ul>
					<p className="asg-note">Giving the same cases to two people is right for a second reader, and a slip otherwise.</p>
					<div className="asg-actions">
						<button type="button" className="asg-btn asg-btn--danger" disabled={busy} onClick={() => void run(pending, true)}>Hand out anyway</button>
						<button type="button" className="asg-btn" disabled={busy} onClick={() => { setOverlaps(null); setPending([]); }}>Change the cases</button>
					</div>
				</div>
			)}
			{error && <p className="asg-banner asg-banner--error" role="alert">{error}</p>}
			{done && <p className="asg-banner" role="status">{done}</p>}

			<div className="asg-submit">
				<button className="asg-btn asg-btn--primary asg-btn--big" type="submit" disabled={busy || !!problem}>
					{busy ? "Handing out…" : picked.length > 1 ? `Hand out to ${picked.length} people` : "Hand out cases"}
				</button>
				{stillNeeded && <span className="asg-needed">{cases.trim() === "" ? "Fill in steps 1 to 3 to continue." : stillNeeded}</span>}
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

	if (!all.length) return <p className="asg-note">Nothing has been handed out yet.</p>;
	return (
		<div data-testid="everyone">
			<p className="asg-summary">
				{byPerson.length} {byPerson.length === 1 ? "person" : "people"}, {all.length} {all.length === 1 ? "assignment" : "assignments"}, {totals.done} of {totals.total} cases done{totals.flagged ? `, ${totals.flagged} flagged` : ""}.
			</p>
			{error && <p className="asg-banner asg-banner--error" role="alert">{error}</p>}
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
										<select className="asg-input" aria-label={`Give ${a.task} cases ${rangeLabel(a)} to`} defaultValue="" disabled={busy}
											onChange={(e) => e.target.value && void act(() => updateAssignment(a.id, { assignee_id: e.target.value }))}>
											<option value="" disabled>Choose a person</option>
											{people.filter((p) => p.id !== a.assignee.id).map((p) => <option key={p.id} value={p.id}>{whoLabel(p)}</option>)}
										</select>
										<button type="button" className="asg-btn" onClick={() => setMoving(null)}>Cancel</button>
									</>
								) : removing === a.id ? (
									<>
										<span className="asg-confirm-text">
											Remove {a.task}, cases {rangeLabel(a)}{a.done + a.flagged ? `, and the ${a.done + a.flagged} marks already made` : ""}?
										</span>
										<button type="button" className="asg-btn asg-btn--danger" disabled={busy} onClick={() => void act(() => deleteAssignment(a.id))}>Yes, remove</button>
										<button type="button" className="asg-btn" onClick={() => setRemoving(null)}>Keep</button>
									</>
								) : (
									<>
										<button type="button" className="asg-btn" onClick={() => { setMoving(a.id); setRemoving(null); }}>Give to someone else</button>
										<button type="button" className="asg-btn" onClick={() => { setRemoving(a.id); setMoving(null); }}>Remove</button>
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


// Who can be given cases. A manager finds an account by part of a name or email (not a list of everyone) and makes it an
// annotator; an annotator can be taken off again, which keeps their finished marks but stops new cases.
function Annotators({ people, assignments, onChanged }: { people: Person[]; assignments: Assignment[]; onChanged: () => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Account[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const term = query.trim();
	const ready = term.length >= MIN_ACCOUNT_SEARCH;

	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			setSearching(true);
			void searchAccounts(term).then((res) => {
				if (cancelled) return;
				setSearching(false);
				if (res.ok) {
					setResults(res.data.accounts);
					setError(null);
				} else {
					setResults(null);
					setError(res.message);
				}
			});
		}, 250);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [term, ready]);

	const shown = ready ? results : null;
	const annotators = people.filter((p) => p.annotator).sort((a, b) => whoLabel(a).localeCompare(whoLabel(b)));
	const openCases = (id: string) => assignments.filter((a) => a.assignee.id === id).reduce((n, a) => n + a.todo, 0);

	const change = async (id: string, label: string, make: boolean) => {
		setBusy(id);
		setError(null);
		setNotice(null);
		const res = make ? await makeAnnotator(id) : await removeAnnotator(id);
		setBusy(null);
		if (!res.ok) {
			setError(res.message);
			return;
		}
		setRemoving(null);
		setNotice(make ? `${label} is now an annotator and can be handed cases.` : `${label} is no longer an annotator. Their finished marks are kept.`);
		setResults((list) => (list ? list.map((a) => (a.id === id ? { ...a, annotator: make } : a)) : list));
		onChanged();
	};

	return (
		<div data-testid="annotators">
			<div className="asg-annotator-find">
				<label className="asg-field">
					<span>Find a person to make an annotator</span>
					<input className="asg-input" type="search" placeholder="Part of a name or email" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
				</label>
				{term.length > 0 && !ready && <p className="asg-note">Type at least {MIN_ACCOUNT_SEARCH} letters.</p>}
				{ready && searching && <p className="asg-note">Searching…</p>}
				{ready && !searching && shown && shown.length === 0 && (
					<p className="asg-note" data-testid="no-accounts">No account matches. They need to sign up on the website first.</p>
				)}
				{shown && shown.length > 0 && (
					<ul className="asg-account-list" aria-label="Matching accounts">
						{shown.map((a) => (
							<li key={a.id}>
								<span>
									<strong>{whoLabel(a)}</strong>
									{a.name && <span className="asg-note"> {a.email}</span>}
								</span>
								{a.annotator ? <span className="asg-tag">Annotator</span> : a.manager ? <span className="asg-tag">Manager</span> : null}
								{!a.annotator && (
									<button type="button" className="asg-btn" disabled={busy === a.id} onClick={() => void change(a.id, whoLabel(a), true)}>
										{busy === a.id ? "Adding…" : "Make annotator"}
									</button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
			{notice && <p className="asg-banner" role="status">{notice}</p>}
			{error && <p className="asg-banner asg-banner--error" role="alert">{error}</p>}

			<h3 className="asg-person-name asg-annotators-heading">Annotators ({annotators.length})</h3>
			{annotators.length === 0 ? (
				<p className="asg-note">There are no annotators yet. Search for a person above.</p>
			) : (
				<ul className="asg-account-list" aria-label="Annotators">
					{annotators.map((p) => (
						<li key={p.id}>
							<span>
								<strong>{whoLabel(p)}</strong>
								{p.name && <span className="asg-note"> {p.email}</span>}
							</span>
							{p.manager && <span className="asg-tag">Manager</span>}
							{removing === p.id ? (
								<span className="asg-confirm">
									<span className="asg-confirm-text">
										Remove {whoLabel(p)} as an annotator?
										{openCases(p.id) > 0 ? ` ${openCases(p.id)} cases are still to do and stay with them, but they cannot be handed new ones.` : ""} Their finished marks are kept.
									</span>
									<button type="button" className="asg-btn asg-btn--danger" disabled={busy === p.id} onClick={() => void change(p.id, whoLabel(p), false)}>Yes, remove</button>
									<button type="button" className="asg-btn" onClick={() => setRemoving(null)}>Keep</button>
								</span>
							) : (
								<button type="button" className="asg-btn" onClick={() => setRemoving(p.id)}>Remove</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export default function ManagePanel() {
	const [all, setAll] = useState<Assignment[]>([]);
	const [people, setPeople] = useState<Person[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		const [a, p] = await Promise.all([fetchAll(), fetchPeople()]);
		for (const r of [a, p]) if (!r.ok) setError(r.message);
		if (a.ok) setAll(a.data.assignments);
		if (p.ok) setPeople(p.data.people);
	}, []);

	useEffect(() => { void load(); }, [load]);

	const tasks = useMemo(() => [...new Set(all.map((a) => a.task))].sort(), [all]);

	return (
		<div className="asg-group asg" data-testid="manage-panel">
			{error && <p className="asg-banner asg-banner--error" role="alert">{error} <button type="button" className="asg-btn" onClick={() => void load()}>Try again</button></p>}

			<h2 className="asg-heading">Hand out cases</h2>
			<p className="asg-sub">Give a range of cases to one person, or split it evenly between several.</p>
			<HandOut people={people} tasks={tasks} onCreated={() => void load()} />

			<h2 className="asg-heading asg-section">Everyone's progress</h2>
			<Everyone all={all} people={people} onChanged={() => void load()} />

			<h2 className="asg-heading asg-section">Annotators</h2>
			<p className="asg-sub">Only annotators can be given cases. They can also save a corrected scan for everyone.</p>
			<Annotators people={people} assignments={all} onChanged={() => void load()} />
		</div>
	);
}
