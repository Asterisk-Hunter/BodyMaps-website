// Real authentication against the Flask backend (B1 email/password + B2 OAuth).
//
// The session lives in an httponly cookie the JS can't read, so on mount we ask
// GET /api/auth/me to restore it; sign in/up/out hit the auth endpoints. Every
// request uses credentials:"include" so the cookie is sent (also cross-origin in
// dev). This is the single seam the whole account UI reads through.
//
// OAuth is a full-page redirect, not a fetch: the browser goes to
// /api/auth/oauth/<provider>, the backend bounces it to the provider and back,
// sets the same session cookie, and returns us to the app — where the mount-time
// /me call picks the session up. `oauthProviders` reports which buttons to
// enable (a provider without server-side credentials stays disabled).
//
// The account controls (rename, export, delete history, delete account) all go
// to real endpoints — see api/auth_blueprint.py. Deleting the account is
// reversible for a grace period: the server keeps the row and signing back in
// cancels it.
//
// The plan is real too: user_account.plan, changed through /me/plan, and its
// limits are enforced server-side (see flask-server/services/plan_store.py).
// There is no payment step — pricing hasn't been set — but the limits bite.
//
// Account type is real too: user_account.account_type, set through PATCH
// /auth/me. It still gates nothing — it exists so activity can be grouped by it
// — but it is no longer a localStorage value the server has never seen.
//
// Not wired yet: emailNotifications -> B3, still a client-only localStorage pref.
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	type AccountProfile,
	type AccountType,
	type PlanId,
} from "../helpers/accountProfile";
import { track } from "../helpers/analytics";
import { API_BASE } from "../helpers/constants";
import { avatarMaxBytes, avatarSizeLabel } from "../helpers/deploymentCapabilities";
import { clearLocalNiftiFile } from "../helpers/localNifti";
import { clearLocalDicomFiles } from "../helpers/dicomLocal";
import {
	migrateVerifiedRecentUploads, persistRecentUploads,
	setRecentUploadsAccount,
} from "../helpers/recentUploads";
import { mergeServerHistory } from '../helpers/serverHistory';

export type AuthUser = {
	id: string;
	email: string;
	/** The name the user set, or one derived from their email if they haven't. */
	name: string;
	/** True when `name` is the user's own rather than derived from the email. */
	hasCustomName: boolean;
	/** Owner-only, versioned avatar URL returned by the server. */
	avatarUrl: string | null;
	emailNotifications: boolean; // client-only preference until B3
	/** Whether the account's email address has been verified. */
	emailVerified: boolean;
	/** Billing plan, from user_account.plan. Its limits are enforced server-side. */
	plan: PlanId;
	/** Self-reported account type, from user_account.account_type. Gates nothing. */
	profile: AccountProfile;
	/** Roles held, from the user_role table ("admin" is the only one). The server
	 *  enforces them; these only decide what the UI offers to draw. */
	roles: string[];
};

/** What GET /me/usage returns: the plan's limits and what's been used of them. */
export type PlanUsage = {
	plan: PlanId;
	scans: { used: number; limit: number | null; in_flight: number; resets_at: string | null };
	ai_messages: { used: number; limit: number | null; resets_at: string | null };
};

export type AuthProvider2 = "google" | "github";
// "forgot" is the same card again, asking only for an email. It isn't reachable
// from the header — you get there from the sign-in form, having failed at it.
export type AuthMode = "signin" | "signup" | "forgot";

