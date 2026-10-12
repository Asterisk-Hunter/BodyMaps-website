import React, { useEffect, useRef, useState } from "react";
import { IconCamera, IconUpload } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { ACCOUNT_TYPES, accountTypeLabel, type AccountType } from "../../helpers/accountProfile";
import { track } from "../../helpers/analytics";
import { avatarMaxBytes, avatarSizeLabel } from "../../helpers/deploymentCapabilities";
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
	useEffect(() => {
		setDraft(committed);
	}, [committed]);
	const commit = () => {
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
				onBlur={commit}
				onKeyDown={(e) => {
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
		});
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
						<span className="set-picture">{avatar ? <img src={avatar} alt="Profile picture preview" /> : (draft || user.name || user.email).charAt(0).toUpperCase()}</span>
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
							onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveProfile(); } if (event.key === "Escape") setDraft(committed); }} />
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
					<span className="set-row-value">{user.email}</span>
					{!user.emailVerified && (
						<button
							type="button"
							className="set-btn"
							onClick={() =>
								run(async () => {
									const r = await sendVerification();
									notify(
										r.alreadyVerified
											? "Your email is already verified."
											: r.sent
												? "Verification email sent. Check your inbox."
												: "Couldn't send the email. Try again in a minute."
									);
								})
							}
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
						value={user.profile.accountType ?? ""}
						onChange={(e) => {
							const accountType = (e.target.value || null) as AccountType | null;
							run(async () => {
								track("account_set_account_type");
								await updateAccountProfile({ accountType });
								notify(
									accountType
										? `Your role is set to ${accountTypeLabel(accountType)}.`
										: "Your role has been cleared."
								);
							});
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
						})
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
						})
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
						})
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
