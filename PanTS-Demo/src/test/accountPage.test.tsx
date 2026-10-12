import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import { AuthProvider } from "../contexts/authContext";
import SettingsPage from "../routes/Settings";
import HistorySettings from "../routes/Settings/HistorySettings";
import PlanSettings from "../routes/Settings/PlanSettings";
import PrivacySettings from "../routes/Settings/PrivacySettings";
import ProfileSettings from "../routes/Settings/ProfileSettings";
import { recentUploadsStorageKey, type RecentUpload } from "../helpers/recentUploads";

// Settings against a stubbed API. Each section is its own URL now, so the tests
// navigate to one rather than scrolling one long page. Assertions are on the
// requests the server would actually receive — that's the contract that matters.

const USER = {
	id: "u1",
	email: "test.user@example.com",
	name: null as string | null,
	avatar_url: null as string | null,
	plan: "free",
	account_type: null as string | null,
	organization: null as string | null,
	occupation: null as string | null,
	role_description: null as string | null,
	email_verified: false,
	roles: [] as string[],
};

const USAGE = {
	plan: "free",
	limits: { daily_scans: 1, daily_ai_messages: 10 },
	scans: { used: 0, limit: 1, in_flight: 0, resets_at: null },
	ai_messages: { used: 0, limit: 10, resets_at: null },
};

let calls: { method: string; url: string; body?: unknown }[] = [];
// The server reports the *effective* plan (verified-researcher promotion);
// tests set this to model it, since USER.plan deliberately stays "free".
let USAGE_PLAN_OVERRIDE: string | null = null;

const json = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => "",
	blob: async () => new Blob([JSON.stringify(body)], { type: "application/json" }),
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	calls = [];
	localStorage.clear();
	USER.name = null;
	USER.avatar_url = null;
	USER.plan = "free";
	USER.account_type = null;
	USER.organization = null;
	USER.occupation = null;
	USER.role_description = null;
	USER.email_verified = false;
	USER.roles = [];
	USAGE_PLAN_OVERRIDE = null;
	USAGE.limits.daily_scans = 1;
	USAGE.scans.limit = 1;
	URL.createObjectURL = vi.fn(() => "blob:stub");
	URL.revokeObjectURL = vi.fn();

	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ method, url: u, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined });

        if (u.includes("/api/auth/avatar")) {
            const body = init?.body;
            const name = body instanceof FormData ? body.get("name") : JSON.parse(String(body ?? "{}" )).name;
            if (name != null) USER.name = String(name) || null;
            USER.avatar_url = method === "PUT" ? "/api/auth/avatar/u1/version1" : null;
            return json({ user: { ...USER } });
        }
		if (u.includes("/api/auth/send-verification")) {
			return json({ ok: true, already_verified: false, sent: true });
		}
		if (u.includes("/api/auth/me") && method === "PATCH") {
			const patch = JSON.parse(String(init?.body)) as {
				name?: string; account_type?: string;
				organization?: string; occupation?: string; role_description?: string;
			};
			if ("name" in patch) USER.name = patch.name || null;
			if ("account_type" in patch) USER.account_type = patch.account_type || null;
			if ("organization" in patch) USER.organization = patch.organization || null;
			if ("occupation" in patch) USER.occupation = patch.occupation || null;
			if ("role_description" in patch) USER.role_description = patch.role_description || null;
			return json({ user: { ...USER } });
		}
		if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
		if (u.includes("/api/me/plan")) {
			USER.plan = (JSON.parse(String(init?.body)) as { plan: string }).plan;
			return json({ user: { ...USER } });
		}
		if (u.includes("/api/me/usage")) {
			return json({ ...USAGE, plan: USAGE_PLAN_OVERRIDE ?? USER.plan });
		}
		if (u.includes("/api/me/export")) {
			return json({
				exported_at: "2026-08-29T00:00:00",
				account: { email: USER.email, name: USER.name, account_type: USER.account_type, plan: USER.plan, created_at: "2026-08-01T00:00:00" },
			});
		}
		if (u.includes("/api/me/jobs") && method === "DELETE") {
			return json({ deleted: { jobs: 3, files: 5 } });
		}
		if (u.endsWith("/api/me") && method === "DELETE") {
			return json({
				deletion_requested_at: "2026-08-02T00:00:00",
				restore_by: "2026-09-01T00:00:00",
				grace_days: 30,
			});
		}
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({ items: [], total: 0, ids: [] });
	}) as unknown as typeof fetch;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Renders the settings shell at one of its sections. */