type AuthContextValue = {
	user: AuthUser | null;
	isAuthenticated: boolean;
	/** True until the initial /me check resolves (avoids a signed-out flash). */
	loading: boolean;
	signIn: (email: string, password: string, rememberMe?: boolean) => Promise<AuthUser>;
	/** `name` is optional and is stored server-side on user_account.name. */
	signUp: (email: string, password: string, name?: string, rememberMe?: boolean) => Promise<AuthUser>;
	/** Full-page redirect into the provider's consent screen. Never returns. */
	signInWithProvider: (provider: AuthProvider2, rememberMe?: boolean) => void;
	/**
	 * Ask for a reset link. Resolves whether or not an account exists — the
	 * server answers the same way either way, so that nobody can use this to
	 * discover which addresses are registered. The UI has to say "if an account
	 * exists" rather than "sent", because it genuinely doesn't know.
	 */
	requestPasswordReset: (email: string) => Promise<void>;
	/** Redeem a reset token. On success the user is signed in. */
	resetPassword: (token: string, password: string) => Promise<AuthUser>;
	/** (Re)send the verification link for the signed-in account. `sent` is the
	 *  truth from the server — false means SMTP is off and the link only went
	 *  to the server log. */
	sendVerification: () => Promise<{ sent: boolean; alreadyVerified: boolean }>;
	/** Redeem an emailed verification token. Public: works signed out too. */
	verifyEmail: (token: string) => Promise<void>;
	/** Which providers the server has credentials for (null until loaded). */
	oauthProviders: Record<AuthProvider2, boolean> | null;
	signOut: () => Promise<void>;
	updatePreferences: (patch: Partial<Pick<AuthUser, "emailNotifications">>) => void;
	/** Set the display name. An empty string clears it back to the email default. */
	updateName: (name: string) => Promise<void>;
	/** Save a picture (or remove it with null), optionally updating the name atomically. */
	updateAvatar: (file: File | null, name?: string) => Promise<void>;
	/** Download everything the server holds for this account as a JSON file. */
	exportData: () => Promise<void>;
	/** Delete every scan and result, keeping the account. Returns how many went. */
	deleteScanHistory: () => Promise<number>;
	/**
	 * Schedule the account for deletion and sign out. Reversible by signing back
	 * in — resolves with the deadline and the grace period, so the UI can say so.
	 */
	deleteAccount: () => Promise<{ restoreBy: string; graceDays: number }>;
	/** Patch the self-reported account type. Persisted server-side. */
	updateAccountProfile: (patch: Partial<AccountProfile>) => Promise<void>;
	/** Move to another plan. No payment step — pricing isn't set. */
	setPlan: (plan: PlanId) => Promise<void>;
	/** Redeem a server-configured access coupon for sponsored model access. */
	redeemAdminCoupon: (coupon: string) => Promise<AuthUser>;
	/** Current plan usage, or null until loaded. Refreshed by refreshUsage(). */
	usage: PlanUsage | null;
	/** The last usage read failed. `usage` keeps the last good figures, if any. */
	usageFailed: boolean;
	refreshUsage: () => Promise<void>;
	// Global auth popup, opened from the header or any gated action. Signing up
	// and signing in are the same card with a different title, the way both
	// Claude and ChatGPT do it — `mode` picks which.
	authPrompt: { open: boolean; mode: AuthMode };
	/** Defaults to sign-in: most people reaching a gate already have an account. */
	promptAuth: (mode?: AuthMode) => void;
	closeAuthPrompt: () => void;
	/** Error surfaced by the OAuth callback redirect (?auth_error=...), if any. */
	oauthError: string | null;
	clearOauthError: () => void;
};

// Cross-tab sync: writing this key on any auth change nudges other tabs to
// re-check /me (we can't watch the httponly cookie directly).
const AUTH_PING_KEY = "authChangePing";

const nameFromEmail = (email: string): string => {
	const local = email.split("@")[0] || email;
	return (
		local
			.split(/[._-]+/)
			.filter(Boolean)
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
			.join(" ") || email
	);
};

// Email-notification preference is client-only until the backend supports it.
const prefKey = (id: string) => `emailNotif:${id}`;
const loadPref = (id: string): boolean => {
	try {
		const v = localStorage.getItem(prefKey(id));
		return v === null ? true : v === "1";
	} catch {
		return true;
	}
};
const savePref = (id: string, on: boolean) => {
	try {
		localStorage.setItem(prefKey(id), on ? "1" : "0");
	} catch {
		/* ignore */
	}
};

