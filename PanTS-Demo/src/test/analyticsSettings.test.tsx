/**
 * The admin usage dashboard (Settings > Analytics) against a stubbed API:
 * the wording of its counts, and that what it draws always matches the
 * filters it shows.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import AnalyticsSettings from "../routes/Settings/AnalyticsSettings";
import { dateInput, duration, lastDay, longDay, plural, serverTo } from "../routes/Settings/analytics/format";
import { parseServerTime } from "../helpers/resetTime";

const ADMIN = { id: "a1", email: "admin@example.com", name: "Admin", plan: "free", roles: ["admin"] };

const META = {
	plans: ["free", "pro"],
	account_types: ["student"],
	audiences: ["all", "signed_in", "anonymous"],
	action_names: ["upload_start_inference"],
	ai_referral_sources: ["chatgpt", "claude", "gemini", "perplexity"],
	routes: ["/upload"],
};

type Country = { country_code: string; country_name: string; sessions: number; people: number; events: number };

/** An overview with one visitor doing one thing, in the given countries. */
const overview = (countries: Country[] = [
	{ country_code: "US", country_name: "United States", sessions: 1, people: 1, events: 1 },
]) => ({
	range: { start: "2026-09-01T00:00:00", end: "2026-09-29T12:34:56.123456" },
	totals: { events: 1, people: 1, sessions: 1, signed_in_people: 0, time_ms: 1000 },
	previous: { events: 0, people: 0, sessions: 0 },
	top_actions: [{ name: "upload_start_inference", count: 1, people: 1 }],
	time_by_route: [{ route: "/upload", views: 1, total_ms: 1000, avg_ms: 1000, people: 1 }],
	by_plan: [], by_account_type: [], daily: [],
	by_country: countries,
	by_city: [],
	by_device: [], new_vs_returning: { new: 1, returning: 0 },
	by_weekday: [], by_hour: [],
});

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let answerOverview: (url: string) => Promise<Response>;

beforeEach(() => {
	answerOverview = async () => json(overview());
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const u = String(input);
			if (u.includes("/api/auth/me")) return json({ user: ADMIN });
			if (u.includes("/api/analytics/meta")) return json(META);
			if (u.includes("/api/analytics/overview")) return answerOverview(u);
			return json({});
		})
	);
});

afterEach(() => vi.unstubAllGlobals());

const renderDashboard = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AnalyticsSettings />
			</MemoryRouter>
		</AuthProvider>
	);

describe("usage dashboard counts", () => {
	it("pluralises a count by its number", () => {
		expect(plural(1, "visit", "visits")).toBe("1 visit");
		expect(plural(2, "visit", "visits")).toBe("2 visits");
		expect(plural(0, "person", "people")).toBe("0 people");
	});

	it("says one visit by one person on hover, not 1 visits by 1 people", async () => {
		renderDashboard();
		const country = (await screen.findByText("United States")).closest("li")!;
		expect(country).toHaveAttribute("title", "United States: 1 visit by 1 person");

		const route = screen.getByText("/upload").closest("li")!;
		expect(route.getAttribute("title")).toMatch(/across 1 visit by 1 person$/);

		for (const row of screen.getAllByText("Upload start inference")) {
			expect(row.closest("li")).toHaveAttribute("title", "upload_start_inference: 1 time by 1 person");
		}
	});
});

describe("visits from AI assistants", () => {
	it("lists every assistant, the ones that sent people first, and zero for the rest", async () => {
		answerOverview = async () => json({
			...overview(),
			ai_referrals: [{ source: "perplexity", visits: 2 }, { source: "chatgpt", visits: 5 }],
		});
		renderDashboard();
		const panel = (await screen.findByRole("heading", { name: "Visits from AI assistants" })).closest("section")!;
		const rows = [...panel.querySelectorAll("li")];
		expect(rows.map((li) => li.getAttribute("title"))).toEqual([
			"5 visits from ChatGPT",
			"2 visits from Perplexity",
			"No visits from Claude in this range",
			"No visits from Gemini in this range",
		]);
	});

	it("still draws the panel when an older server sends no referral data", async () => {
		renderDashboard();
		const panel = (await screen.findByRole("heading", { name: "Visits from AI assistants" })).closest("section")!;
		expect(panel.querySelectorAll("li")).toHaveLength(4);
	});
});

const country = (code: string, name: string): Country =>
	({ country_code: code, country_name: name, sessions: 3, people: 2, events: 5 });

describe("usage dashboard filters", () => {
	it("ignores an older request that answers after a newer one", async () => {
		const user = userEvent.setup();
		renderDashboard();
		await screen.findByText("United States");

		const pending: ((res: Response) => void)[] = [];
		answerOverview = () => new Promise((resolve) => pending.push(resolve));
		const plan = screen.getAllByRole("combobox")[0];
		await user.selectOptions(plan, "pro");
		await user.selectOptions(plan, "");
		expect(pending).toHaveLength(2);

		// The newer request (plan cleared) answers first, the older one last.
		await act(async () => pending[1](json(overview([country("FR", "France")]))));
		expect(await screen.findByText("France")).toBeInTheDocument();
		await act(async () => {
			pending[0](json(overview([country("DE", "Germany")])));
			await new Promise((r) => setTimeout(r, 20));
		});

		expect(screen.getByText("France")).toBeInTheDocument();
		expect(screen.queryByText("Germany")).toBeNull();
		expect(plan).toHaveValue("");
	});
});

