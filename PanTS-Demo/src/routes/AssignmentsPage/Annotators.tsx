import { useEffect, useState } from "react";
import {
	type Account,
	type Assignment,
	type Person,
	MIN_ACCOUNT_SEARCH,
	makeAnnotator,
	removeAnnotator,
	searchAccounts,
	whoLabel,
} from "../../helpers/assignments";

// Who can be given cases. A manager finds an account by part of a name or email (not a list of everyone) and makes it an
// annotator; an annotator can be taken off again, which keeps their finished marks but stops new cases.
export default function Annotators({ people, assignments, onChanged }: { people: Person[]; assignments: Assignment[]; onChanged: () => void }) {
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
