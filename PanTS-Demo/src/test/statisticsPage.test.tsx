/**
 * Statistics page (/statistics): it asks /api/stats for the library's own filters, draws the answer with
 * the number of scans each chart rests on, and every bar, column, country and dataset chip is a filter
 * that rewrites the URL. A slow older answer never replaces a newer one; a failed refresh keeps the last
 * numbers and offers Retry; an empty selection says so.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatisticsPage from "../routes/Statistics";
import type { StatsResponse, Split } from "../routes/Statistics/statsApi";

// The world outline is fetched on demand; the page does not need it here.
vi.mock("world-atlas/countries-110m.json", () => ({ default: { type: "Topology", objects: { countries: { type: "GeometryCollection", geometries: [] } }, arcs: [], transform: { scale: [1, 1], translate: [0, 0] } } }));

const split = (a: number, b: number, c: number): Split => ({ PanTS: a, CancerVerse: b, AbdomenAtlas: c });
const sum = (s: Split) => s.PanTS + s.CancerVerse + s.AbdomenAtlas;
const row = (key: string, label: string, s: Split) => ({ key, label, count: sum(s), datasets: s });
const coverage = (recorded: number, total: number) => ({ recorded, total, not_reported: total - recorded, share: total ? recorded / total : null });
const numbers = { median: 66, q1: 56, q3: 75, mean: 64.9, min: 0, max: 98 };

function fixture(total = 1000, over: Partial<StatsResponse> = {}): StatsResponse {
	return {
		schema: "stats-v1",
		total,
		datasets: [
			{ key: "PanTS", count: Math.round(total * 0.4) },
			{ key: "CancerVerse", count: Math.round(total * 0.4) },
			{ key: "AbdomenAtlas", count: total - 2 * Math.round(total * 0.4) },
		],
		tumor: {
			...coverage(900, total),
			with_tumor: split(100, 300, 60),
			without_tumor: split(300, 100, 40),
			unknown: split(0, 100, 0),
			types: [row("liver", "Liver", split(50, 200, 40)), row("pancreas", "Pancreas", split(100, 40, 10))],
		},
		phase: { ...coverage(718, total), rows: [row("Non-contrast", "Non-contrast", split(100, 50, 20)), row("Venous", "Venous", split(150, 250, 40)), row("Arterial", "Arterial", split(60, 40, 8))] },
		sex: { ...coverage(594, total), rows: [row("M", "Male", split(100, 200, 30)), row("F", "Female", split(100, 150, 14))], ratio: { male_percent: 55.6, female_percent: 44.4 } },
		age: {
			...coverage(500, total),
			...numbers,
			bin_width: 5,
			under_15: 3,
			implausible: 0,
			bins: [
				{ lo: 55, hi: 59, label: "55–59", count: 90, datasets: split(40, 40, 10) },
				{ lo: 60, hi: 64, label: "60–64", count: 120, datasets: split(50, 60, 10) },
				{ lo: 65, hi: 69, label: "65–69", count: 100, datasets: split(30, 60, 10) },
			],
		},
		manufacturer: { ...coverage(180, total), rows: [row("Siemens", "Siemens", split(120, 30, 10)), row("__other__", "Other", split(10, 5, 5))] },
		model: { ...coverage(100, total), rows: [row("Biograph128", "Biograph128", split(60, 0, 0))] },
		year: { ...coverage(230, total), range_only: 12, rows: [{ year: 2019, count: 80, datasets: split(0, 80, 0) }, { year: 2020, count: 150, datasets: split(0, 150, 0) }] },
		country: { ...coverage(210, total), rows: [row("US", "United States", split(120, 0, 0)), row("DE", "Germany", split(90, 0, 0))] },
		slice_thickness: { ...coverage(total, total), ...numbers, median: 1.5, rows: [row("≤ 1 mm", "≤ 1 mm", split(100, 200, 0))] },
		coverage: { ...coverage(total, total), ...numbers, median: 41, rows: [row("40–50 cm", "40–50 cm", split(100, 100, 10))] },
		completeness: [
			{ field: "sex", datasets: { PanTS: { recorded: 200, total: 400, share: 0.5 }, CancerVerse: { recorded: 350, total: 400, share: 0.875 }, AbdomenAtlas: { recorded: 44, total: 200, share: 0.22 } } },
			{ field: "country", datasets: { PanTS: { recorded: 210, total: 400, share: 0.525 }, CancerVerse: { recorded: 0, total: 400, share: 0 }, AbdomenAtlas: { recorded: 0, total: 200, share: 0 } } },
		],
		...over,
	};
}

const requests: string[] = [];
let responder: (url: string, signal?: AbortSignal | null) => Promise<Response>;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function Where() {
	const location = useLocation();
	return <output data-testid="where">{decodeURIComponent(location.pathname + location.search)}</output>;
}

const renderPage = (url = "/statistics") =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<Routes>
				<Route path="/statistics" element={<StatisticsPage />} />
				<Route path="/dashboard" element={<p>library page</p>} />
			</Routes>
			<Where />
		</MemoryRouter>,
	);

beforeEach(() => {
	requests.length = 0;
	responder = () => json(fixture());
	vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push(decodeURIComponent(url));
		return responder(url, init?.signal);
	}));
});
afterEach(() => vi.unstubAllGlobals());

describe("Statistics page", () => {
	it("shows a loading state, then every chart with the scans it is drawn from", async () => {
		renderPage();
		expect(screen.getByRole("status", { name: "Loading statistics" })).toBeInTheDocument();
		expect(await screen.findByRole("heading", { level: 2, name: "Contrast phase" })).toBeInTheDocument();

		expect(screen.getByText("Recorded for 718 of 1,000 scans (71.8%).")).toBeInTheDocument();       // phase
		expect(screen.getByText("Recorded for 594 of 1,000 scans (59.4%).")).toBeInTheDocument();       // sex
		expect(screen.getByText("Recorded for 180 of 1,000 scans (18.0%).")).toBeInTheDocument();       // scanner make
		for (const title of ["Sex", "Age at scan", "Scanner make", "Most-used scanner models", "Tumor", "Acquisition year", "Sites and countries", "Image geometry", "What each dataset records"]) {
			expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
		}
		expect(screen.getByText("1,000")).toBeInTheDocument();                                           // KPI
		expect(screen.getByText("IQR 56–75")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "View 1,000 scans in the library" })).toHaveAttribute("href", "/dashboard?browse=1");
		expect(requests).toEqual(["/api/stats?dataset=all"]);
	});

	it("says which datasets a chart is really drawn from", async () => {
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		expect(screen.getByText("Recorded by PanTS only.", { selector: "p" })).toBeInTheDocument();       // country (completeness)
		expect(screen.getByText(/12 scans give only a range of years/)).toBeInTheDocument();
		const grid = screen.getByRole("table");
		expect(within(grid).getByText("52.5%")).toBeInTheDocument();
		expect(within(grid).getAllByText("0.0%").length).toBeGreaterThan(0);
	});

	it("a bar is a filter: it rewrites the URL, asks again, and shows a chip that removes it", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		responder = () => json(fixture(440));
		await user.click(screen.getByRole("button", { name: /^Venous: 440 scans\. Filter to this$/ }));

		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/statistics?ct_phase[]=Venous"));
		expect(requests.at(-1)).toBe("/api/stats?dataset=all&ct_phase[]=Venous");
		expect(await screen.findByRole("link", { name: "View 440 scans in the library" })).toHaveAttribute("href", "/dashboard?ct_phase%5B%5D=Venous");
		const chip = screen.getByRole("button", { name: "Remove filter Phase: Venous" });
		responder = () => json(fixture());
		await user.click(chip);
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/statistics$/));
		expect(screen.queryByRole("button", { name: /Remove filter/ })).toBeNull();
	});

	it("columns, countries' rows, sex and tumor controls filter the way the library does", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });

		await user.click(screen.getByRole("button", { name: /^Age 60–64: 120 scans$/ }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("age_bin[]=60-69"));
		await user.click(screen.getByRole("button", { name: /^Female: 264 scans\./ }));
		await user.click(screen.getByRole("button", { name: /^460 with a tumor$/ }));
		await user.click(screen.getByRole("button", { name: /^Liver: 290 scans with a tumor\./ }));
		await user.click(screen.getByRole("button", { name: /^United States: 120 scans\./ }));
		await user.click(screen.getByRole("button", { name: /^Siemens: 160 scans\./ }));
		await user.click(screen.getByRole("button", { name: /^2020: 150 scans$/ }));

		const where = screen.getByTestId("where").textContent ?? "";
		for (const part of ["age_bin[]=60-69", "sex[]=F", "tumor=1", "tumor_type[]=liver", "site_nat[]=US", "manufacturer[]=Siemens", "year[]=2020"]) {
			expect(where).toContain(part);
		}
		// the "Other" tail of the scanner list is not a filter
		expect(screen.queryByRole("button", { name: /^Other:/ })).toBeNull();
	});

	it("narrowing to a dataset says that the library lists every dataset", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		await user.click(screen.getByRole("button", { name: /^PanTS/ }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/statistics?dataset=pants"));
		expect(requests.at(-1)).toBe("/api/stats?dataset=pants");
		expect(screen.getByText(/Showing PanTS only\./)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^PanTS/ }));                                   // the same chip again: back to all
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/statistics$/));
	});

	it("opens on the statistics of a library search, named by the URL", async () => {
		renderPage("/statistics?sex[]=F&ct_phase[]=Venous&tumor=1");
		expect(await screen.findByRole("button", { name: "Remove filter Sex: Female" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove filter Phase: Venous" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove filter Tumor: With tumor" })).toBeInTheDocument();
		expect(requests[0]).toBe("/api/stats?dataset=all&sex[]=F&tumor=1&ct_phase[]=Venous");
		const clear = screen.getByRole("button", { name: "Clear filters" });
		await userEvent.click(clear);
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/statistics$/));
	});

	it("a slow older answer never replaces a newer one", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		let releaseSlow!: (r: Response) => void;
		responder = (url) => (url.includes("sex") ? Promise.resolve(new Response(JSON.stringify(fixture(321)))) : new Promise<Response>((resolve) => { releaseSlow = resolve; }));
		await user.click(screen.getByRole("button", { name: /^Venous: 440 scans\./ }));          // slow request: the venous list
		await waitFor(() => expect(requests.at(-1)).toContain("ct_phase"));
		await user.click(screen.getByRole("button", { name: /^Female: 264 scans\./ }));           // newer request answers first
		await screen.findByRole("link", { name: "View 321 scans in the library" });
		releaseSlow(new Response(JSON.stringify(fixture(555))));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByRole("link", { name: "View 321 scans in the library" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /555/ })).toBeNull();
	});

	it("a failed first load says so and Try again loads it", async () => {
		const user = userEvent.setup();
		responder = () => json({ error: "down" }, 500);
		renderPage();
		expect(await screen.findByRole("alert")).toHaveTextContent("The statistics could not be loaded.");
		responder = () => json(fixture());
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("heading", { level: 2, name: "Contrast phase" })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("a failed refresh keeps the last numbers on screen and offers Try again", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		responder = () => Promise.reject(new TypeError("network"));
		await user.click(screen.getByRole("button", { name: /^Venous: 440 scans\./ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("these are the previous numbers");
		expect(screen.getByRole("heading", { level: 2, name: "Contrast phase" })).toBeInTheDocument();
	});

	it("an answer in an unexpected shape is an error, not a blank page", async () => {
		responder = () => json({ hello: "world" });
		renderPage();
		expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
	});

	it("an empty selection says so and offers the way back", async () => {
		const user = userEvent.setup();
		responder = () => json(fixture(0));
		renderPage("/statistics?year[]=1999");
		expect(await screen.findByRole("heading", { level: 2, name: "No scans match these filters" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { level: 2, name: "Contrast phase" })).toBeNull();
		const emptyCard = screen.getByRole("heading", { level: 2, name: "No scans match these filters" }).closest("section")!;
		await user.click(within(emptyCard).getByRole("button", { name: "Clear filters" }));
		await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/statistics$/));
	});

	it("the numbers are counts only: no case id appears anywhere on the page", async () => {
		renderPage();
		await screen.findByRole("heading", { level: 2, name: "Contrast phase" });
		expect(document.body.textContent).not.toMatch(/(PanTS|CV|BDMAP)_\d{8}/);
	});
});
