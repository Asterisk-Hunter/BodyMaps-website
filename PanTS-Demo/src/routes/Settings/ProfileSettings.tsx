import React, { useEffect, useRef, useState } from "react";
import { IconCamera, IconUpload } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { ACCOUNT_TYPES, accountTypeLabel, type AccountType } from "../../helpers/accountProfile";
import { track } from "../../helpers/analytics";
import { avatarMaxBytes, avatarSizeLabel } from "../../helpers/deploymentCapabilities";
import { nameInitial } from "../../liveRooms/composerHelpers";
import { useSettings } from "./context";

// Name and picture save together; researcher fields retain their existing server-backed controls.
// Commit-on-blur text row, same interaction pattern as the name field: the
// draft belongs to the input while it's being edited, the account value is
// authoritative otherwise, and nothing fires unless the value changed.
const ProfileFieldRow: React.FC<{
	id: string;
	label: string;
	note?: string;
	value: string | null;
	maxLength: number;
	onCommit: (next: string) => void;
}> = ({ id, label, note, value, maxLength, onCommit }) => {
	const committed = value ?? "";
	const [draft, setDraft] = useState(committed);
	// A save that lands while the person is typing again must not put the older
	// value back over what they are typing; the draft is only reset from the
	// account when the field is not being edited.
	const editing = useRef(false);
	useEffect(() => {
		if (!editing.current) setDraft(committed);
	}, [committed]);
	const commit = () => {
		editing.current = false;
		const next = draft.trim();
		if (next === committed) return;
		onCommit(next);
	};
	return (
		<div className="set-row">
			<label className="set-row-label" htmlFor={id}>
				{label}
				{note && <span className="set-row-note">{note}</span>}
			</label>
			<input
				id={id}
				className="set-input"
				value={draft}
				maxLength={maxLength}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={() => { editing.current = true; }}
				onBlur={commit}
				onKeyDown={(e) => {
					// Enter or Escape during IME composition belongs to the composition.
					if (e.nativeEvent.isComposing || e.keyCode === 229) return;
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") setDraft(committed);
				}}
			/>
		</div>
	);
};

