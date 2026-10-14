/**
 * Regressions found in review round 1, one describe per fix.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessagePage from "../components/MessagePage";
import ReportScreen from "../components/ReportScreen/ReportScreen";
import { AuthProvider } from "../contexts/authContext";
import VerifyEmail from "../routes/VerifyEmail";

/** The body of the `@media` block whose query is exactly `query`. */
function mediaBlock(css: string, query: string): string {
	const start = css.indexOf(`@media (${query}) {`);
	if (start < 0) throw new Error(`no @media (${query})`);
	let depth = 0;
	for (let i = css.indexOf("{", start); i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
	}
	throw new Error("unbalanced");
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|[};/])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
	if (!match) throw new Error(`no rule for ${selector}`);
	return match[1];
}

describe("report walkthrough story card on a phone", () => {
	const source = readFileSync(resolve(process.cwd(), "src/components/ReportScreen/ReportScreen.tsx"), "utf8");
	const STYLES = /const STYLES = `([\s\S]*?)`;/.exec(source)![1];
	const ID = "regress-r1-story";
	const report = {
		case_id: ID,
		report_schema_version: "3",
		patient: { age: 61, sex: "F" },
		organ_volumes: {
			liver: { volume: 1500, mean_hu: 55, status: "not_assessed" },
			lung_left: { volume: 900, mean_hu: -800, status: "not_assessed" },
		},
		comments: "",
		impression: [],
		source_report: { available: false, source: "Synthetic report fixture", text: "", findings: "", impression: [], reviewed_by_clinician: false },
		provenance: { report_source: "Synthetic report fixture", measurements_source: "Synthetic CT + segmentation", image_review_performed: false },
		coverage: { status: "limited", measured_structures: 2, limitations: [] },
	};

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => report }) as Response));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("does not let the scrolling story card shrink inside the fixed-height stage column", () => {
		const narrow = mediaBlock(STYLES, "max-width: 899px");
		// The stage is a fixed-height column that scrolls, and the card scrolls too.
		expect(rule(narrow, ".rs-stage")).toMatch(/flex-direction: column/);
		expect(rule(narrow, ".rs-stage")).toMatch(/overflow-y: auto/);
		const story = rule(narrow, ".rs-story");
		expect(story).toMatch(/max-height: 46vh/);
		expect(story).toMatch(/overflow-y: auto/);
		// A flex item with overflow other than visible has a minimum height of 0,
		// so without this it collapses under whatever is stacked below it and the
		// column never scrolls.
		expect(story).toMatch(/flex(?:-shrink)?:\s*(?:none|0)\b/);
	});

	it("keeps the step's action row pinned inside the card", async () => {
		render(<ReportScreen id={ID} onClose={vi.fn()} onViewChange={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		const story = document.querySelector(".rs-story")!;
		// The stacked column the card has to hold its size in.
		const stage = story.closest(".rs-stage")!;
		expect(stage.querySelector(".rs-timeline")).not.toBeNull();
		const actions = story.querySelector(".rs-story-actions");
		expect(actions).toContainElement(screen.getByRole("button", { name: "Report scope" }));
		expect(actions).toContainElement(screen.getByRole("button", { name: "Continue" }));
		const pinned = rule(mediaBlock(STYLES, "max-width: 899px"), ".rs-story-actions");
		expect(pinned).toMatch(/position: sticky/);
		expect(pinned).toMatch(/bottom: -24px/);
	});
});

describe("shared message page", () => {
	it("draws a button action in the shared message page like its link actions", () => {
		const onClick = vi.fn();
		render(
			<AuthProvider>
				<MemoryRouter>
					<MessagePage title="Nothing here" actions={[{ label: "Home", to: "/" }, { label: "Sign in", onClick }]} />
				</MemoryRouter>
			</AuthProvider>
		);
		const button = within(screen.getByRole("main")).getByRole("button", { name: "Sign in" });
		expect(button.className).toContain("secondary");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
		const css = readFileSync(resolve(process.cwd(), "src/components/MessagePage/MessagePage.module.css"), "utf8");
		// Without the reset a <button> keeps the browser's grey face and border.
		expect(rule(css, "button.secondary")).toMatch(/background:\s*none/);
		expect(css).toMatch(/button\.primary,\s*button\.secondary\s*\{[^}]*border:\s*0/);
	});
});

describe("verify-email card before the session check returns", () => {
	const account = {
		id: "u1",
		email: "reader@example.com",
		name: null,
		plan: "free",
		email_verified: false,
		roles: [] as string[],
	};
	const json = (body: unknown, ok = true, status = 200) => ({
		ok,
		status,
		json: async () => body,
		text: async () => "",
		headers: { get: () => "application/json" },
	});
	/** Lets the test decide when GET /api/auth/me answers, and who it says is signed in. */
	let releaseMe: (signedIn: boolean) => void;
	let verifyResult: "expired" | "verified";

	beforeEach(() => {
		verifyResult = "expired";
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/verify-email")) {
				return verifyResult === "verified"
					? json({ ok: true, user: account })
					: json({ error: "This link has expired." }, false, 400);
			}
			if (u.includes("/api/auth/me")) {
				return new Promise((resolve) => {
					releaseMe = (signedIn) => resolve(json({ user: signedIn ? account : null }));
				});
			}
			return json({ google: false, github: false });
		}) as unknown as typeof fetch;
	});
	afterEach(() => vi.restoreAllMocks());

	const renderAt = (url: string) =>
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={[url]}>
					<Routes>
						<Route path="/verify-email" element={<VerifyEmail />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
	const meAnswers = (signedIn: boolean) => act(async () => releaseMe(signedIn));

	it("shows neither the signed-out note nor a Sign in button to someone who is signed in", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");

		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Open settings" })).toBeNull();
		const note = screen.queryByText(/After signing in/);
		if (note) expect(note).not.toBeVisible();

		await meAnswers(true);
		expect(await screen.findByRole("link", { name: "Open settings" })).toHaveAttribute("href", "/account");
		expect(screen.queryByText(/After signing in/)).toBeNull();
		expect(screen.getByText(/^You can ask for a fresh link/)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
	});

	it("holds the note's and the action's place while the check is out, so the card does not jump", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");

		const note = document.querySelector("p.authm-sent + p.authm-sent") as HTMLElement;
		const action = document.querySelector(".rp-action") as HTMLElement;
		for (const held of [note, action]) {
			expect(held).not.toBeNull();
			expect(held).toHaveAttribute("aria-hidden", "true");
			expect(held).not.toBeVisible();
		}
		// A placeholder, not a control: nothing to tab to or activate.
		expect(action.tagName).toBe("SPAN");
	});

	it("offers Sign in once the check says nobody is signed in", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

		await meAnswers(false);
		expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
		expect(screen.getByText(/^After signing in, you can ask/)).toBeVisible();
	});

	it("does not tell a signed-in reader to sign in on the success card either", async () => {
		verifyResult = "verified";
		renderAt("/verify-email?token=good");
		const status = await screen.findByText(/Your email address is confirmed/);
		expect(status).not.toHaveTextContent("Sign in to continue.");

		await meAnswers(true);
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You're all set."));
		expect(screen.getByRole("status")).not.toHaveTextContent("Sign in to continue.");
	});
});