describe("usage dashboard country filter", () => {
	it("can be set from the keyboard through the list beside the map", async () => {
		const asked: string[] = [];
		answerOverview = async (url) => {
			asked.push(url);
			return json(overview());
		};
		const user = userEvent.setup();
		renderDashboard();

		const pick = await screen.findByRole("button", { name: "United States" });
		expect(pick).toHaveAttribute("aria-pressed", "false");
		pick.focus();
		await user.keyboard("{Enter}");

		expect(await screen.findByRole("heading", { name: "Cities in United States" })).toBeInTheDocument();
		expect(asked.at(-1)).toContain("country=US");
		await user.click(screen.getByRole("button", { name: "Show the whole world" }));
		expect(await screen.findByRole("heading", { name: "Top countries" })).toBeInTheDocument();
	});
});

const overviewCalls = () =>
	vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/api/analytics/overview"));

describe("usage dashboard range", () => {
	it("names the span only when the server shortened a range past a year", async () => {
		// The server starts where it was asked to, unless the range is longer
		// than a year, when it starts a year before the end.
		answerOverview = async (url) => {
			const from = new URL(url, "http://x").searchParams.get("from") ?? "";
			const start = from < "2025-01-01" ? "2025-10-13T00:00:00" : `${from}T00:00:00`;
			return json({ ...overview(), range: { start, end: "2026-10-13T00:00:00" } });
		};
		renderDashboard();
		await screen.findByText("United States");
		expect(screen.queryByText(/at most a year/)).toBeNull();

		fireEvent.change(screen.getByLabelText("From"), { target: { value: "2020-01-01" } });
		const line = await screen.findByText(/at most a year/);
		expect(line).toHaveTextContent(`Showing ${longDay("2025-10-13")} to ${lastDay("2026-10-13T00:00:00")}.`);
	});

	it("catches a start date after the end date without asking the server", async () => {
		renderDashboard();
		await screen.findByText("United States");
		const asked = overviewCalls().length;
		const from = screen.getByLabelText("From");
		const to = screen.getByLabelText("To") as HTMLInputElement;

		fireEvent.change(from, { target: { value: "2099-01-01" } });
		expect(await screen.findByRole("alert")).toHaveTextContent("The start date is after the end date.");
		expect(from).toHaveAttribute("aria-invalid", "true");
		expect(from).toHaveAttribute("aria-describedby", "dash-range-note");
		expect(to).toHaveAttribute("aria-invalid", "true");
		await new Promise((r) => setTimeout(r, 20));
		expect(overviewCalls()).toHaveLength(asked);
		// The figures already on screen stay.
		expect(screen.getByText("United States")).toBeInTheDocument();

		// Clearing a date field is ignored rather than sent as an empty date.
		const before = to.value;
		fireEvent.change(to, { target: { value: "" } });
		expect(to.value).toBe(before);
	});
});

describe("usage dashboard failures", () => {
	it("says the session ended and offers sign-in on a 401", async () => {
		answerOverview = async () => new Response("{}", { status: 401 });
		renderDashboard();

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("Your session has ended. Sign in again.");
		expect(banner).not.toHaveTextContent("admin account");
		expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
	});

	it("keeps the admin-account message, with no retry, on a 403", async () => {
		answerOverview = async () => new Response("{}", { status: 403 });
		renderDashboard();

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("You need an admin account to see usage data.");
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
	});

	it("says a filter matched no locations instead of blaming the server", async () => {
		answerOverview = async (url) => json(overview(url.includes("plan=pro") ? [] : undefined));
		const user = userEvent.setup();
		renderDashboard();
		await screen.findByText("United States");
		expect(screen.queryByText(/for these filters/)).toBeNull();

		await user.selectOptions(screen.getAllByRole("combobox")[0], "pro");
		expect(await screen.findByText("No visitor locations recorded for these filters.")).toBeInTheDocument();
		expect(screen.queryByText(/GeoLite2/)).toBeNull();
	});
});

describe("usage dashboard focus", () => {
	it("hands focus to the Plan select when Clear filters is pressed from the keyboard only", async () => {
		const user = userEvent.setup();
		renderDashboard();
		await screen.findByText("United States");
		const plan = screen.getAllByRole("combobox")[0];

		await user.selectOptions(plan, "pro");
		await user.click(await screen.findByRole("button", { name: "Clear filters" }));
		expect(document.activeElement).not.toBe(plan);

		await user.selectOptions(plan, "pro");
		screen.getByRole("button", { name: "Clear filters" }).focus();
		await user.keyboard("{Enter}");
		expect(document.activeElement).toBe(plan);
	});
});

describe("usage dashboard dates", () => {
	afterEach(() => vi.useRealTimers());

	it("uses the viewer's own calendar and still sends the newest UTC day", () => {
		// 22:00 on 11 October in Los Angeles (the test zone) is already the 12th in UTC.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-12T05:00:00Z"));
		expect(dateInput(0)).toBe("2026-10-11");
		expect(dateInput(29)).toBe("2026-09-12");
		expect(serverTo("2026-09-12", "2026-10-11")).toBe("2026-10-12");
		expect(serverTo("2026-09-12", "2026-10-01")).toBe("2026-10-01");
	});

	it("reads the server's end-of-range midnight as the day before", () => {
		expect(lastDay("2026-10-13T00:00:00")).toBe(longDay("2026-10-12"));
		expect(lastDay("2026-10-12T15:04:05")).toBe(longDay("2026-10-12"));
	});

	it("reads server times without a zone as UTC", () => {
		expect(parseServerTime("2026-01-04T00:00:00").toISOString()).toBe("2026-01-04T00:00:00.000Z");
		expect(parseServerTime("2026-01-04T00:00:00+02:00").toISOString()).toBe("2026-01-03T22:00:00.000Z");
	});

	it("rounds durations before choosing the unit", () => {
		expect(duration(59_600)).toBe("1m 0s");
		expect(duration(9_940)).toBe("9.9s");
		expect(duration(9_960)).toBe("10s");
		expect(duration(3_725_000)).toBe("1h 2m");
	});
});