const ProfileSettings: React.FC = () => {
	const navigate = useNavigate();
	const {
		user, updateName, updateAvatar, updateAccountProfile, updatePreferences, signOut,
		sendVerification,
	} = useAuth();
	const { run, notify, fail, busy } = useSettings();

	// Only a second Resend is ignored, not a click that lands while a field is
	// saving: pressing Resend straight after typing blurs the field first, which
	// starts that save before the click arrives. `run` queues the send behind it.
	const sendingRef = useRef(false);
	const [sending, setSending] = useState(false);

	// Resend is removed once the account reads as verified, whether the server
	// said "already verified" or another tab verified the address. If it held
	// keyboard focus when that happened, focus moves to the email value instead
	// of falling to the page, which would send a screen reader back to the top.
	// Focus is tracked on the button itself. Only a blur of the whole window (the
	// tab going to the background) keeps the mark, since focus returns with the
	// tab; any other blur, including a click on blank page, clears it.
	const resendHadFocus = useRef(false);
	const emailValueRef = useRef<HTMLSpanElement>(null);
	const emailVerified = user?.emailVerified;
	useEffect(() => {
		if (!emailVerified || !resendHadFocus.current) return;
		resendHadFocus.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) emailValueRef.current?.focus();
	}, [emailVerified]);

	// The Role select shows the pick the moment it is made, not when the save
	// returns; null means "follow the account". Without it the control snaps
	// back to the old value until the response lands, and keyboard stepping
	// restarts from there on every press.
	const [roleDraft, setRoleDraft] = useState<string | null>(null);

	// What the server currently holds. A name derived from the email isn't a
	// value the user chose, so it shows as a placeholder rather than text they'd
	// have to delete before typing their own.
	const committed = user?.hasCustomName ? user.name : "";

	const [draft, setDraft] = useState(committed);
	const [picture, setPicture] = useState<File | null | undefined>(undefined);
	const [preview, setPreview] = useState<string | null>(null);
	const pickerRef = useRef<HTMLInputElement>(null);
	useEffect(() => { setDraft(committed); }, [committed]);
	useEffect(() => {
		if (!picture) { setPreview(null); return; }
		const url = URL.createObjectURL(picture);
		setPreview(url);
		return () => URL.revokeObjectURL(url);
	}, [picture]);

	if (!user) return null;
	const avatar = picture === null ? null : preview || user.avatarUrl;
	const dirty = draft.trim() !== committed || picture !== undefined;
	const saveProfile = () => {
		if (!dirty || busy) return;
		void run(async () => {
			if (picture !== undefined) await updateAvatar(picture, draft.trim());
			else await updateName(draft.trim());
			setPicture(undefined);
			notify("Your profile has been updated.");
		}, "profile");
	};
	const selectPicture = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file) return;
		if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
			fail("Choose a PNG, JPG or WebP image."); return;
		}
		if (file.size > avatarMaxBytes()) { fail(`Choose an image up to ${avatarSizeLabel()}.`); return; }
		setPicture(file);
		fail("");
	};

	return (
		<>
			<div className="set-profile-card">
				<input ref={pickerRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={selectPicture} className="set-file-input" aria-label="Choose profile picture" disabled={busy} />
				<div className="set-profile-hero">
					<button className="set-picture-button" type="button" title="Change profile picture" aria-label="Change profile picture" onClick={() => pickerRef.current?.click()} disabled={busy}>
						<span className="set-picture">{avatar ? <img src={avatar} alt="Profile picture preview" /> : nameInitial(draft || user.name || user.email)}</span>
						<span className="set-picture-camera"><IconCamera size={16} aria-hidden="true" /></span>
					</button>
					<div><h2 className="set-heading">Profile</h2><p className="set-profile-name">{draft.trim() || user.name}</p><p className="set-profile-note">Your name and picture appear across BodyMaps.</p></div>
				</div>
				<div className="set-profile-fields">
					<div className="set-row">
						<span className="set-row-label">Profile picture<span className="set-row-note">PNG, JPG or WebP, up to {avatarSizeLabel()}. Saved to your account.</span></span>
						<div className="set-picture-actions">
							<button className="set-btn" type="button" disabled={busy} onClick={() => pickerRef.current?.click()}><IconUpload size={16} aria-hidden="true" />Upload picture</button>
							{avatar && <button className="set-btn set-btn--quiet" type="button" disabled={busy} onClick={() => setPicture(user.avatarUrl ? null : undefined)}>Remove</button>}
						</div>
					</div>
					<div className="set-row">
						<label className="set-row-label" htmlFor="set-name">Name</label>
						<input id="set-name" className="set-input" value={draft} maxLength={120} placeholder={user.hasCustomName ? "" : user.name} disabled={busy}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); saveProfile(); } if (event.key === "Escape") setDraft(committed); }} />
					</div>
				</div>
				<div className="set-profile-save">
					<button className="set-btn" type="button" disabled={!dirty || busy} onClick={() => { setDraft(committed); setPicture(undefined); fail(""); }}>Discard</button>
					<button className="set-btn set-btn--primary" type="button" disabled={!dirty || busy} onClick={saveProfile}>{busy ? "Saving…" : "Save changes"}</button>
				</div>
			</div>
			<div className="set-group">

				<div className="set-row">
					<span className="set-row-label">
						Email
						<span className="set-row-note">
							{user.emailVerified
								? "Verified."
								: "Not verified. Check your inbox, or resend the link."}
						</span>
					</span>
					<span className="set-row-value" ref={emailValueRef} tabIndex={-1}>{user.email}</span>
					{!user.emailVerified && (
						<button
							type="button"
							className="set-btn"
							// Not disabled: that would drop keyboard focus from a
							// person who just pressed Enter on it. A second press
							// while one send is in flight is ignored instead.
							aria-disabled={sending || undefined}
							onFocus={() => { resendHadFocus.current = true; }}
							onBlur={(e) => { if (e.relatedTarget || document.hasFocus()) resendHadFocus.current = false; }}
							onClick={() => {
								if (sendingRef.current) return;
								sendingRef.current = true;
								setSending(true);
								run(async () => {
									try {
										const r = await sendVerification();
										// A send that failed is an error, not a confirmation: the
										// error banner stays up, the notice one clears itself.
										if (!r.sent && !r.alreadyVerified) {
											fail("Couldn't send the email. Try again in a minute.");
											return;
										}
										notify(
											r.alreadyVerified
												? "Your email is already verified."
												: "Verification email sent. Check your inbox."
										);
									} finally {
										sendingRef.current = false;
										setSending(false);
									}
								});
							}}
						>
							Resend
						</button>
					)}
				</div>

				<div className="set-row">
					<label className="set-row-label" htmlFor="set-role">
						Role
						<span className="set-row-note">Optional. Doesn't affect what you can access.</span>
					</label>
					<select
						id="set-role"
						className="set-select"
						value={roleDraft ?? user.profile.accountType ?? ""}
						onChange={(e) => {
							const picked = e.target.value;
							const accountType = (picked || null) as AccountType | null;
							setRoleDraft(picked);
							run(async () => {
								try {
									track("account_set_account_type");
									await updateAccountProfile({ accountType });
									notify(
										accountType
											? `Your role is set to ${accountTypeLabel(accountType)}.`
											: "Your role has been cleared."
									);
								} finally {
									// Back to the account's value once this save is over,
									// unless a later pick has already replaced it.
									setRoleDraft((now) => (now === picked ? null : now));
								}
							}, "account-type");
						}}
					>
						<option value="">Not set</option>
						{ACCOUNT_TYPES.map((t) => (
							<option key={t.id} value={t.id}>{t.label}</option>
						))}
					</select>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Verified researcher profile</h2>

				<ProfileFieldRow
					id="set-organization"
					label="Organization"
					note="With a verified email, a complete profile unlocks 10 scans a day."
					value={user.profile.organization}
					maxLength={200}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ organization: next || null });
							notify(next ? "Your organization has been saved." : "Your organization has been cleared.");
						}, "organization")
					}
				/>

				<ProfileFieldRow
					id="set-occupation"
					label="Occupation"
					value={user.profile.occupation}
					maxLength={120}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ occupation: next || null });
							notify(next ? "Your occupation has been saved." : "Your occupation has been cleared.");
						}, "occupation")
					}
				/>

				<ProfileFieldRow
					id="set-role-description"
					label="About your work"
					note="A line on what you do and what you'd use BodyMaps for."
					value={user.profile.roleDescription}
					maxLength={2000}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ roleDescription: next || null });
							notify(next ? "Saved." : "Cleared.");
						}, "role-description")
					}
				/>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Notifications</h2>

				<div className="set-row">
					<span className="set-row-label">Email me when a scan finishes</span>
					<button
						type="button"
						role="switch"
						aria-checked={user.emailNotifications}
						aria-label="Email me when a scan finishes"
						className={`set-switch${user.emailNotifications ? " set-switch--on" : ""}`}
						onClick={() => updatePreferences({ emailNotifications: !user.emailNotifications })}
					>
						<span className="set-switch-knob" />
					</button>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Session</h2>

				<div className="set-row">
					{/* Not "log out of all devices": /auth/logout revokes this session
					    only, so claiming otherwise would be a lie. */}
					<span className="set-row-label">Signed in on this browser</span>
					<button
						type="button"
						className="set-btn"
						disabled={busy}
						onClick={() => void run(async () => { await signOut(); navigate("/"); })}
					>
						Sign out
					</button>
				</div>
			</div>
		</>
	);
};

export default ProfileSettings;
