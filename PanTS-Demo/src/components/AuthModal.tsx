import { IconBrandGithub, IconBrandGoogle } from "@tabler/icons-react";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AUTH_FINEPRINT_LEAD, AUTH_FINEPRINT_MID } from "../helpers/copy";
import { useAuth } from "../contexts/authContext";
import { track } from "../helpers/analytics";
import { useBackdropDismiss } from "../hooks/useDialogFocus";
import "./AuthModal.css";

// One account card for the route guard and for explicit authentication prompts.
// The existing backend owns credentials, provider redirects and sessions.
//
// Opened by authContext.promptAuth(mode) from the header, from gated upload
// actions, and from /signup — which redirects here rather than 404ing, so old
// links and bookmarks still land somewhere sensible.
//
// Providers come first with the email form behind "Continue with email", which
// keeps the default card short.
//
// "forgot" is the third mode, and it skips the provider screen: it is reached
// from the sign-in form by someone who already knows the password isn't working,
// so offering them the Google button again as the first thing is answering a
// question they didn't ask. The one line about OAuth accounts covers the case
// where the reason their password fails is that they never had one.
//
// The server counts a password in code points, so a short one is named on its
// field before the request rather than after it.
const MIN_PASSWORD_LENGTH = 8;

// Which fields a failed sign-in or sign-up is about. 409 is the email (already
// registered), a 400 on sign-up is the email (the length is checked before the
// request), 401 is the pair, and anything else (a dropped connection, a rate
// limit, a 5xx) is about neither field. The status is read off the error
// (authContext's AuthRequestError) rather than by its class.
const failedFields = (err: unknown, isSignup: boolean) => {
	const raw = (err as { status?: unknown } | null)?.status;
	const status = typeof raw === "number" ? raw : 0;
	if (status === 409 || (status === 400 && isSignup)) return { email: true, password: false };
	if (status === 401) return { email: true, password: true };
	return { email: false, password: false };
};
const NO_FIELD = { email: false, password: false };

