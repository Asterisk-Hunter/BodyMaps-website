import { useEffect, useState } from "react";
import { CANCERVERSE_LAST_NUMBER } from "../../helpers/caseNumbering";
import {
	type Overlap,
	type Person,
	createAssignment,
	datasetBreakdown,
	libraryMaxNumber,
	parseRange,
	rangeLabel,
	splitRange,
	whoLabel,
} from "../../helpers/assignments";

// The three-step form for handing out cases: which cases, what to annotate, who. One person gets the whole range; several
// split it evenly, with a preview first. Used inside the Hand out window on the Manage view.

type Pending = { person: Person; range: [number, number] }[];

export default function HandOut({ people, tasks, initialChosen = [], onCreated, onDone }: {
	people: Person[];
	tasks: string[];
	/** People already ticked when the form opens (a card's own Hand out button). */
	initialChosen?: string[];
	onCreated: () => void;
	/** Called with a message once everything is handed out; the caller closes the window. */
	onDone?: (message: string) => void;
}) {
	const [cases, setCases] = useState("");
	const [task, setTask] = useState("");
	const [due, setDue] = useState("");
	const [note, setNote] = useState("");
	const [chosen, setChosen] = useState<string[]>(initialChosen);
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
	// Where the range falls: only worth showing when it crosses into more than one dataset or is not plain PanTS.
	const shares = range ? datasetBreakdown(range[0], range[1], libraryMax === null ? undefined : libraryMax - CANCERVERSE_LAST_NUMBER) : [];
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
		const message = `Handed out ${made} ${made === 1 ? "assignment" : "assignments"}.`;
		if (!onDone) setDone(message);
		setCases("");
		setNote("");
		setChosen([]);
		onCreated();
		setBusy(false);
		onDone?.(message);
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
						{matched !== null && <strong className="asg-matched"> That is {matched.toLocaleString("en-US")} {matched === 1 ? "case" : "cases"}.</strong>}
					</p>
					{libraryMax !== null && (
						<p className="asg-hint" data-testid="library-size">
							The library has {libraryMax.toLocaleString("en-US")} scans: cases 1 to {libraryMax.toLocaleString("en-US")}.
						</p>
					)}
					{shares.length > 0 && (
						<ul className="asg-shares" aria-label="Cases by dataset" data-testid="dataset-shares">
							{shares.map((s) => (
								<li key={s.dataset}>
									<strong>{s.dataset}</strong>: cases {s.first.toLocaleString("en-US")} to {s.last.toLocaleString("en-US")}
									<span className="asg-note"> ({s.count.toLocaleString("en-US")} {s.count === 1 ? "case" : "cases"}{s.dataset === "PanTS" ? "" : `, ${s.firstId} to ${s.lastId}`})</span>
								</li>
							))}
						</ul>
					)}
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
