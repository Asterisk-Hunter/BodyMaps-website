import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../helpers/constants";
import { parseServerTime } from "../../helpers/resetTime";
import { guardLeaving } from "../../helpers/leaveGuard";

// Temporary codes that let a person edit what every visitor sees (the annotator role).
//
// The other way to grant it is Edit > "Make annotator" on a person below. A code is for when you would
// rather hand someone a code than look their account up: it works once, expires, and can be withdrawn. The
// server keeps only a digest, so the code is shown here exactly once, when it is made.

type Invite = {
	id: string;
	status: "open" | "redeemed" | "expired";
	created_at: string | null;
	/** Null for a permanent code. */
	expires_at: string | null;
	permanent?: boolean;
	redeemed_at: string | null;
	redeemed_by: string | null;
};

type Created = { id: string; code: string; expires_at: string | null; permanent?: boolean };

const PERMANENT = "permanent";
const LIFETIMES: { value: number | typeof PERMANENT; label: string }[] = [
	{ value: 1, label: "1 hour" },
	{ value: 24, label: "1 day" },
	{ value: 24 * 7, label: "7 days" },
	{ value: PERMANENT, label: "Permanent" },
];

const when = (iso: string | null) => {
	if (!iso) return "";
	const date = parseServerTime(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

const AnnotatorCodes: React.FC = () => {
	const [lifetime, setLifetime] = useState<number | typeof PERMANENT>(24);
	const [invites, setInvites] = useState<Invite[]>([]);
	const [created, setCreated] = useState<Created | null>(null);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [roster, setRoster] = useState("");
	const [rosterCodes, setRosterCodes] = useState<{ email: string; code: string; expiresAt: string | null }[]>([]);
	const [generatingRoster, setGeneratingRoster] = useState(false);
	const protectRoster = rosterCodes.length > 0 || generatingRoster;

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${API_BASE}/api/admin/annotator-invites`, { credentials: "include" });
			if (!res.ok) throw new Error();
			setInvites((await res.json()).invites ?? []);
		} catch {
			setError("Couldn't load the codes.");
		}
	}, []);

	useEffect(() => { void load(); }, [load]);
	useEffect(() => {
		if (!protectRoster) return;
		return guardLeaving("Leave this page? Roster codes being created or shown here cannot be recovered after you leave.");
	}, [protectRoster]);

	const create = async () => {
		setBusy(true);
		setError(null);
		setCopied(false);
		try {
			const res = await fetch(`${API_BASE}/api/admin/annotator-invites`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(lifetime === PERMANENT ? { permanent: true } : { hours: lifetime }),
			});
			if (!res.ok) throw new Error();
			setCreated(await res.json());
			await load();
		} catch {
			setError("Couldn't create a code. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const withdraw = async (id: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`${API_BASE}/api/admin/annotator-invites/${encodeURIComponent(id)}`, {
				method: "DELETE",
				credentials: "include",
			});
			if (!res.ok && res.status !== 404) throw new Error();
			if (created?.id === id) setCreated(null);
			await load();
		} catch {
			setError("Couldn't withdraw that code. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const createRoster = async () => {
		const entries = roster.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
		const alreadyCreated = new Set(rosterCodes.map(item => item.email.toLowerCase()));
		const addresses = Array.from(new Map(entries.map(email => [email.toLowerCase(), email])).values())
			.filter(email => !alreadyCreated.has(email.toLowerCase()));
		if (!addresses.length || addresses.length > 100 || addresses.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
			setError("Enter 1–100 valid email addresses, separated by lines or commas.");
			return;
		}
		setError(null); setBusy(true); setGeneratingRoster(true);
		try {
			for (const [index, email] of addresses.entries()) {
				const res = await fetch(`${API_BASE}/api/admin/annotator-invites`, {
					method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(lifetime === PERMANENT ? { permanent: true } : { hours: lifetime }),
				});
				if (!res.ok) throw new Error(`Stopped at ${email}. Codes already shown remain valid; check recent codes before retrying.`);
				const invite: Created = await res.json();
				setRosterCodes(previous => [...previous, { email, code: invite.code, expiresAt: invite.expires_at }]);
				setRoster(addresses.slice(index + 1).join("\n"));
			}
		} catch (err) {
			setError(`${err instanceof Error ? err.message : "Connection interrupted."} Codes already created may remain valid; check recent codes before retrying.`);
		} finally { setGeneratingRoster(false); setBusy(false); await load(); }
	};

	const copy = async () => {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(created.code);
			setCopied(true);
		} catch {
			setCopied(false); // the code is on screen; they can select it by hand
		}
	};

	return (
		<div className="set-group" data-testid="annotator-codes">
			<h2 className="set-heading">Annotator access code</h2>
			<p className="set-sub">
				A one-time code that lets someone save corrected scans for everyone. It expires after the time you choose, or never if permanent.
			</p>

			<div className="set-picture-actions">
				<label className="set-row-note" htmlFor="annotator-code-lifetime">Works for</label>
				<select
					id="annotator-code-lifetime"
					className="set-input"
					value={lifetime}
					disabled={busy}
					onChange={(e) => setLifetime(e.target.value === PERMANENT ? PERMANENT : Number(e.target.value))}
				>
					{LIFETIMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
				</select>
				<button className="set-btn" type="button" disabled={busy} onClick={() => void create()}>
					Create code
				</button>
			</div>

			{created && (
				<div className="set-banner" role="status" data-testid="annotator-code-created">
					<p>
						<strong style={{ fontSize: "1.25em", letterSpacing: "0.08em", userSelect: "all" }}>{created.code}</strong>
					</p>
					<p className="set-row-note">
						Shown once. {created.expires_at ? `Valid until ${when(created.expires_at)}.` : "Never expires, but works only once."}
					</p>
					<button className="set-btn" type="button" onClick={() => void copy()}>
						{copied ? "Copied" : "Copy"}
					</button>
				</div>
			)}

			<details>
				<summary>Create codes for a roster</summary>
				<p className="set-row-note">Paste email addresses, one per line or separated by commas. Addresses are labels for your list: each code can be redeemed by anyone who has it. No emails are sent. Codes appear only here and cannot be recovered after leaving this page.</p>
				<label htmlFor="annotator-roster">Email addresses</label>
				<textarea id="annotator-roster" className="set-input" value={roster} disabled={busy} onChange={event => setRoster(event.target.value)} rows={5} />
				<label>Or choose a text or CSV file containing one email address per row <input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 32768) { setError("Roster file is too large."); return; } void file.text().then(text => { setRoster(text.replace(/^\s*(?:email|email address)\s*\r?\n/i, "")); setError(null); }).catch(() => setError("Could not read the roster file.")); event.target.value = ""; }} /></label>
				<button className="set-btn" type="button" disabled={busy} onClick={() => void createRoster()}>Create roster codes</button>
				{rosterCodes.length > 0 && <div className="set-banner" role="status"><p>Copy these codes before leaving. Completed addresses are removed from the input so you can retry any remaining addresses.</p><ul aria-label="New roster codes">{rosterCodes.map(item => <li key={item.email}>{item.email}: <strong>{item.code}</strong> · {item.expiresAt ? `valid until ${when(item.expiresAt)}` : "never expires"}</li>)}</ul><button className="set-btn" type="button" onClick={() => void navigator.clipboard.writeText(rosterCodes.map(item => `${item.email}\t${item.code}`).join("\n")).catch(() => setError("Copy failed. Select the codes above and copy them manually."))}>Copy list</button><button className="set-btn" type="button" disabled={busy} onClick={() => { if (window.confirm("Clear the codes from this screen? You cannot retrieve them later.")) setRosterCodes([]); }}>Clear list</button></div>}
			</details>

			{error && <div className="set-banner set-banner--error" role="alert">{error}</div>}

			{invites.length > 0 && (
				<ul className="dash-list" aria-label="Recent codes">
					{invites.map((invite) => (
						<li key={invite.id} className="set-row">
							<span className="set-row-label">
								{invite.status === "open" && (invite.expires_at ? `Open until ${when(invite.expires_at)}` : "Open, never expires")}
								{invite.status === "redeemed" && `Used by ${invite.redeemed_by ?? "a deleted account"}, ${when(invite.redeemed_at)}`}
								{invite.status === "expired" && `Expired ${when(invite.expires_at)}`}
								<span className="set-row-note">Created {when(invite.created_at)}</span>
							</span>
							{invite.status === "open" && (
								<button className="set-btn" type="button" disabled={busy} onClick={() => void withdraw(invite.id)}>
									Withdraw
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
};

export default AnnotatorCodes;
