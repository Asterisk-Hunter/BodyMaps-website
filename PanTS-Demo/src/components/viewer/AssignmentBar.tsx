import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import {
	type Assignment,
	type CaseStatus,
	assignmentsFor,
	fetchMine,
	markCase,
	nextTodo,
	statusOf,
} from "../../helpers/assignments";
import { caseIdToNumber } from "../../helpers/caseNumbering";
import "./AssignmentBar.css";

// A slim strip above the viewer for an annotator whose assignment includes this case: what to annotate, how far along
// they are, and one click to mark the case and go to the next one. It shows nothing for anyone else, and nothing when
// the case is not in any of their assignments, so it never changes the viewer for ordinary visitors.

const STATUS_TEXT: Record<CaseStatus, string> = { todo: "Not marked yet", done: "Marked done", flagged: "Flagged for a second look" };

export default function AssignmentBar({ caseId }: { caseId: string }) {
	const { user, isAuthenticated } = useAuth();
	const eligible = isAuthenticated && !!user && (user.roles.includes("annotator") || user.roles.includes("annotation_manager"));
	const [list, setList] = useState<Assignment[] | null>(null);
	const n = caseIdToNumber(caseId);

	useEffect(() => {
		if (!eligible) return;
		let cancelled = false;
		void fetchMine().then((res) => {
			if (!cancelled && res.ok) setList(res.data.assignments);
		});
		return () => { cancelled = true; };
	}, [eligible, user?.id]);

	const matches = useMemo(() => (list && n !== null ? assignmentsFor(list, n) : []), [list, n]);
	if (!eligible || n === null || matches.length === 0 || !list) return null;
	// Keyed by case so a new case starts clean: no old error, no old "all done" message.
	return <Strip key={n} n={n} matches={matches} setList={setList} />;
}

function Strip({ n, matches, setList }: { n: number; matches: Assignment[]; setList: React.Dispatch<React.SetStateAction<Assignment[] | null>> }) {
	const navigate = useNavigate();
	const [picked, setPicked] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [finished, setFinished] = useState<string | null>(null);
	const alive = useRef(true);
	// A ref as well as the busy state: two clicks inside one frame must still save once.
	const inFlight = useRef(false);

	useEffect(() => {
		alive.current = true;
		return () => { alive.current = false; };
	}, []);

	const current = matches.find((a) => a.id === picked) ?? matches[0];
	const status = statusOf(current, n);

	const apply = async (next: CaseStatus, advance: boolean) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		const res = await markCase(current.id, n, next);
		inFlight.current = false;
		if (!alive.current) return;
		setBusy(false);
		if (!res.ok) {
			setError(res.status === 401 ? "You are signed out. Sign in again to save." : "Couldn't save that. Try again.");
			return;
		}
		const updated: Assignment = { ...res.data, marks: { ...(current.marks ?? {}) } };
		if (next === "todo") delete updated.marks![String(n)];
		else updated.marks![String(n)] = next;
		setList((all) => (all ? all.map((a) => (a.id === updated.id ? updated : a)) : all));
		if (!advance) return;
		const target = nextTodo(updated, n);
		if (target === null) setFinished(`All ${updated.total} cases in "${updated.task}" are marked. Nice work.`);
		else navigate(`/case/${target}`);
	};

	const skipTo = nextTodo(current, n);

	return (
		<div className="asg-bar" role="region" aria-label="Assignment" data-testid="assignment-bar">
			<div className="asg-bar-info">
				{matches.length > 1 ? (
					<select aria-label="Assignment" value={current.id} onChange={(e) => setPicked(e.target.value)}>
						{matches.map((a) => <option key={a.id} value={a.id}>{a.task}</option>)}
					</select>
				) : (
					<strong className="asg-bar-task">{current.task}</strong>
				)}
				<span className="asg-bar-meta">
					Case {n} of {current.start} to {current.end}, {current.done} of {current.total} done
				</span>
				<span className={`asg-bar-status asg-bar-status--${status}`} data-testid="assignment-status">{STATUS_TEXT[status]}</span>
			</div>
			<div className="asg-bar-actions">
				{finished ? (
					<span className="asg-bar-finished" role="status">{finished}</span>
				) : (
					<>
						<button type="button" className="asg-bar-btn asg-bar-btn--primary" disabled={busy} onClick={() => void apply("done", true)}>
							{busy ? "Saving…" : "Done, next case"}
						</button>
						<button type="button" className="asg-bar-btn" disabled={busy} onClick={() => void apply("flagged", true)}>Flag, next case</button>
						{status !== "todo" && (
							<button type="button" className="asg-bar-btn" disabled={busy} onClick={() => void apply("todo", false)}>Mark as not done</button>
						)}
						{skipTo !== null && skipTo !== n && (
							<Link className="asg-bar-btn" to={`/case/${skipTo}`}>Skip to case {skipTo}</Link>
						)}
					</>
				)}
				<Link className="asg-bar-link" to="/account/assignments">All my cases</Link>
			</div>
			{error && <p className="asg-bar-error" role="alert">{error}</p>}
		</div>
	);
}