const AuthModal: React.FC<{ standalone?: boolean }> = ({ standalone = false }) => {
	const {
		authPrompt, closeAuthPrompt, promptAuth, signIn, signUp,
		requestPasswordReset, signInWithProvider, oauthProviders, oauthError,
		clearOauthError,
	} = useAuth();

	const isSignup = authPrompt.mode === "signup";
	const isForgot = authPrompt.mode === "forgot";
	const active = standalone || authPrompt.open;

	// "email mode" reveals the email/password form (World Labs' "Continue with email").
	const [emailMode, setEmailMode] = useState(false);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	// Which fields the current error is about, so only those read as invalid.
	const [invalid, setInvalid] = useState(NO_FIELD);
	const [busy, setBusy] = useState(false);
	// The reset request has been accepted. A settled end state, not a banner over
	// the form: there is nothing left to do on this card.
	const [resetSent, setResetSent] = useState(false);
	const [rememberMe, setRememberMe] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const emailBtnRef = useRef<HTMLButtonElement>(null);
	const errorId = useId();
	// Counts submits. Closing the popup or switching screens bumps it, so a
	// request that answers late is ignored instead of writing into the next screen.
	const submitToken = useRef(0);

	// Reset transient form state whenever the popup opens/closes.
	useEffect(() => {
		if (!active) {
			submitToken.current += 1;
			setEmailMode(false);
			setEmail(""); setPassword(""); setError(""); setInvalid(NO_FIELD); setBusy(false);
			setResetSent(false);
			setRememberMe(false);
		}
	}, [active]);

	// Flipping between sign-in and sign-up clears the password and any error —
	// a rejected sign-in shouldn't still be showing over the signup form.
	useEffect(() => {
		submitToken.current += 1;
		setPassword(""); setError(""); setInvalid(NO_FIELD); setResetSent(false); setBusy(false);
	}, [authPrompt.mode]);

	// Surface an error the OAuth callback redirected back with.
	useEffect(() => {
		if (oauthError) setError(oauthError);
	}, [oauthError]);

	// Closing the popup also clears a pending OAuth error so it doesn't reappear.
	const dismiss = useCallback(() => {
		if (standalone) return;
		clearOauthError();
		closeAuthPrompt();
	}, [clearOauthError, closeAuthPrompt, standalone]);

	// Keep keyboard navigation in the dialog, then restore the opener on close.
	useEffect(() => {
		if (!active) return;
		const previousFocus = document.activeElement as HTMLElement | null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		cardRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); dismiss(); }
			if (e.key !== "Tab") return;
			const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]'
			) ?? []);
			const first = items[0], last = items[items.length - 1];
			if (!first) { e.preventDefault(); return; }
			if (e.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
				e.preventDefault(); last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault(); first.focus();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = previousOverflow;
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [active, dismiss]);

	// Closes only for a click that starts and ends on the backdrop: selecting
	// text in a field and letting go outside the card keeps what was typed.
	const backdropHandlers = useBackdropDismiss(dismiss);

	// Switching screens can unmount the button that had focus ("Forgot
	// password?", "Other options", "try another address"). Put focus back in
	// the card, on the field or button that leads the new screen, rather than
	// letting it fall to the page behind. On open the card already has focus.
	useEffect(() => {
		const card = cardRef.current;
		if (!active || !card || card.contains(document.activeElement)) return;
		(emailRef.current ?? emailBtnRef.current ?? card).focus({ preventScroll: true });
	}, [active, authPrompt.mode, emailMode, resetSent]);

	if (!active) return null;

	const submitEmail = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setError("");
		setInvalid(NO_FIELD);
		// A blank field is named, marked and focused, not just announced.
		const reject = (message: string, emailBad: boolean, passwordBad: boolean) => {
			setError(message);
			setInvalid({ email: emailBad, password: passwordBad });
			(emailBad ? emailRef : passwordRef).current?.focus();
		};
		if (isForgot) {
			if (!email.trim()) { reject("Enter your email address.", true, false); return; }
		} else if (!email.trim() || !password) {
			const noEmail = !email.trim();
			const noPassword = !password;
			reject(
				noEmail && noPassword ? "Enter an email and password."
					: noEmail ? "Enter your email address." : "Enter a password.",
				noEmail,
				noPassword,
			);
			return;
		}
		if (isSignup && [...password].length < MIN_PASSWORD_LENGTH) {
			reject(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, false, true);
			return;
		}
		const token = ++submitToken.current;
		const stale = () => token !== submitToken.current;
		setBusy(true);
		try {
			if (isForgot) {
				await requestPasswordReset(email.trim());
				track("auth_forgot_password_request");
				if (!stale()) setResetSent(true);
				return;
			}
			if (isSignup) await signUp(email, password, undefined, rememberMe);
			else await signIn(email, password, rememberMe);
			// After the await: this counts successful sign-ins, not attempts.
			track(isSignup ? "auth_sign_up" : "auth_sign_in");
			// authContext auto-closes the popup once the user is set.
		} catch (err) {
			if (stale()) return;
			// Surface the API's message ("Invalid email or password", "An account
			// with that email already exists", ...) rather than a generic string.
			setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
			const fields = failedFields(err, isSignup);
			setInvalid(fields);
			// Hand focus to the field at fault, as the blank-field checks do.
			if (fields.password) passwordRef.current?.focus();
			else if (fields.email) emailRef.current?.focus();
		} finally {
			if (!stale()) setBusy(false);
		}
	};

	return (
		<div className={`authm-backdrop${standalone ? " authm-standalone" : ""}`} {...backdropHandlers}>
			<div
				ref={cardRef}
				tabIndex={-1}
				className="authm-card"
				role="dialog"
				aria-modal="true"
				aria-label={
					isForgot ? "Reset your password" : isSignup ? "Create your account" : "Sign in"
				}
				onClick={(e) => e.stopPropagation()}
			>
				{!standalone && <button type="button" className="authm-close" aria-label="Close" onClick={dismiss}>×</button>}

				<div className="authm-brandmark"><img src="/bodymaps-logo.svg" alt="" className="authm-logo" /></div>
				<p className="authm-welcome">{isForgot ? "Account recovery" : isSignup ? "Welcome to BodyMaps" : "Welcome back"}</p>
				<div className="authm-wordmark"><span>Body</span>Maps</div>
				<h2 className="authm-title">
					{isForgot ? "Reset your password" : isSignup ? "Create your account" : "Sign in"}
				</h2>
				{!isForgot && <label className="authm-remember">
					<input type="checkbox" checked={rememberMe} disabled={busy} onChange={(event) => setRememberMe(event.target.checked)} />
					<span>Keep me signed in</span>
				</label>}

				{isForgot && resetSent ? (
					<>
						{/* Deliberately hedged. The server answers identically whether or
						    not the address has an account, so that this card can't be used
						    to find out which addresses are registered — which means the
						    card genuinely does not know, and saying "sent" would be a
						    claim it can't make. */}
						<p className="authm-sent" role="status">
							If an account exists for <strong>{email.trim()}</strong>, a reset
							link is on its way. It works once and expires in an hour.
						</p>
						<p className="authm-fineprint">
							Nothing arrived? Check your spam folder, or{" "}
							<button
								type="button"
								className="authm-link"
								onClick={() => { setResetSent(false); setError(""); }}
							>
								try another address
							</button>
							.
						</p>
					</>
				) : !emailMode && !isForgot ? (
					<>
						{/* A provider with no server-side credentials stays disabled. */}
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.google !== true}
							title={oauthProviders?.google === false ? "Not configured on this server" : undefined}
							onClick={() => signInWithProvider("google", rememberMe)}
						>
							<IconBrandGoogle size={18} />
							Continue with Google
						</button>
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.github !== true}
							title={oauthProviders?.github === false ? "Not configured on this server" : undefined}
							onClick={() => signInWithProvider("github", rememberMe)}
						>
							<IconBrandGithub size={18} />
							Continue with GitHub
						</button>

						{/* Errors bounced back from the OAuth callback land here. */}
						{error && <div className="authm-error" role="alert">{error}</div>}

						<div className="authm-divider"><span>or</span></div>

						<button ref={emailBtnRef} type="button" className="authm-email-btn" onClick={() => setEmailMode(true)}>
							Continue with email
						</button>
					</>
				) : (
					<form className="authm-form" onSubmit={submitEmail}>
						{isForgot && (
							<p className="authm-sub">
								Enter your email and we'll send you a link to choose a new
								password. If you normally sign in with Google or GitHub, use
								that button instead. Those accounts have no password here.
							</p>
						)}
						<label className="authm-field">
							<span className="authm-label">Email</span>
							<input ref={emailRef} type="email" autoComplete="email" className="authm-input" value={email}
								onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus
								aria-invalid={invalid.email || undefined}
								aria-describedby={invalid.email ? errorId : undefined} />
						</label>
						{!isForgot && (
							<label className="authm-field">
								<span className="authm-label">Password</span>
								<input
									ref={passwordRef}
									type="password"
									autoComplete={isSignup ? "new-password" : "current-password"}
									className="authm-input"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder={isSignup ? "At least 8 characters" : "••••••••"}
									aria-invalid={invalid.password || undefined}
									aria-describedby={invalid.password ? errorId : undefined}
								/>
							</label>
						)}
						{/* Sign-in only. On the signup side there is no password to have
						    forgotten, and offering a reset there just invites confusion. */}
						{!isSignup && !isForgot && (
							<button
								type="button"
								className="authm-link authm-forgot"
								onClick={() => promptAuth("forgot")}
							>
								Forgot password?
							</button>
						)}
						{error && <div id={errorId} className="authm-error" role="alert">{error}</div>}
						<button type="submit" className="authm-submit" disabled={busy}>
							{busy ? "Please wait…" : isForgot ? "Send reset link" : isSignup ? "Create account" : "Sign in"}
						</button>
						<button
							type="button"
							className="authm-back"
							onClick={() => {
								if (isForgot) { promptAuth("signin"); return; }
								// The credentials error belongs to the form, not the provider
								// screen, and a request still in flight must not bring it back.
								submitToken.current += 1;
								setBusy(false); setError(""); setInvalid(NO_FIELD);
								setEmailMode(false);
							}}
						>
							← {isForgot ? "Back to sign in" : "Other options"}
						</button>
					</form>
				)}

				{/* Consent by continuing rather than a checkbox, on both sign-up and
				    sign-in — Terms are accepted, the Privacy Policy is acknowledged.
				    The reset-password view is not an entry into the service. */}
				{!isForgot && (
					<p className="authm-fineprint">
						{AUTH_FINEPRINT_LEAD}{" "}
						<Link to="/terms" target="_blank">Terms of Service</Link>{" "}
						{AUTH_FINEPRINT_MID}{" "}
						<Link to="/privacy" target="_blank">Privacy Policy</Link>.
					</p>
				)}

				<div className="authm-toggle">
					{isForgot ? (
						<>
							Remembered it?{" "}
							{/* Keyed so React does not reuse it as the Sign up link of the next
							    screen, which would leave focus on a button that changed name. */}
							<button key="forgot-signin" type="button" className="authm-link" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						</>
					) : isSignup ? (
						<>
							Already have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						</>
					) : (
						<>
							Don't have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signup")}>
								Sign up
							</button>
						</>
					)}
				</div>
				<p className="authm-scope">For nonclinical use only. Not medical advice or for patient care.</p>
			</div>
		</div>
	);
};

export default AuthModal;