const renderAt = (path = "/account", signedOutElement: ReactElement = <div>Landing</div>) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/account" element={<SettingsPage />}>
						<Route index element={<ProfileSettings />} />
						<Route path="plan" element={<PlanSettings />} />
						<Route path="history" element={<HistorySettings />} />
							<Route path="privacy" element={<PrivacySettings />} />
					</Route>
					<Route path="/" element={signedOutElement} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

const lastCall = (method: string, fragment: string) =>
	[...calls].reverse().find((c) => c.method === method && c.url.includes(fragment));

describe("navigation", () => {
	it("offers a section per URL", async () => {
		const user = userEvent.setup();
		renderAt();
		await screen.findByRole("heading", { name: "Profile" });

		for (const [link, heading] of [
			["Plan", "Usage"],
			["History", "History"],
			["Privacy", "Your data"],
		] as const) {
			await user.click(screen.getByRole("link", { name: link }));
			expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
		}
	});

	it("opens straight at a deep-linked section", async () => {
		renderAt("/account/privacy");
		expect(await screen.findByRole("heading", { name: "Your data" })).toBeInTheDocument();
	});
});

describe("display name", () => {
	it("shows the email-derived name as a placeholder, not a value to delete", async () => {
		renderAt();
		const field = await screen.findByLabelText("Name");
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute("placeholder", "Test User");
	});

	it("saves the staged name only after Save changes", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.type(await screen.findByLabelText("Name"), "Ada Lovelace");
		await user.tab();
		expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ name: "Ada Lovelace" })
		);
		expect(await screen.findByText(/Your profile has been updated/i)).toBeInTheDocument();
	});

	it("saves the role to the account rather than to this browser", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.selectOptions(await screen.findByLabelText(/Role/), "clinician");

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ account_type: "clinician" })
		);
		expect(await screen.findByText(/role is set to Clinician/i)).toBeInTheDocument();
	});

	it("clears the role with an empty value", async () => {
		const user = userEvent.setup();
		USER.account_type = "student";
		renderAt();

		await user.selectOptions(await screen.findByLabelText(/Role/), "");

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ account_type: "" })
		);
	});

	it("does not fire a request when the field is left unchanged", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.click(await screen.findByLabelText("Name"));
		await user.tab();

		expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
	});

	it("surfaces a save failure instead of silently doing nothing", async () => {
		const user = userEvent.setup();
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/auth/me") && init?.method === "PATCH") {
				return json({ error: "Name must be text" }, false, 400);
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			return json({});
		}) as unknown as typeof fetch;

		renderAt();
		await user.type(await screen.findByLabelText("Name"), "x");
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("Name must be text")).toBeInTheDocument();
	});

	it("keeps the notification switch on Profile rather than a page of its own", async () => {
		renderAt();
		expect(await screen.findByText("Email me when a scan finishes")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Notifications" })).not.toBeInTheDocument();
	});
});

describe("email verification", () => {
	it("offers to resend the link until the address is verified", async () => {
		const user = userEvent.setup();
		renderAt();
		await user.click(await screen.findByRole("button", { name: "Resend" }));
		await waitFor(() => expect(lastCall("POST", "/api/auth/send-verification")).toBeTruthy());
		expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument();
	});
});

describe("verified researcher profile", () => {
	it("saves each field on blur with the server's field names", async () => {
		const user = userEvent.setup();
		renderAt();

		const org = await screen.findByLabelText(/Organization/);
		await user.type(org, "Duke University");
		await user.tab();
		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ organization: "Duke University" })
		);
		expect(await screen.findByText("Your organization has been saved.")).toBeInTheDocument();

		const occ = screen.getByLabelText(/Occupation/);
		await user.type(occ, "Radiologist");
		await user.tab();
		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ occupation: "Radiologist" })
		);
	});

	it("explains what the profile unlocks", async () => {
		renderAt();
		expect(
			await screen.findByText(/complete profile unlocks 10 scans a day/)
		).toBeInTheDocument();
	});
});

