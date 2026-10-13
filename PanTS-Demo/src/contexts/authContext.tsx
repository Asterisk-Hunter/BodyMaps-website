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
	hasLegacyRecentUploads, migrateVerifiedRecentUploads, persistRecentUploads,
	setRecentUploadsAccount,
} from "../helpers/recentUploads";

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

const authFetch = (path: string, init?: RequestInit) =>
	fetch(`${API_BASE}${path}`, {
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		...init,
	});

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);
	const sessionRevision = useRef(0);
	const refreshSequence = useRef(0);
	const lastSessionCheck = useRef(0);
	const currentUser = useRef<AuthUser | null>(null);
	const migratedAccounts = useRef(new Set<string>());
	const historyRevision = useRef(0);
	const [authPrompt, setAuthPrompt] = useState<{ open: boolean; mode: AuthMode }>({
		open: false, mode: "signin",
	});
	const [oauthProviders, setOauthProviders] = useState<Record<AuthProvider2, boolean> | null>(null);
	const [usage, setUsage] = useState<PlanUsage | null>(null);
	// The OAuth callback redirects back with ?auth_error=... on failure (e.g. an
	// unverified provider email colliding with an existing account). Read it once
	// on mount, then strip it from the URL so a refresh doesn't resurface it.
	const [oauthError, setOauthError] = useState<string | null>(() => {
		try {
			const params = new URLSearchParams(window.location.search);
			const err = params.get("auth_error");
			if (err) {
				params.delete("auth_error");
				const qs = params.toString();
				window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
			}
			return err;
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
		}
		currentUser.current = next;
		setRecentUploadsAccount(next?.id ?? null);
		setUser(next);
	}, []);

	const refreshMe = useCallback(async () => {
		const revision = sessionRevision.current;
		const request = ++refreshSequence.current;
		lastSessionCheck.current = Date.now();
		try {
			const res = await authFetch("/api/auth/me");
			if (revision !== sessionRevision.current || request !== refreshSequence.current) return;
			if (res.ok) {
				const { user: u } = await res.json();
				if (revision === sessionRevision.current && request === refreshSequence.current) {
					acceptUser(u ? mapApiUser(u) : null);
				}
			} else if (res.status === 401) {
				acceptUser(null);
			}
		} catch {
			// A dropped VPN or transient server failure does not revoke a session.
			// Initial restoration remains signed out; established sessions stay put
			// until an authoritative /me response (or a server expiry) says otherwise.
		} finally {
			if (revision === sessionRevision.current && request === refreshSequence.current) setLoading(false);
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
		if (!ownerId || migratedAccounts.current.has(ownerId) || !hasLegacyRecentUploads()) return;
		migratedAccounts.current.add(ownerId);
		const revision = sessionRevision.current;
		const migrationRevision = historyRevision.current;
		authFetch("/api/me/jobs").then(async (res) => {
			if (!res.ok) return;
			const data = await res.json();
			// The response identity also protects against a different tab changing
			// the session cookie between /me and this ownership lookup.
			if (data.user_id !== ownerId || currentUser.current?.id !== ownerId
				|| revision !== sessionRevision.current || migrationRevision !== historyRevision.current
				|| !Array.isArray(data.jobs)) return;
			migrateVerifiedRecentUploads(ownerId, data.jobs
				.filter((job: { session_id?: unknown }) => typeof job?.session_id === "string")
				.map((job: { session_id: string }) => job.session_id));
		}).catch(() => { /* Keep unverifiable legacy history archived and hidden. */ });
	}, [user?.id]);

	// Profile/plan responses may finish after logout or an account switch. They
	// update an existing matching identity only; they never establish a session.
	const updateCurrentUser = useCallback((apiUser: ApiUser) => {
		if (currentUser.current?.id === apiUser.id) acceptUser(mapApiUser(apiUser));
	}, [acceptUser]);

	// Which OAuth buttons to enable. Failure -> treat both as unavailable.
	useEffect(() => {
		let cancelled = false;
		authFetch("/api/auth/oauth/providers")
			.then((r) => (r.ok ? r.json() : { google: false, github: false }))
			.then((p) => !cancelled && setOauthProviders({ google: !!p.google, github: !!p.github }))
			.catch(() => !cancelled && setOauthProviders({ google: false, github: false }));
		return () => {
			cancelled = true;
		};
	}, []);

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
			if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
			const mapped = mapApiUser(data.user);
			sessionRevision.current += 1;
			acceptUser(mapped);
			setLoading(false);
			pingOtherTabs();
			return mapped;
		},
		[acceptUser]
	);

	const sendVerification = useCallback(async () => {
		const res = await authFetch("/api/auth/send-verification", { method: "POST" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't send the link. Try again.");
		return { sent: data.sent === true, alreadyVerified: data.already_verified === true };
	}, []);

	const verifyEmail = useCallback(async (token: string) => {
		const res = await authFetch("/api/auth/verify-email", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "This link has expired or has already been used.");
		// If this browser is signed in as the account that just verified,
		// reflect it immediately — the tier check reads it.
		if (data.user) updateCurrentUser(data.user);
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
			if (!res.ok) throw new Error(data.error || "Couldn't reset your password.");
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
		const next = window.location.pathname + window.location.search + window.location.hash;
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
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't save your name. Try again.");
		updateCurrentUser(data.user);
		pingOtherTabs();
	}, [updateCurrentUser]);

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
		const res = await authFetch("/api/me/export");
		if (!res.ok) throw new Error("Couldn't prepare your data. Try again.");
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bodymaps-export.json";
		a.click();
		URL.revokeObjectURL(url);
	}, []);

	const deleteScanHistory = useCallback(async () => {
		const ownerId = currentUser.current?.id ?? null;
		const res = await authFetch("/api/me/jobs", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't delete your history. Try again.");
		historyRevision.current += 1;
		persistRecentUploads([], ownerId);
		return Number(data.deleted?.jobs ?? 0);
	}, []);

	const deleteAccount = useCallback(async () => {
		const res = await authFetch("/api/me", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't delete your account. Try again.");
		// The server has already revoked every session and cleared the cookie.
		sessionRevision.current += 1;
		acceptUser(null);
		setLoading(false);
		pingOtherTabs();
		return { restoreBy: data.restore_by as string, graceDays: Number(data.grace_days) };
	}, [acceptUser]);

	const updateAccountProfile = useCallback(async (patch: Partial<AccountProfile>) => {
		// "" clears a field: the server reads an empty string as "not provided".
		const body: Record<string, string> = {};
		if ("accountType" in patch) body.account_type = patch.accountType ?? "";
		if ("organization" in patch) body.organization = patch.organization ?? "";
		if ("occupation" in patch) body.occupation = patch.occupation ?? "";
		if ("roleDescription" in patch) body.role_description = patch.roleDescription ?? "";
		if (Object.keys(body).length === 0) return;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't save your role. Try again.");
		updateCurrentUser(data.user);
	}, [updateCurrentUser]);

	const refreshUsage = useCallback(async () => {
		const ownerId = user?.id;
		const revision = sessionRevision.current;
		if (!ownerId) { setUsage(null); return; }
		try {
			const res = await authFetch("/api/me/usage");
			const next = res.ok ? await res.json() : null;
			if (currentUser.current?.id === ownerId && revision === sessionRevision.current) setUsage(next);
		} catch {
			if (currentUser.current?.id === ownerId && revision === sessionRevision.current) setUsage(null);
		}
	}, [user]);

	const setPlan = useCallback(async (plan: PlanId) => {
		const res = await authFetch("/api/me/plan", {
			method: "POST",
			body: JSON.stringify({ plan }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't change your plan. Try again.");
		updateCurrentUser(data.user);
	}, [updateCurrentUser]);

	const redeemAdminCoupon = useCallback(async (coupon: string) => {
		const res = await authFetch("/api/auth/redeem-admin-coupon", {
			method: "POST",
			body: JSON.stringify({ coupon }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't redeem that access coupon.");
		const mapped = mapApiUser(data.user);
		updateCurrentUser(data.user);
		return mapped;
	}, [updateCurrentUser]);

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
		 updateAccountProfile, setPlan, redeemAdminCoupon, usage, refreshUsage, authPrompt, promptAuth,
		 closeAuthPrompt, oauthError, clearOauthError]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
	return ctx;
}