type ApiUser = {
	id: string;
	email: string;
	name?: string | null;
	avatar_url?: string | null;
	plan?: string | null;
	account_type?: string | null;
	organization?: string | null;
	occupation?: string | null;
	role_description?: string | null;
	email_verified?: boolean;
	roles?: string[] | null;
};
const mapApiUser = (u: ApiUser): AuthUser => {
	const custom = (u.name || "").trim();
	return {
		id: u.id,
		email: u.email,
		// Accounts predating the name column have none — fall back to the email.
		name: custom || nameFromEmail(u.email),
		hasCustomName: custom.length > 0,
		avatarUrl: u.avatar_url?.startsWith("/api/auth/avatar/") ? `${API_BASE}${u.avatar_url}` : null,
		emailNotifications: loadPref(u.id),
		emailVerified: u.email_verified === true,
		plan: (u.plan as PlanId) || "free",
		profile: {
			accountType: (u.account_type as AccountType) || null,
			organization: u.organization || null,
			occupation: u.occupation || null,
			roleDescription: u.role_description || null,
		},
		// Defaulted, never invented: an endpoint that forgets to send roles
		// leaves you with none, which fails closed.
		roles: u.roles ?? [],
	};
};

// fetch() rejects with the browser's own wording ("Failed to fetch" in Chrome,
// "Load failed" in Safari) when the request never reached the server, and the
// sign-in popup and Settings show an error's message as it is. Say what
// actually happened instead; HTTP errors keep the server's message.
class UnreachableError extends Error {}

/** The message for a failed account request. A lapsed session says so in plain words instead of the server's text. */
const failureMessage = (res: Response, data: { error?: string }, fallback: string) =>
	res.status === 401 ? "Your session has ended. Sign in again." : data.error || fallback;

const authFetch = async (path: string, init?: RequestInit) => {
	try {
		return await fetch(`${API_BASE}${path}`, {
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			...init,
		});
	} catch (err) {
		if (err instanceof TypeError) {
			throw new UnreachableError("Can't reach the server. Check your connection and try again.");
		}
		throw err;
	}
};

/** An error from a request the server answered, with the status it answered with. */
export class AuthRequestError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

// The sentences the OAuth callback redirects back with (see oauth_blueprint.py
// and OAuthLinkRefusedError in auth_store.py). The error comes in on the URL,
// which anyone can write, so only these are shown; anything else reads as the
// generic failure.
const OAUTH_ERROR_FALLBACK = "Sign-in failed. Try again.";
const OAUTH_ERRORS = new Set([
	"Sign-in was cancelled or failed. Please try again.",
	"Couldn't read your profile from the provider.",
	"Could not complete sign-in. Please try again.",
	"That email can't be used for sign-in.",
	"That account was deleted and can no longer be restored.",
	"An account with that email already exists. Sign in with your password first, then link this provider.",
	"Your provider didn't share an email address, which we need to create an account.",
]);

// Waits before asking /me again, while nobody is signed in on the page, after
// an answer that says nothing about the session: no reply at all, a 5xx, or
// the rate limit.
const ME_RETRY_DELAYS_MS = [400, 1200];

