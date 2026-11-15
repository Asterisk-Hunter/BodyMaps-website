import { useCallback, useEffect, useMemo, useState } from "react";
import { type Assignment, type Person, dueState, fetchAll, fetchPeople } from "../../helpers/assignments";
import Annotators from "./Annotators";
import HandOut from "./HandOut";
import ManageModal from "./ManageModal";
import PeopleCards from "./PeopleCards";
import "./ManagePanel.css";

// The manager's half of the Assignments page: a card per person with their progress, four numbers at the top, and two
// buttons: Hand out cases (a small window with the three-step form) and Annotators (a small window for choosing who can
// be given cases). Only annotation managers are shown this, and the server checks the role on every call, so hiding it
// from others is presentation, not access control.

type Modal = { kind: "handout"; chosen: string[] } | { kind: "annotators" } | null;

export default function ManagePanel() {
	const [all, setAll] = useState<Assignment[]>([]);
	const [people, setPeople] = useState<Person[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [modal, setModal] = useState<Modal>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		const [a, p] = await Promise.all([fetchAll(), fetchPeople()]);
		for (const r of [a, p]) if (!r.ok) setError(r.message);
		if (a.ok) setAll(a.data.assignments);
		if (p.ok) setPeople(p.data.people);
		setLoaded(true);
	}, []);

	useEffect(() => { void load(); }, [load]);

	const tasks = useMemo(() => [...new Set(all.map((a) => a.task))].sort(), [all]);
	const stats = useMemo(() => {
		const annotators = people.filter((p) => p.annotator);
		const withCases = new Set(all.map((a) => a.assignee.id));
		const late = new Set(all.filter((a) => a.todo > 0 && dueState(a.due_at) === "overdue").map((a) => a.assignee.id));
		return {
			annotators: annotators.length,
			done: all.reduce((n, a) => n + a.done, 0),
			total: all.reduce((n, a) => n + a.total, 0),
			late: late.size,
			waiting: annotators.filter((p) => !withCases.has(p.id)).length,
		};
	}, [all, people]);

	const openHandOut = (chosen: string[] = []) => {
		setNotice(null);
		setModal({ kind: "handout", chosen });
	};

	return (
		<div className="asg-group" data-testid="manage-panel">
			{error && <p className="asg-banner asg-banner--error" role="alert">{error} <button type="button" className="asg-btn" onClick={() => void load()}>Try again</button></p>}

			<div className="asg-mhead">
				<p className="asg-note">Everyone at a glance</p>
				<div className="asg-mbuttons">
					<button type="button" className="asg-btn" data-testid="open-annotators" onClick={() => { setNotice(null); setModal({ kind: "annotators" }); }}>Annotators</button>
					<button type="button" className="asg-btn asg-btn--primary" data-testid="open-hand-out" onClick={() => openHandOut()}>+ Hand out cases</button>
				</div>
			</div>

			<div className="asg-tiles" data-testid="tiles">
				<div className="asg-tile"><strong>{stats.annotators}</strong><span>annotators</span></div>
				<div className="asg-tile"><strong>{stats.done} / {stats.total}</strong><span>cases done</span></div>
				<div className={`asg-tile ${stats.late > 0 ? "asg-tile--warn" : ""}`}><strong>{stats.late}</strong><span>overdue</span></div>
				<div className="asg-tile"><strong>{stats.waiting}</strong><span>no cases yet</span></div>
			</div>

			{notice && <p className="asg-banner" role="status">{notice}</p>}
			{loaded && all.length === 0 && people.length > 0 && (
				<p className="asg-banner asg-banner--info" data-testid="first-time">Nothing has been handed out yet. Press <strong>+ Hand out cases</strong> to start, or use a person's own button below.</p>
			)}

			<PeopleCards all={all} people={people} onChanged={() => void load()} onHandOut={(id) => openHandOut([id])} />

			{modal?.kind === "handout" && (
				<ManageModal title="Hand out cases" onClose={() => setModal(null)}>
					<HandOut
						people={people.filter((p) => p.annotator || p.manager)}
						tasks={tasks}
						initialChosen={modal.chosen}
						onCreated={() => void load()}
						onDone={(message) => { setModal(null); setNotice(message); }}
					/>
				</ManageModal>
			)}
			{modal?.kind === "annotators" && (
				<ManageModal title="Annotators" onClose={() => setModal(null)}>
					<p className="asg-sub">Only annotators can be given cases. They can also save a corrected scan for everyone.</p>
					<Annotators people={people} assignments={all} onChanged={() => void load()} />
				</ManageModal>
			)}
		</div>
	);
}