describe("plan", () => {
	it("shows the current plan and what's been used of it", async () => {
		renderAt("/account/plan");
		expect(await screen.findByRole("heading", { name: "Free plan" })).toBeInTheDocument();
		expect(await screen.findByText("0 of 1")).toBeInTheDocument();
		expect(screen.getByText("0 of 10")).toBeInTheDocument();
	});

	it("splits the plans into Individual and Team like the reference sites", async () => {
		const user = userEvent.setup();
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });

		expect(screen.getByRole("heading", { name: "Free" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: "Team and Enterprise" }));
		expect(await screen.findByRole("heading", { name: "Team" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Enterprise" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Pro" })).not.toBeInTheDocument();
	});

	it("marks the plan you're on and won't let you re-pick it", async () => {
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });
		expect(screen.getByRole("button", { name: "Current plan" })).toBeDisabled();
	});

	it("locks Pro behind verification, and won't send anything", async () => {
		const user = userEvent.setup();
		renderAt("/account/plan");

		const cta = await screen.findByRole("button", { name: "Verify to unlock" });
		expect(cta).toBeDisabled();
		await user.click(cta);
		expect(lastCall("POST", "/api/me/plan")).toBeUndefined();
	});

	it("names the promoted tier once verification and the profile are done", async () => {
		USAGE_PLAN_OVERRIDE = "pro";
		USAGE.limits.daily_scans = 10;
		USAGE.scans.limit = 10;
		renderAt("/account/plan");

		expect(await screen.findByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: "Current plan" })).toBeInTheDocument();
	});

	it("upgrades through the server, not local state", async () => {
		USER.roles = ["admin"]; // the paid plans are closed to everyone else
		const user = userEvent.setup();
		renderAt("/account/plan");

		await user.click(await screen.findByRole("button", { name: "Choose Pro" }));

		await waitFor(() => expect(lastCall("POST", "/api/me/plan")?.body).toEqual({ plan: "pro" }));
		expect(await screen.findByText("You're on Pro.")).toBeInTheDocument();
	});

	it("shows Free as free and the future tiers without a price", async () => {
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });
		expect(screen.getByText("$0")).toBeInTheDocument();
		expect(screen.getByText("always free")).toBeInTheDocument();
		// The picker shows one group at a time; "individual" = Free + Pro. Pro
		// costs nothing - it is earned, not bought.
		expect(screen.getByText("verify email + complete profile")).toBeInTheDocument();
		// "$0" is real; no invented $x.xx prices anywhere.
		expect(screen.queryByText(/\$\d+\.\d{2}/)).toBeNull();
	});
});

describe("history", () => {
	const day = 24 * 60 * 60 * 1000;
	const entry = (over: Partial<RecentUpload>): RecentUpload => ({
		sessionId: "s", label: "ct.nii.gz", model: "LesionSegmenter",
		status: "Completed", timestamp: Date.now(), ...over,
	});

	it("lists only scans older than a day", async () => {
		localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
			entry({ sessionId: "new", label: "today.nii.gz", timestamp: Date.now() - 60_000 }),
			entry({ sessionId: "old", label: "lastweek.nii.gz", timestamp: Date.now() - 7 * day }),
		]));

		renderAt("/account/history");
		expect(await screen.findByText("lastweek.nii.gz")).toBeInTheDocument();
		expect(screen.queryByText("today.nii.gz")).not.toBeInTheDocument();
	});

	it("says so when there's nothing old enough yet", async () => {
		localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
			entry({ sessionId: "new", timestamp: Date.now() - 60_000 }),
		]));
		renderAt("/account/history");
		expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
	});
});

describe("export", () => {
	it("downloads the account details from the server rather than rebuilding them locally", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click(await screen.findByRole("button", { name: "Export" }));

		await waitFor(() => expect(lastCall("GET", "/api/me/export")).toBeTruthy());
		expect(URL.createObjectURL).toHaveBeenCalled();
		expect(await screen.findByText(/Your account details, including your saved profile picture, have been downloaded/i)).toBeInTheDocument();
	});
});

