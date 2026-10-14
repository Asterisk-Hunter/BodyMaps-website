/**
 * How the account layer reports failures: an ?auth_error= the OAuth callback
 * never sends, a provider check or a first /me check that got no answer, a
 * session that lapsed under an account action, verification links the server
 * refused or never answered, and usage reads that failed.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, AuthRequestError, useAuth, useAuthIfPresent } from "../contexts/authContext";

const USER = { id: "u1", email: "ada@example.com", name: "Ada", roles: [] };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
const serve = (route: Route) => {
	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const answer = route(u, init);
		if (answer) return answer;
		if (u.includes("/api/auth/me")) return json({ user: USER });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		if (u.includes("/api/me/usage")) return json({ plan: "free", scans: { used: 1, limit: 3, in_flight: 0, resets_at: null }, ai_messages: { used: 0, limit: 10, resets_at: null } });
		return json({});
	}) as unknown as typeof fetch;
};
const calls = (part: string) => vi.mocked(global.fetch).mock.calls.filter(([u]) => String(u).includes(part)).length;

const handle: { current: ReturnType<typeof useAuth> | null } = { current: null };
const Probe = () => {
	const auth = useAuth();
	useEffect(() => {
		handle.current = auth;
	});
	return (
		<>
			<output aria-label="who">{auth.loading ? "loading" : auth.user?.id ?? "signed out"}</output>
			<output aria-label="popup">{auth.authPrompt.open ? "open" : "closed"}</output>
			<output aria-label="oauth error">{auth.oauthError ?? ""}</output>
			<output aria-label="providers">{auth.oauthProviders === null ? "unknown" : `${auth.oauthProviders.google}`}</output>
			<output aria-label="usage">{`${auth.usage?.scans.used ?? "none"} ${auth.usageFailed ? "failed" : "ok"}`}</output>
		</>
	);
};
const auth = () => handle.current as ReturnType<typeof useAuth>;
const mount = () => render(<AuthProvider><MemoryRouter><Probe /></MemoryRouter></AuthProvider>);
const who = () => screen.getByLabelText("who");

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState({}, "", "/");
	serve(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("OAuth callback errors", () => {
	it("shows a sentence the callback sends, as sent", async () => {
		const sentence = "That account was deleted and can no longer be restored.";
		window.history.replaceState({}, "", `/team?auth_error=${encodeURIComponent(sentence)}`);
		mount();
		expect(screen.getByLabelText("oauth error")).toHaveTextContent(sentence);
		expect(window.location.search).toBe("");
	});

	it("does not echo text the callback never sends", async () => {
		window.history.replaceState({}, "", "/team?auth_error=Call%20555-0100%20to%20restore%20your%20account#room");
		mount();
		expect(screen.getByLabelText("oauth error")).toHaveTextContent("Sign-in failed. Try again.");
		expect(window.location.pathname + window.location.search + window.location.hash).toBe("/team#room");
	});

	it("removes an empty auth_error without opening the popup", async () => {
		window.history.replaceState({}, "", "/team?auth_error=&tab=1");
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		expect(window.location.search).toBe("?tab=1");
		expect(screen.getByLabelText("popup")).toHaveTextContent("closed");
	});
});

describe("provider availability", () => {
	it("stays unknown after an unanswered check and asks again when the popup opens", async () => {
		let up = false;
		serve((u) => u.includes("/oauth/providers") ? (up ? json({ google: true, github: false }) : json({}, 503)) : undefined);
		mount();
		await waitFor(() => expect(calls("/oauth/providers")).toBe(1));
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		expect(screen.getByLabelText("providers")).toHaveTextContent("unknown");

		up = true;
		act(() => auth().promptAuth("signin"));
		await waitFor(() => expect(screen.getByLabelText("providers")).toHaveTextContent("true"));
	});

	it("asks again when the tab is focused, for the sign-in card on a guarded page", async () => {
		let up = false;
		serve((u) => {
			if (!u.includes("/oauth/providers")) return undefined;
			if (!up) throw new TypeError("Failed to fetch");
			return json({ google: true, github: true });
		});
		mount();
		await waitFor(() => expect(calls("/oauth/providers")).toBe(1));
		expect(screen.getByLabelText("providers")).toHaveTextContent("unknown");
		up = true;
		act(() => { window.dispatchEvent(new Event("focus")); });
		await waitFor(() => expect(screen.getByLabelText("providers")).toHaveTextContent("true"));
	});

	it("takes a refusal from the server as both providers off", async () => {
		serve((u) => u.includes("/oauth/providers") ? json({ error: "Not found" }, 404) : undefined);
		mount();
		await waitFor(() => expect(screen.getByLabelText("providers")).toHaveTextContent("false"));
	});
});

describe("the first session check", () => {
	it("asks /me again after an unanswered first check instead of settling signed out", async () => {
		let meCalls = 0;
		serve((u) => {
			if (!u.includes("/api/auth/me")) return undefined;
			meCalls += 1;
			return meCalls === 1 ? json({ error: "Busy" }, 503) : json({ user: USER });
		});
		mount();
		expect(who()).toHaveTextContent("loading");
		await waitFor(() => expect(who()).toHaveTextContent("u1"), { timeout: 2000 });
		expect(meCalls).toBe(2);
	});

	it("settles at once on a 401", async () => {
		serve((u) => u.includes("/api/auth/me") ? json({ error: "No session" }, 401) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("signed out"));
		expect(calls("/api/auth/me")).toBe(1);
	});
});

describe("account actions", () => {
	it("a lapsed session says so and opens the sign-in popup", async () => {
		serve((u, init) => u.includes("/api/auth/me") && init?.method === "PATCH" ? json({ error: "Authentication required" }, 401) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		let message = "";
		await act(async () => { await auth().updateName("Ada L").catch((err: Error) => { message = err.message; }); });
		expect(message).toBe("Your session has ended. Sign in again.");
		expect(screen.getByLabelText("popup")).toHaveTextContent("open");
	});

	it("a 401 that lands after a sign-out does not open the popup", async () => {
		let answerSave!: (response: Response) => void;
		serve((u) => u.includes("/api/me/plan") ? new Promise<Response>((resolve) => { answerSave = resolve; }) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		let saving!: Promise<void>;
		act(() => { saving = auth().setPlan("pro").catch(() => {}); });
		await act(async () => { await auth().signOut(); });
		await act(async () => { answerSave(json({ error: "Authentication required" }, 401)); await saving; });
		expect(who()).toHaveTextContent("signed out");
		expect(screen.getByLabelText("popup")).toHaveTextContent("closed");
	});

	it("an unreachable server reads as such, not as the browser's words", async () => {
		serve((u) => { if (u.includes("/api/me/export")) throw new TypeError("Load failed"); return undefined; });
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		await expect(auth().exportData()).rejects.toThrow("Can't reach the server. Check your connection and try again.");
	});

	it("says plainly when access coupons are not set up", async () => {
		serve((u) => u.includes("/redeem-admin-coupon") ? json({ error: "Admin access coupon is not configured." }, 503) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		await expect(auth().redeemAdminCoupon("x")).rejects.toThrow("Access coupons aren't available on this site.");
	});

	it("re-reads the account when the address turns out to be verified already", async () => {
		serve((u) => u.includes("/send-verification") ? json({ sent: false, already_verified: true }) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		const before = calls("/api/auth/me");
		let result!: { alreadyVerified: boolean };
		await act(async () => { result = await auth().sendVerification(); });
		expect(result.alreadyVerified).toBe(true);
		expect(calls("/api/auth/me")).toBe(before + 1);
	});
});

describe("email verification", () => {
	it.each([
		[400, { error: "This link has expired." }, "This link has expired."],
		[429, {}, "Too many attempts. Wait a moment, then try again."],
		[502, { error: "Bad gateway" }, "Couldn't verify your email right now. Try again."],
	])("a %s carries its status and says what happened", async (status, body, message) => {
		serve((u) => u.includes("/verify-email") ? json(body, status) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		const err = await auth().verifyEmail("t").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthRequestError);
		expect((err as AuthRequestError).status).toBe(status);
		expect((err as Error).message).toBe(message);
	});

	it("tells the other tabs once the link has worked", async () => {
		serve((u) => u.includes("/verify-email") ? json({ user: { ...USER, email_verified: true } }) : undefined);
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		await act(async () => { await auth().verifyEmail("t"); });
		expect(localStorage.getItem("authChangePing")).not.toBeNull();
		expect(auth().user?.emailVerified).toBe(true);
	});
});

describe("plan usage", () => {
	it("keeps the last figures and flags a failed read", async () => {
		let fail = false;
		serve((u) => u.includes("/api/me/usage") && fail ? json({ error: "Busy" }, 503) : undefined);
		mount();
		await waitFor(() => expect(screen.getByLabelText("usage")).toHaveTextContent("1 ok"));
		fail = true;
		await act(async () => { await auth().refreshUsage(); });
		expect(screen.getByLabelText("usage")).toHaveTextContent("1 failed");
		fail = false;
		await act(async () => { await auth().refreshUsage(); });
		expect(screen.getByLabelText("usage")).toHaveTextContent("1 ok");
	});
});

describe("provider sign-in from a one-time link page", () => {
	it("returns to the app root rather than to the spent link", async () => {
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("u1"));
		const real = window.location;
		let href = "";
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { pathname: "/verify-email", search: "?token=spent", hash: "", set href(v: string) { href = v; }, get href() { return href; } },
		});
		try {
			auth().signInWithProvider("google");
			expect(href).toContain("/api/auth/oauth/google?");
			expect(href).not.toContain("next=");
			expect(href).not.toContain("spent");
			Object.defineProperty(window, "location", {
				configurable: true,
				value: { pathname: "/live/r1", search: "", hash: "#key", set href(v: string) { href = v; }, get href() { return href; } },
			});
			auth().signInWithProvider("github", true);
			expect(new URL(href, "http://localhost").searchParams.get("next")).toBe("/live/r1#key");
		} finally {
			Object.defineProperty(window, "location", { configurable: true, value: real });
		}
	});
});

describe("useAuthIfPresent", () => {
	it("is null outside an AuthProvider instead of throwing", () => {
		const Outside = () => <output aria-label="outside">{useAuthIfPresent() === null ? "none" : "some"}</output>;
		render(<Outside />);
		expect(screen.getByLabelText("outside")).toHaveTextContent("none");
	});
});

describe("signing in from the popup", () => {
	it("keeps the session check's answer when sign-in itself is refused", async () => {
		serve((u) => {
			if (u.includes("/api/auth/me")) return json({ user: null });
			if (u.includes("/api/auth/login")) return json({ error: "Invalid email or password" }, 401);
			return undefined;
		});
		mount();
		await waitFor(() => expect(who()).toHaveTextContent("signed out"));
		const err = await auth().signIn("ada@example.com", "wrong-pass").catch((e: unknown) => e);
		expect((err as AuthRequestError).status).toBe(401);
		expect(who()).toHaveTextContent("signed out");
	});
});
