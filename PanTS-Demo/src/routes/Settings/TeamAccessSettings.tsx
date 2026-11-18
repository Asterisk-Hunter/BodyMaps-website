import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import "../AnnotationWork.css";

const TeamAccessSettings: React.FC = () => {
	const { redeemAnnotatorInvite } = useAuth();
	const location = useLocation();
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

	useEffect(() => {
		const linkedCode = new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
		if (!linkedCode) return;
		setCode(current => current || linkedCode);
		// Keep the code out of browser history and subsequent referrers; joining still requires an explicit click.
		navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
	}, [location.hash, location.pathname, location.search, navigate]);

	const redeem = async () => {
		if (!code.trim() || busy) return;
		setBusy(true);
		setMessage(null);
		try {
			await redeemAnnotatorInvite(code.trim());
			setCode("");
			setMessage({ text: "You’ve joined the annotation team. A project owner can assign cases from Worklist.", ok: true });
		} catch (error) {
			setMessage({ text: error instanceof Error ? error.message : "Couldn't redeem that code.", ok: false });
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="annotation-join">
			<p className="annotation-work__eyebrow">Annotation workspace</p>
			<h1>Join a team</h1>
			<p>Open an invite link or enter its code. If the invite was addressed to a specific email, sign in with that account before joining.</p>
			<form className="annotation-join__form" onSubmit={event => { event.preventDefault(); void redeem(); }}>
				<label htmlFor="worklist-team-code">Invitation code</label>
				<div className="annotation-join__controls">
					<input id="worklist-team-code" value={code} maxLength={256} autoComplete="off" disabled={busy}
						onChange={event => setCode(event.target.value)} />
					<button type="submit" disabled={!code.trim() || busy}>{busy ? "Joining…" : "Join team"}</button>
				</div>
				{message && <p role="status" className={message.ok ? "annotation-join__success" : "annotation-join__error"}>{message.text}</p>}
			</form>
			<p className="annotation-join__create">Setting up a project? <Link to="/work/projects">Create or manage projects</Link></p>
		</main>
	);
};

export default TeamAccessSettings;