describe("delete scan history", () => {
	it("needs CLEAR typed, then reports how many scans went", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click(
			(await screen.findAllByRole("button", { name: "Delete" }))[0]
		);
		const confirm = screen.getByRole("button", { name: "Confirm" });
		expect(confirm).toBeDisabled();
		expect(lastCall("DELETE", "/api/me/jobs")).toBeUndefined();

		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(confirm);

		await waitFor(() => expect(lastCall("DELETE", "/api/me/jobs")).toBeTruthy());
		expect(await screen.findByText(/Removed 3 scans and their results/i)).toBeInTheDocument();
	});

	it("keeps you signed in", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click((await screen.findAllByRole("button", { name: "Delete" }))[0]);
		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me/jobs")).toBeTruthy());
		expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
	});
});

describe("delete account", () => {
	// The warning lives in the confirmation rather than on the page, so it has to
	// appear on the way through — not before, and not never.
	it("explains itself only once you start, and needs DELETE not CLEAR", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");
		await screen.findByRole("heading", { name: "Your data" });
		expect(screen.queryByText(/Sign back in before then/i)).not.toBeInTheDocument();

		await user.click(screen.getAllByRole("button", { name: "Delete" })[1]);
		expect(await screen.findByText(/Sign back in before then/i)).toBeInTheDocument();

		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "CLEAR");
		expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
	});

	it("calls the endpoint and leaves settings once confirmed", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click((await screen.findAllByRole("button", { name: "Delete" }))[1]);
		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "DELETE");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me")).toBeTruthy());
		expect(await screen.findByText("Landing")).toBeInTheDocument();
	});

	it("does not carry a deletion message onto the sign-in popup", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy", <AuthModal />);

		await user.click((await screen.findAllByRole("button", { name: "Delete" }))[1]);
		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "DELETE");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me")).toBeTruthy());
		expect(screen.queryByText(/scheduled for deletion/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Sign back in before/i)).not.toBeInTheDocument();
	});
});

describe("success notices", () => {
	// Clearing scan history is the fixture: the one Privacy action that ends in
	// a success notice without signing you out.
	const clearHistory = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click((await screen.findAllByRole("button", { name: "Delete" }))[0]);
		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(screen.getByRole("button", { name: "Confirm" }));
	};

	it("clear themselves instead of staying pinned to the page", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderAt("/account/privacy");

		await clearHistory(user);
		expect(await screen.findByText(/Removed 3 scans and their results/i)).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(6500);
		await waitFor(() =>
			expect(screen.queryByText(/Removed 3 scans and their results/i)).not.toBeInTheDocument()
		);
		vi.useRealTimers();
	});

	it("leaves errors up, since those still need acting on", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/me/jobs") && (init?.method ?? "GET") === "DELETE") {
				return json({ error: "Storage is offline" }, false, 503);
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			return json({});
		}) as unknown as typeof fetch;

		renderAt("/account/privacy");
		await clearHistory(user);
		expect(await screen.findByText(/Storage is offline/i)).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(10000);
		expect(screen.getByText(/Storage is offline/i)).toBeInTheDocument();
		vi.useRealTimers();
	});
});