// A 5xx or the rate limit says nothing about the session or the providers.
const unanswered = (status: number) => status === 429 || status >= 500;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);
	const sessionRevision = useRef(0);
	const refreshSequence = useRef(0);
	const lastSessionCheck = useRef(0);
	const currentUser = useRef<AuthUser | null>(null);
	const historyRevision = useRef(0);
	const [authPrompt, setAuthPrompt] = useState<{ open: boolean; mode: AuthMode }>({
		open: false, mode: "signin",
	});
	const [oauthProviders, setOauthProviders] = useState<Record<AuthProvider2, boolean> | null>(null);
	const [usage, setUsage] = useState<PlanUsage | null>(null);
	const [usageFailed, setUsageFailed] = useState(false);
	// Bumped by every refreshUsage, so a read that comes back after a newer one
	// began (sign-out, another account, a plan change) is dropped.
	const usageRequest = useRef(0);
	// The OAuth callback redirects back with ?auth_error=... on failure (e.g. an
	// unverified provider email colliding with an existing account). Read it once
	// on mount, then strip it from the URL so a refresh doesn't resurface it.
	const [oauthError, setOauthError] = useState<string | null>(() => {
		try {
			const params = new URLSearchParams(window.location.search);
			const err = params.get("auth_error");
			if (err !== null) {
				params.delete("auth_error");
				const qs = params.toString();
				window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
			}
			return err ? (OAUTH_ERRORS.has(err) ? err : OAUTH_ERROR_FALLBACK) : null;
		} catch {
			return null;
		}
	});

	// Set the storage scope before protected children can render. Account-specific
	// in-memory providers are also remounted by App when the identity changes.
	const acceptUser = useCallback((next: AuthUser | null) => {
		if (currentUser.current?.id !== next?.id) {
			clearLocalNiftiFile();
			clearLocalDicomFiles();
			setUsage(null);
			setUsageFailed(false);
		}
		currentUser.current = next;
		setRecentUploadsAccount(next?.id ?? null);
		setUser(next);
	}, []);

	const refreshMe = useCallback(async () => {
		const revision = sessionRevision.current;
		const request = ++refreshSequence.current;
		lastSessionCheck.current = Date.now();
		const latest = () => revision === sessionRevision.current && request === refreshSequence.current;
		try {
			for (let attempt = 0; ; attempt++) {
				let retry = false;
				try {
					const res = await authFetch("/api/auth/me");
					if (!latest()) return;
					if (res.ok) {
						const { user: u } = await res.json();
						if (latest()) acceptUser(u ? mapApiUser(u) : null);
						return;
					}
					if (res.status === 401) {
						acceptUser(null);
						return;
					}
					retry = unanswered(res.status);
				} catch (err) {
					// A dropped VPN or transient server failure does not revoke a session.
					// Established sessions stay put until an authoritative /me response
					// (or a server expiry) says otherwise.
					retry = err instanceof UnreachableError;
				}
				// With nobody signed in yet (a first load) there is no one to keep, so
				// a blip would settle the page signed out: ask again shortly first.
				// After the last try it still settles signed out.
				if (!retry || currentUser.current !== null || attempt >= ME_RETRY_DELAYS_MS.length) return;
				await new Promise((resolve) => setTimeout(resolve, ME_RETRY_DELAYS_MS[attempt]));
				if (!latest()) return;
			}
		} finally {
			if (latest()) setLoading(false);
		}
	}, [acceptUser]);

	useEffect(() => {
		// These browser-only File stashes live outside React providers. Reset
		// them before initial authentication can expose any protected viewer.
		clearLocalNiftiFile();
		clearLocalDicomFiles();
		setRecentUploadsAccount(null);
		void refreshMe();
		return () => { sessionRevision.current += 1; setRecentUploadsAccount(null); };
	}, [refreshMe]);

	// A background tab may miss a storage event. Revalidate when it returns,
	// bounded to once per 15 seconds. WebSocket 4401 is an explicit revocation.
	useEffect(() => {
		const resume = () => {
			if (document.visibilityState !== "hidden" && Date.now() - lastSessionCheck.current >= 15_000) void refreshMe();
		};
		const expired = () => {
			sessionRevision.current += 1;
			acceptUser(null);
			setLoading(false);
		};
		window.addEventListener("focus", resume);
		document.addEventListener("visibilitychange", resume);
		window.addEventListener("bodymaps:session-expired", expired);
		return () => {
			window.removeEventListener("focus", resume);
			document.removeEventListener("visibilitychange", resume);
			window.removeEventListener("bodymaps:session-expired", expired);
		};
	}, [acceptUser, refreshMe]);

	useEffect(() => {
		const ownerId = user?.id;
		if (!ownerId) return;
		let cancelled = false;
		let lastAttempt = -Infinity;
		let inFlight: AbortController | null = null;
		const refreshHistory = async () => {
			if (document.visibilityState === 'hidden' || inFlight || Date.now() - lastAttempt < 60_000) return;
			lastAttempt = Date.now();
			const controller = new AbortController();
			inFlight = controller;
			const timer = window.setTimeout(() => controller.abort(), 10_000);
			const revision = sessionRevision.current;
			const migrationRevision = historyRevision.current;
			try {
				const res = await authFetch("/api/me/jobs", { signal: controller.signal });
				if (!res.ok) return;
				const data = await res.json();
				// A different tab may change the cookie between /me and this lookup.
				if (cancelled || controller.signal.aborted || data.user_id !== ownerId || currentUser.current?.id !== ownerId
					|| revision !== sessionRevision.current || migrationRevision !== historyRevision.current
					|| !Array.isArray(data.jobs)) return;
				migrateVerifiedRecentUploads(ownerId, data.jobs
					.filter((job: { session_id?: unknown }) => typeof job?.session_id === "string")
					.map((job: { session_id: string }) => job.session_id));
				mergeServerHistory(ownerId, data.jobs);
			} catch { /* Keep cached history on transient failure; never guess ownership. */ }
			finally { window.clearTimeout(timer); inFlight = null; }
		};
		const resume = () => { void refreshHistory(); };
		resume();
		window.addEventListener('focus', resume);
		window.addEventListener('online', resume);
		document.addEventListener('visibilitychange', resume);
		return () => {
			cancelled = true;
			inFlight?.abort();
			window.removeEventListener('focus', resume);
			window.removeEventListener('online', resume);
			document.removeEventListener('visibilitychange', resume);
		};
	}, [user?.id]);

	// Profile/plan responses may finish after logout or an account switch. They
	// update an existing matching identity only; they never establish a session.
	const updateCurrentUser = useCallback((apiUser: ApiUser) => {
		if (currentUser.current?.id === apiUser.id) acceptUser(mapApiUser(apiUser));
	}, [acceptUser]);

	// Which OAuth buttons to enable. Only an answer from the server decides: a
	// server that was busy or not reached says nothing about the providers, so
	// the list stays unknown (the buttons wait) rather than switching both off
	// for the rest of the visit. While it is unknown it is asked again each time
	// the popup opens, and when the tab is focused or the connection comes back,
	// which covers the sign-in card on a guarded page (it never "opens").
	const providersUnknown = oauthProviders === null;
	const [providersAsk, setProvidersAsk] = useState(0);
	useEffect(() => {
		if (!providersUnknown) return;
		let cancelled = false;
		authFetch("/api/auth/oauth/providers")
			.then((r) => (r.ok ? r.json() : unanswered(r.status) ? null : { google: false, github: false }))
			.then((p) => {
				if (p && !cancelled) setOauthProviders({ google: !!p.google, github: !!p.github });
			})
			.catch(() => { /* not reached: still unknown, asked again later */ });
		return () => {
			cancelled = true;
		};
	}, [providersUnknown, authPrompt.open, providersAsk]);
	useEffect(() => {
		if (!providersUnknown) return;
		const askAgain = () => setProvidersAsk((n) => n + 1);
		window.addEventListener("focus", askAgain);
		window.addEventListener("online", askAgain);
		return () => {
			window.removeEventListener("focus", askAgain);
			window.removeEventListener("online", askAgain);
		};
	}, [providersUnknown]);

	// If we came back from a failed OAuth attempt, show the popup with the error.
	// Sign-in mode: the failure message tells them what to do, and the signup
	// side's terms fine print would be noise on top of an error.
	useEffect(() => {
		if (oauthError) setAuthPrompt({ open: true, mode: "signin" });
	}, [oauthError]);

	// Cross-tab: another tab signed in/out -> re-check.
	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key === AUTH_PING_KEY) refreshMe();
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [refreshMe]);

	const pingOtherTabs = () => {
		try {
			localStorage.setItem(AUTH_PING_KEY, String(Date.now()));
		} catch {
			/* ignore */
		}
	};

	const authAction = useCallback(
		async (path: string, email: string, password: string, name?: string, rememberMe = false) => {
			const body: Record<string, string | boolean> = { email, password, remember_me: rememberMe };
			if (name?.trim()) body.name = name.trim();
			const res = await authFetch(path, { method: "POST", body: JSON.stringify(body) });
			const data = await res.json().catch(() => ({}));
			// The status rides along so the popup can mark only the field at fault.
			if (!res.ok) throw new AuthRequestError(data.error || "Something went wrong. Try again.", res.status);
			const mapped = mapApiUser(data.user);
			sessionRevision.current += 1;
			acceptUser(mapped);
			setLoading(false);
			pingOtherTabs();
			return mapped;
		},
		[acceptUser]
	);

	// A 401 on an account action means the session lapsed while the page still
	// shows the account: say so and open the sign-in popup rather than echoing
	// the server. An action that began before a sign-out or an account switch
	// passes the session revision it started under: its 401 is that change
	// landing first, so the popup stays shut.
	const accountFailure = useCallback((res: Response, data: { error?: string }, fallback: string, revision: number) => {
		if (res.status === 401 && revision === sessionRevision.current) {
			track("auth_open_modal");
			setAuthPrompt({ open: true, mode: "signin" });
		}
		return new Error(failureMessage(res, data, fallback));
	}, []);

	const sendVerification = useCallback(async () => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/auth/send-verification", { method: "POST" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't send the link. Try again.", revision);
		// The link may have been opened where no other tab could be told, so
		// read the account again rather than leave the Profile row stale.
		if (data.already_verified === true) await refreshMe();
		return { sent: data.sent === true, alreadyVerified: data.already_verified === true };
	}, [accountFailure, refreshMe]);

	const verifyEmail = useCallback(async (token: string) => {
		const res = await authFetch("/api/auth/verify-email", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			// Only a 400 says the token was refused. A rate limit or a 5xx says
			// nothing about it, and the page offers another try.
			throw new AuthRequestError(
				res.status === 400
					? data.error || "This link has expired or has already been used."
					: res.status === 429
						? data.error || "Too many attempts. Wait a moment, then try again."
						: "Couldn't verify your email right now. Try again.",
				res.status
			);
		}
		// If this browser is signed in as the account that just verified,
		// reflect it immediately — the tier check reads it.
		if (data.user) updateCurrentUser(data.user);
		// The link usually opens in a new tab: the others re-check who is signed in.
		pingOtherTabs();
	}, [updateCurrentUser]);

	const signIn = useCallback(
		(email: string, password: string, rememberMe = false) => authAction("/api/auth/login", email, password, undefined, rememberMe),
		[authAction]
	);
	// The name goes to the server with the registration — /auth/register takes it,
	// so a signup name lands in user_account.name rather than in local storage.
	const signUp = useCallback(
		(email: string, password: string, name?: string, rememberMe = false) =>
			authAction("/api/auth/register", email, password, name, rememberMe),
		[authAction]
	);

	const requestPasswordReset = useCallback(async (email: string) => {
		const res = await authFetch("/api/auth/forgot-password", {
			method: "POST",
			body: JSON.stringify({ email }),
		});
		// 200 whether or not the address has an account. The only failure worth
		// surfacing is the rate limit, which is a thing the user can act on.
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Couldn't send the link. Try again.");
		}
	}, []);

	const resetPassword = useCallback(
		async (token: string, password: string) => {
			const res = await authFetch("/api/auth/reset-password", {
				method: "POST",
				body: JSON.stringify({ token, password }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new AuthRequestError(data.error || "Couldn't reset your password.", res.status);
			}
			const mapped = mapApiUser(data.user);
			sessionRevision.current += 1;
			acceptUser(mapped);
			setLoading(false);
			pingOtherTabs();
			return mapped;
		},
		[acceptUser]
	);

	// OAuth can't be a fetch: the provider's consent screen has to be a top-level
	// navigation (and the backend needs to set the cookie on the way back), so we
	// hand the whole browser over. On return, the mount-time /me call restores
	// the session.
	const signInWithProvider = useCallback((provider: AuthProvider2, rememberMe = false) => {
		// Hand the backend the page we're leaving so its callback can send us
		// back here instead of to the app root. Same-origin relative path only;
		// the backend re-validates it before redirecting.
		// The one-time link pages are the exception: their token is spent on
		// load, so coming back to the same URL would only report it as used (and
		// would park it in the server session). Those return to the app root.
		const oneTime = /\/(verify-email|reset-password)\/?$/.test(window.location.pathname);
		const next = oneTime ? "" : window.location.pathname + window.location.search + window.location.hash;
		const qs = new URLSearchParams({ remember_me: rememberMe ? "1" : "0" });
		if (next && next !== "/") qs.set("next", next);
		window.location.href = `${API_BASE}/api/auth/oauth/${provider}?${qs}`;
	}, []);

	const signOut = useCallback(async () => {
		// Notify other tabs only after the cookie/session has been revoked. An
		// earlier ping lets those tabs restore the still-valid session again.
		const res = await authFetch("/api/auth/logout", { method: "POST" });
		if (!res.ok && res.status !== 401) {
			throw new Error("Couldn't sign out. Please try again.");
		}
		sessionRevision.current += 1;
		acceptUser(null);
		setLoading(false);
		pingOtherTabs();
		track("auth_sign_out");
	}, [acceptUser]);

	const promptAuth = useCallback((mode: AuthMode = "signin") => {
		track("auth_open_modal");
		setAuthPrompt({ open: true, mode });
	}, []);
	const closeAuthPrompt = useCallback(
		() => setAuthPrompt((p) => ({ ...p, open: false })),
		[]
	);

	// Auto-close the popup once a user is established.
	useEffect(() => {
		if (user) setAuthPrompt((p) => (p.open ? { ...p, open: false } : p));
	}, [user]);

	const updatePreferences = useCallback(
		(patch: Partial<Pick<AuthUser, "emailNotifications">>) => {
			setUser((prev) => {
				if (!prev) return prev;
				const next = { ...prev, ...patch };
				if (typeof next.emailNotifications === "boolean") savePref(next.id, next.emailNotifications);
				return next;
			});
		},
		[]
	);

	const updateName = useCallback(async (name: string) => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't save your name. Try again.", revision);
		updateCurrentUser(data.user);
		pingOtherTabs();
	}, [accountFailure, updateCurrentUser]);

	const updateAvatar = useCallback(async (file: File | null, name?: string) => {
		let request: RequestInit;
		if (file) {
			if (file.size > avatarMaxBytes()) throw new Error(`Choose an image up to ${avatarSizeLabel()}.`);
			const body = new FormData();
			body.append("avatar", file);
			if (name !== undefined) body.append("name", name);
			// Let the browser supply the multipart boundary.
			request = { method: "PUT", body };
		} else {
			request = { method: "DELETE", headers: { "Content-Type": "application/json" },
				body: JSON.stringify(name === undefined ? {} : { name }) };
		}
		const res = await fetch(`${API_BASE}/api/auth/avatar`, { credentials: "include", ...request });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || (res.status === 413
			? "The server rejected this picture's size. Choose a smaller image and try again."
			: "Couldn't save your profile picture. Try again."));
		updateCurrentUser(data.user);
		pingOtherTabs();
	}, [updateCurrentUser]);

	// Streams straight from the server so the file is the real record, not a
	// reconstruction from whatever this browser happens to have cached.
	const exportData = useCallback(async () => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/me/export");
		if (!res.ok) throw accountFailure(res, {}, "Couldn't prepare your data. Try again.", revision);
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bodymaps-export.json";
		a.click();
		URL.revokeObjectURL(url);
	}, [accountFailure]);

	const deleteScanHistory = useCallback(async () => {
		const ownerId = currentUser.current?.id ?? null;
		const revision = sessionRevision.current;
		const res = await authFetch("/api/me/jobs", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't delete your history. Try again.", revision);
		historyRevision.current += 1;
		persistRecentUploads([], ownerId);
		return Number(data.deleted?.jobs ?? 0);
	}, [accountFailure]);

	const deleteAccount = useCallback(async () => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/me", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't delete your account. Try again.", revision);
		// The server has already revoked every session and cleared the cookie.
		sessionRevision.current += 1;
		acceptUser(null);
		setLoading(false);
		pingOtherTabs();
		return { restoreBy: data.restore_by as string, graceDays: Number(data.grace_days) };
	}, [acceptUser, accountFailure]);

	const updateAccountProfile = useCallback(async (patch: Partial<AccountProfile>) => {
		// "" clears a field: the server reads an empty string as "not provided".
		const body: Record<string, string> = {};
		if ("accountType" in patch) body.account_type = patch.accountType ?? "";
		if ("organization" in patch) body.organization = patch.organization ?? "";
		if ("occupation" in patch) body.occupation = patch.occupation ?? "";
		if ("roleDescription" in patch) body.role_description = patch.roleDescription ?? "";
		if (Object.keys(body).length === 0) return;
		const revision = sessionRevision.current;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't save your profile. Try again.", revision);
		updateCurrentUser(data.user);
	}, [accountFailure, updateCurrentUser]);

	const refreshUsage = useCallback(async () => {
		const ownerId = user?.id;
		const revision = sessionRevision.current;
		const request = ++usageRequest.current;
		if (!ownerId) { setUsage(null); setUsageFailed(false); return; }
		const stillAsked = () =>
			request === usageRequest.current && currentUser.current?.id === ownerId && revision === sessionRevision.current;
		// A failed read keeps what is already shown (a plan change whose re-read
		// fails shouldn't blank the bars; another account's figures were already
		// cleared when it took over) and is reported as failed, so the Plan page
		// can offer a retry rather than saying "Loading…" for good.
		try {
			const res = await authFetch("/api/me/usage");
			if (!res.ok) throw new Error(`Usage request failed (${res.status})`);
			const next = (await res.json()) as PlanUsage;
			if (!stillAsked()) return;
			setUsage(next);
			setUsageFailed(false);
		} catch {
			if (stillAsked()) setUsageFailed(true);
		}
	}, [user]);

	const setPlan = useCallback(async (plan: PlanId) => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/me/plan", {
			method: "POST",
			body: JSON.stringify({ plan }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't change your plan. Try again.", revision);
		updateCurrentUser(data.user);
	}, [accountFailure, updateCurrentUser]);

	const redeemAdminCoupon = useCallback(async (coupon: string) => {
		const revision = sessionRevision.current;
		const res = await authFetch("/api/auth/redeem-admin-coupon", {
			method: "POST",
			body: JSON.stringify({ coupon }),
		});
		const data = await res.json().catch(() => ({}));
		// An unconfigured deployment answers 503 with a server string; say it plainly.
		if (res.status === 503) throw new Error("Access coupons aren't available on this site.");
		if (!res.ok) throw accountFailure(res, data, "Couldn't redeem that access coupon.", revision);
		const mapped = mapApiUser(data.user);
		updateCurrentUser(data.user);
		return mapped;
	}, [accountFailure, updateCurrentUser]);

	// Keep usage in step with whoever is signed in — including after a plan
	// change, since the limits it reports come from the plan.
	useEffect(() => {
		refreshUsage();
	}, [refreshUsage]);

	const clearOauthError = useCallback(() => setOauthError(null), []);

	const value = useMemo<AuthContextValue>(
		() => ({
			user,
			isAuthenticated: user !== null,
			loading,
			signIn,
			signUp,
			signInWithProvider,
			requestPasswordReset,
			resetPassword,
			sendVerification,
			verifyEmail,
			oauthProviders,
			signOut,
			updatePreferences,
			updateName,
			updateAvatar,
			exportData,
			deleteScanHistory,
			deleteAccount,
			 updateAccountProfile,
			 setPlan,
			 redeemAdminCoupon,
			 usage,
			usageFailed,
			refreshUsage,
			authPrompt,
			promptAuth,
			closeAuthPrompt,
			oauthError,
			clearOauthError,
		}),
		[user, loading, signIn, signUp, signInWithProvider, requestPasswordReset,
		 resetPassword, sendVerification, verifyEmail, oauthProviders, signOut,
		 updatePreferences, updateName, updateAvatar, exportData, deleteScanHistory, deleteAccount,
		 updateAccountProfile, setPlan, redeemAdminCoupon, usage, usageFailed, refreshUsage, authPrompt, promptAuth,
		 closeAuthPrompt, oauthError, clearOauthError]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
	return ctx;
}

/** Like useAuth, but null outside an AuthProvider: for a page that only needs to know who is looking. */
export function useAuthIfPresent(): AuthContextValue | null {
	return useContext(AuthContext);
}