describe("account-synced profile pictures", () => {
    it("advertises and enforces the deployment upload cap before staging a picture", async () => {
        vi.stubEnv("VITE_AVATAR_MAX_BYTES", "921600");
        const user = userEvent.setup();
        renderAt();
        await screen.findByLabelText("Name");
        expect(screen.getByText(/PNG, JPG or WebP, up to 900 KB/)).toBeInTheDocument();
        await user.upload(screen.getByLabelText("Choose profile picture"), new File([new Uint8Array(921601)], "large.png", { type: "image/png" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Choose an image up to 900 KB.");
        expect(screen.queryByAltText("Profile picture preview")).not.toBeInTheDocument();
        expect(lastCall("PUT", "/api/auth/avatar")).toBeUndefined();
        await user.upload(screen.getByLabelText("Choose profile picture"), new File([new Uint8Array(921600)], "fits.png", { type: "image/png" }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await screen.findByText("Your profile has been updated.");
        expect(lastCall("PUT", "/api/auth/avatar")).toBeDefined();
    });

    it("explains an HTML proxy size refusal without losing the staged picture", async () => {
        const user = userEvent.setup();
        const originalFetch = global.fetch;
        global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).includes("/api/auth/avatar")) return new Response("<html>413 Request Entity Too Large</html>", { status: 413 });
            return originalFetch(url, init);
        }) as typeof fetch;
        renderAt();
        await screen.findByLabelText("Name");
        await user.upload(screen.getByLabelText("Choose profile picture"), new File(["image"], "portrait.png", { type: "image/png" }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Choose a smaller image and try again.");
        expect(screen.getByAltText("Profile picture preview")).toHaveAttribute("src", "blob:stub");
    });

    it("stages the picture and name, then saves both in one authenticated multipart request", async () => {
        const user = userEvent.setup();
        renderAt();
        await screen.findByLabelText("Name");
        const picture = new File(["image"], "portrait.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Choose profile picture"), picture);
        await user.type(screen.getByLabelText("Name"), "Ada");
        expect(lastCall("PUT", "/api/auth/avatar")).toBeUndefined();
        expect(screen.getByAltText("Profile picture preview")).toHaveAttribute("src", "blob:stub");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await screen.findByText("Your profile has been updated.");
        const sent = lastCall("PUT", "/api/auth/avatar")?.body as FormData;
        expect(sent.get("avatar")).toBe(picture);
        expect(sent.get("name")).toBe("Ada");
        expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
        const request = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).includes("/api/auth/avatar") && init?.method === "PUT")?.[1];
        expect(request?.credentials).toBe("include");
        expect(request?.headers).toBeUndefined();
        expect(screen.getByAltText("Profile picture preview")).toHaveAttribute("src", "/api/auth/avatar/u1/version1");
    });

    it("discards an unsaved image and name without changing the account", async () => {
        const user = userEvent.setup();
        USER.name = "Original";
        renderAt();
        await screen.findByLabelText("Name");
        await user.upload(screen.getByLabelText("Choose profile picture"), new File(["image"], "portrait.png", { type: "image/png" }));
        await user.type(screen.getByLabelText("Name"), " Edited");
        await user.click(screen.getByRole("button", { name: "Discard" }));
        expect(screen.getByLabelText("Name")).toHaveValue("Original");
        expect(screen.queryByAltText("Profile picture preview")).not.toBeInTheDocument();
        expect(lastCall("PUT", "/api/auth/avatar")).toBeUndefined();
        expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    });

    it("removes the saved picture only when the change is confirmed", async () => {
        const user = userEvent.setup();
        USER.avatar_url = "/api/auth/avatar/u1/original";
        renderAt();
        await user.click(await screen.findByRole("button", { name: "Remove" }));
        expect(lastCall("DELETE", "/api/auth/avatar")).toBeUndefined();
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(lastCall("DELETE", "/api/auth/avatar")?.body).toEqual({ name: "" }));
        expect(screen.queryByAltText("Profile picture preview")).not.toBeInTheDocument();
    });

    it("rejects unsupported images before uploading", async () => {
        const user = userEvent.setup({ applyAccept: false });
        renderAt();
        await screen.findByLabelText("Name");
        await user.upload(screen.getByLabelText("Choose profile picture"), new File(["<svg/>"], "picture.svg", { type: "image/svg+xml" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PNG, JPG or WebP image.");
        expect(lastCall("PUT", "/api/auth/avatar")).toBeUndefined();
    });

    it("keeps the pending picture and name after a server refusal", async () => {
        const user = userEvent.setup();
        const originalFetch = global.fetch;
        global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).includes("/api/auth/avatar")) return json({ error: "Image is too large" }, false, 413);
            return originalFetch(url, init);
        }) as typeof fetch;
        renderAt();
        await screen.findByLabelText("Name");
        await user.upload(screen.getByLabelText("Choose profile picture"), new File(["image"], "portrait.png", { type: "image/png" }));
        await user.type(screen.getByLabelText("Name"), "Ada");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Image is too large");
        expect(screen.getByLabelText("Name")).toHaveValue("Ada");
        expect(screen.getByAltText("Profile picture preview")).toHaveAttribute("src", "blob:stub");
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
        expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
    });
});
