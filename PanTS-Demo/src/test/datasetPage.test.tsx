/**
 * Dataset page (/dashboard): the list on screen is named by the URL (Browse
 * all, filters, page, Saved, a shuffled strip), a slow answer never replaces a
 * newer one, the grid reveals as soon as its thumbnails load, and focus has
 * somewhere to go when the control that had it disappears. The search box and
 * the compare tray take a case number or an id copied from a card and say what
 * is wrong with anything else, and the filter options offer Retry when they
 * fail to load.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Homepage from "../routes/Homepage";
import CaseGrid from "../routes/Homepage/components/CaseGrid";
import { SAVED_CASES_KEY } from "../helpers/savedCases";
import { track } from "../helpers/analytics";
import { resetCancerVerseCountCache } from "../helpers/caseNumbering";

vi.mock("../helpers/prefetchViewer", () => ({ prefetchViewer: vi.fn() }));
vi.mock("../helpers/analytics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/analytics")>();
	return { ...actual, track: vi.fn() };
});
// The featured strip: two PanTS cases.
vi.mock("../helpers/curatedCache", () => ({
	getCachedCurated: () => null,
	fetchCurated: async () => [
		{ case_id: "PanTS_00000035", sex: "F", age: 55, tumor: 0 },
		{ case_id: "PanTS_00000036", sex: "M", age: 61, tumor: 1 },
	],
}));

const META = { sex: "F", age: 54, tumor: 1 as const };

// ── The grid on its own ──

// Fires every thumbnail's load event during the commit, before any passive
// effect runs, the way already-cached images can in a browser.
function LoadThumbnailsEarly() {
	useLayoutEffect(() => {
		document.querySelectorAll("img").forEach((img) => fireEvent.load(img));
	});
	return null;
}

const gridProps = {
	showSaved: false,
	savedCases: [],
	resultCount: null,
	savedIds: new Set<number>(),
	compareIds: [],
	onToggleSave: () => {},
	onToggleCompare: () => {},
};

describe("case grid", () => {
	it("reveals a batch as soon as every thumbnail has loaded", () => {
		vi.useFakeTimers();
		try {
			const { container } = render(
				<MemoryRouter>
					<CaseGrid
						{...gridProps}
						loading={false}
						previewIds={[1, 2, 3]}
						previewMetadata={{ 1: META, 2: META, 3: META }}
					/>
					<LoadThumbnailsEarly />
				</MemoryRouter>,
			);
			// No waiting on the 2.5 s safety cap: no card still shows its spinner.
			expect(container.querySelectorAll("article")).toHaveLength(3);
			expect(container.querySelectorAll("article [aria-hidden='true'] > span")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows as many skeletons as cards are coming", () => {
		const { container } = render(
			<MemoryRouter>
				<CaseGrid {...gridProps} loading skeletonCount={5} previewIds={[]} previewMetadata={{}} />
			</MemoryRouter>,
		);
		expect(container.querySelectorAll(".bm-card-skeleton")).toHaveLength(5);
	});

	it("moves focus to the next saved case, then to the empty message, when one is removed", async () => {
		const user = userEvent.setup();
		const saved = [
			{ id: 17, sex: "F", age: 54, tumor: 1 as const, savedAt: 1 },
			{ id: 18, sex: "M", age: 60, tumor: 0 as const, savedAt: 2 },
		];
		const Harness = () => {
			const [list, setList] = useState(saved);
			return (
				<CaseGrid
					{...gridProps}
					showSaved
					savedCases={list}
					loading={false}
					previewIds={[]}
					previewMetadata={{}}
					onToggleSave={(id) => setList((l) => l.filter((c) => c.id !== id))}
				/>
			);
		};
		render(
			<MemoryRouter>
				<Harness />
			</MemoryRouter>,
		);
		await user.click(screen.getByRole("button", { name: "Remove case 17 from saved" }));
		expect(screen.getByRole("button", { name: "Remove case 18 from saved" })).toHaveFocus();
		await user.click(screen.getByRole("button", { name: "Remove case 18 from saved" }));
		expect(screen.getByText(/^No saved cases yet\./)).toHaveFocus();
	});
});

// ── The whole page, with /api/search stubbed: 50 cases, 16 to a page ──

type Gate = { release: () => void; promise: Promise<void> };
let gates: Gate[];

const json = (body: unknown, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

const pageOf = (page: number) =>
	Array.from({ length: 16 }, (_, i) => ({ case_id: (page - 1) * 16 + i + 1, tumor: 1, sex: "F", age: 50 }));

beforeEach(() => {
	localStorage.clear();
	resetCancerVerseCountCache();
	vi.mocked(track).mockClear();
	gates = [];
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	global.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname.endsWith("/api/search")) {
			const page = Number(url.searchParams.get("page") ?? "1");
			const gate = gates.shift();
			if (gate) await gate.promise;
			return json({ items: pageOf(page), total: 50, page });
		}
		if (url.pathname.endsWith("/api/random")) {
			return json({ items: [{ case_id: "CV_00000012", sex: "M", age: 60, tumor: 1 }] });
		}
		if (url.pathname.endsWith("/api/facets")) {
			return json({
				facets: { year: [{ value: 2019, count: 9 }, { value: 2023, count: 5 }, { value: 2021, count: 2 }] },
				total: 50,
			});
		}
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const hold = () => {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const gate = { release, promise };
	gates.push(gate);
	return gate;
};

const searchUrls = () =>
	vi.mocked(global.fetch).mock.calls
		.map(([input]) => new URL(String(input), "http://localhost"))
		.filter((url) => url.pathname.endsWith("/api/search"));

function Where() {
	const { pathname, search } = useLocation();
	return <output data-testid="where">{pathname + search}</output>;
}

function CaseStub() {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate(-1)}>
			Back
		</button>
	);
}

const renderPage = (entry = "/dashboard") =>
	render(
		<MemoryRouter initialEntries={[entry]}>
			<Link to="/dashboard">Dataset link</Link>
			<Routes>
				<Route path="/dashboard" element={<Homepage />} />
				<Route path="/case/:caseId" element={<CaseStub />} />
			</Routes>
			<Where />
		</MemoryRouter>,
	);

const where = () => screen.getByTestId("where").textContent;

describe("dataset page position in the URL", () => {
	it("comes back to the same page of Browse all after opening a case", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(await screen.findByRole("button", { name: "Browse all" }));
		await screen.findByText(/Page 1 of 4/);
		expect(where()).toBe("/dashboard?browse=1");

		await user.click(screen.getByRole("button", { name: /Next/ }));
		await screen.findByText(/Page 2 of 4/);
		expect(where()).toBe("/dashboard?browse=1&page=2");

		await user.click(await screen.findByRole("link", { name: "Open case PanTS_00000017" }));
		await user.click(await screen.findByRole("button", { name: "Back" }));

		expect(await screen.findByText(/Page 2 of 4/)).toBeInTheDocument();
		expect(await screen.findByRole("link", { name: "Open case PanTS_00000017" })).toBeInTheDocument();
		expect(searchUrls().at(-1)?.searchParams.get("page")).toBe("2");
	});

	it("opens a filtered link at the page it names, and at page 1 without one", async () => {
		const { unmount } = renderPage("/dashboard?dataset=all&tumor=1&page=3");
		expect(await screen.findByText(/Page 3 of 4/)).toBeInTheDocument();
		expect(searchUrls().map((u) => u.searchParams.get("page"))).toEqual(["3"]);
		unmount();

		vi.mocked(global.fetch).mockClear();
		renderPage("/dashboard?dataset=all&tumor=1");
		expect(await screen.findByText(/Page 1 of 4/)).toBeInTheDocument();
		expect(searchUrls().map((u) => u.searchParams.get("page"))).toEqual(["1"]);
	});

	it("goes back to the featured cases when the Dataset link is followed from a deep page", async () => {
		const user = userEvent.setup();
		renderPage("/dashboard?browse=1&page=3");
		await screen.findByText(/Page 3 of 4/);
		await user.click(screen.getByRole("link", { name: "Dataset link" }));
		expect(await screen.findByRole("link", { name: "Open case PanTS_00000035" })).toBeInTheDocument();
		expect(where()).toBe("/dashboard");
		expect(screen.queryByText(/Page 3 of 4/)).not.toBeInTheDocument();
		expect(screen.getByText("Explore the library")).toBeInTheDocument();
	});

	it("rebuilds a shuffled strip on Back from one of its cases", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("link", { name: "Open case PanTS_00000035" });
		await user.click(screen.getByRole("button", { name: /Shuffle/ }));
		await user.click(await screen.findByRole("link", { name: "Open case CV_00000012" }));
		await user.click(await screen.findByRole("button", { name: "Back" }));
		expect(await screen.findByRole("link", { name: "Open case CV_00000012" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Open case PanTS_00000035" })).not.toBeInTheDocument();
		expect(vi.mocked(global.fetch).mock.calls.filter(([u]) => String(u).includes("/api/random"))).toHaveLength(1);
	});

	it("names the Saved view in the URL and puts the list back when it is left", async () => {
		const user = userEvent.setup();
		localStorage.setItem(SAVED_CASES_KEY, JSON.stringify([{ id: 99, sex: "F", age: 40, tumor: 0, savedAt: 1 }]));
		renderPage("/dashboard?browse=1&page=2");
		await screen.findByText(/Page 2 of 4/);
		await user.click(screen.getByRole("button", { name: /Saved/ }));
		expect(where()).toBe("/dashboard?saved=1");
		expect(screen.getByRole("link", { name: "Open case PanTS_00000099" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back to browse" }));
		expect(where()).toBe("/dashboard?browse=1&page=2");
		expect(await screen.findByText(/Page 2 of 4/)).toBeInTheDocument();
	});
});

describe("dataset page requests", () => {
	it("never lets a slow answer replace a newer list", async () => {
		const user = userEvent.setup();
		renderPage();
		await screen.findByRole("link", { name: "Open case PanTS_00000035" });
		const slow = hold();
		await user.click(screen.getByRole("button", { name: "Browse all" }));
		await user.click(screen.getByRole("button", { name: /Shuffle/ }));
		expect(await screen.findByRole("link", { name: "Open case CV_00000012" })).toBeInTheDocument();
		await act(async () => {
			slow.release();
			await slow.promise;
		});
		expect(screen.getByRole("link", { name: "Open case CV_00000012" })).toBeInTheDocument();
		expect(screen.queryByText(/Page 1 of 4/)).not.toBeInTheDocument();
		expect(where()).toBe("/dashboard");
	});

	it("pages the applied filters, not pills picked since", async () => {
		const user = userEvent.setup();
		renderPage("/dashboard?dataset=all&sex%5B%5D=M");
		await screen.findByText(/Page 1 of 4/);
		// The panel opens on a filtered link; pick Female without applying it.
		const panel = document.getElementById("dataset-filters") as HTMLElement;
		const sex = within(panel).getByText("Sex").parentElement as HTMLElement;
		await user.click(within(sex).getByRole("button", { name: /^Female/ }));
		await user.click(screen.getByRole("button", { name: /Next/ }));
		await screen.findByText(/Page 2 of 4/);
		expect(searchUrls().at(-1)?.searchParams.getAll("sex[]")).toEqual(["M"]);
	});

	it("asks for every facet value and lists years newest first", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: /Advanced filters/ }));
		const year = (await screen.findByText("Study Year", { selector: "span" })).parentElement as HTMLElement;
		await within(year).findByRole("button", { name: /^2023/ });
		const facets = vi.mocked(global.fetch).mock.calls
			.map(([u]) => new URL(String(u), "http://localhost"))
			.find((u) => u.pathname.endsWith("/api/facets"));
		expect(facets?.searchParams.get("top_k")).toBe("64");
		const labels = within(year).getAllByRole("button").map((b) => b.firstChild?.textContent);
		expect(labels).toEqual(["Any", "2023", "2021", "2019"]);
	});
});

describe("dataset page focus", () => {
	it("moves focus to the cases after paging and keeps the pager a named landmark", async () => {
		const user = userEvent.setup();
		renderPage("/dashboard?browse=1");
		await screen.findByText(/Page 1 of 4/);
		const pager = screen.getByRole("navigation", { name: "Pagination" });
		await user.click(within(pager).getByRole("button", { name: /Next/ }));
		expect(screen.getByRole("region", { name: "Cases" })).toHaveFocus();
		await screen.findByText(/Page 2 of 4/);
		expect(window.scrollTo).toHaveBeenCalled();
	});

	it("moves focus to the cases after Clear filters", async () => {
		const user = userEvent.setup();
		renderPage("/dashboard?dataset=all&tumor=1");
		await screen.findByText(/Page 1 of 4/);
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(screen.getByRole("region", { name: "Cases" })).toHaveFocus();
		await waitFor(() => expect(where()).toBe("/dashboard"));
	});
});

describe("dataset search box", () => {
	const searchFor = async (value: string) => {
		const user = userEvent.setup();
		const { unmount } = renderPage();
		const box = await screen.findByRole("textbox", { name: "Search by case number" });
		if (value) await user.type(box, value);
		await user.click(screen.getByRole("button", { name: "Search" }));
		return { user, box, unmount };
	};

	it("opens the case for an id pasted from a card, in any letter case", async () => {
		const { unmount } = await searchFor("PanTS_00000017");
		await waitFor(() => expect(where()).toBe("/case/17"));
		unmount();
		await searchFor("cv_00000001");
		await waitFor(() => expect(where()).toBe("/case/CV_00000001"));
	});

	it("reads a number written as a card prints it", async () => {
		await searchFor("#9,902");
		await waitFor(() => expect(where()).toBe("/case/CV_00000001"));
	});

	it("says what is wrong with anything else, from a region that was already there", async () => {
		const { unmount } = renderPage();
		const live = document.getElementById("dataset-search-error") as HTMLElement;
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toBeEmptyDOMElement();
		unmount();

		const { user, box } = await searchFor("12V");
		const message = document.getElementById("dataset-search-error") as HTMLElement;
		expect(message.textContent).toMatch(/^Enter a case number such as 17 or 9902/);
		expect(box).toHaveAttribute("aria-invalid", "true");
		expect(box).toHaveAttribute("aria-describedby", "dataset-search-error");
		expect(box).toHaveFocus();
		expect(where()).toBe("/dashboard");
		expect(track).not.toHaveBeenCalledWith("dataset_search");

		// The same message again is still a change, so it is read out again.
		const first = message.textContent;
		await user.click(screen.getByRole("button", { name: "Search" }));
		expect(message.textContent).not.toBe(first);
		expect(box).toHaveFocus();

		await user.type(box, "1");
		expect(message).toBeEmptyDOMElement();
		expect(box).not.toHaveAttribute("aria-invalid");
	});

	it("keeps PanTS ids to the PanTS range", async () => {
		await searchFor("PanTS_00012000");
		expect(document.getElementById("dataset-search-error")?.textContent).toBe(
			"PanTS IDs run from PanTS_00000001 to PanTS_00009901.",
		);
		expect(where()).toBe("/dashboard");
	});

	it("counts a search once whether it opens a case or applies the filters", async () => {
		const { user, box } = await searchFor("");
		await screen.findByText(/Page 1 of 4/);
		expect(vi.mocked(track).mock.calls.filter(([e]) => e === "dataset_search")).toHaveLength(1);
		await user.type(box, "17");
		await user.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => expect(where()).toBe("/case/17"));
		expect(vi.mocked(track).mock.calls.filter(([e]) => e === "dataset_search")).toHaveLength(2);
	});

	it("hides the filter button's icons and reads its count as a selection", async () => {
		const user = userEvent.setup();
		renderPage("/dashboard?dataset=all&tumor=1");
		await screen.findByText(/Page 1 of 4/);
		const toggle = screen.getByRole("button", { name: /Advanced filters/ });
		expect(toggle).toHaveAccessibleName("Advanced filters 1 selected");
		expect(toggle.querySelectorAll("svg:not([aria-hidden='true'])")).toHaveLength(0);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
	});
});

describe("dataset filter panel", () => {
	it("names each group by its title and reads a count as a number of cases", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: /Advanced filters/ }));
		const year = await screen.findByRole("group", { name: "Study Year" });
		expect(await within(year).findByRole("button", { name: "2023 (5 cases)" })).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Sex" })).toBeInTheDocument();
	});

	it("offers Retry when the options fail to load, instead of loading forever", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const answer = global.fetch;
		let failures = 1;
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/facets") && failures-- > 0) return json({ error: "boom" }, 500);
			return answer(input);
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: /Advanced filters/ }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't load options.");
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
		expect(screen.queryByText("—")).not.toBeInTheDocument();

		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		const year = screen.getByRole("group", { name: "Study Year" });
		expect(await within(year).findByRole("button", { name: /^2023/ })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load options.")).not.toBeInTheDocument();
		// Retry went away, so focus waits on the first pill.
		expect(within(screen.getByRole("group", { name: "Tumor" })).getAllByRole("button")[0]).toHaveFocus();
	});
});

describe("compare tray", () => {
	const pickFirst = async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(await screen.findByRole("button", { name: "Add case 35 to comparison" }));
		const tray = screen.getByRole("region", { name: "Compare cases" });
		return { user, tray, field: within(tray).getByRole("textbox", { name: "Add a case by number" }) };
	};

	it("adds a CancerVerse case by its number and moves on to Compare", async () => {
		const { user, tray, field } = await pickFirst();
		expect(screen.getByText("1 of 2 cases selected")).toBeInTheDocument();
		await user.type(field, "9,902");
		await user.click(within(tray).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(tray).toHaveTextContent("#35 vs #CV_00000001"));
		expect(within(tray).getByRole("button", { name: "Compare" })).toHaveFocus();
		expect(screen.getByText("2 cases selected, Compare is ready")).toBeInTheDocument();
	});

	it("adds a pasted id and says so when a case is already picked or the text is not a case", async () => {
		const { user, tray, field } = await pickFirst();
		await user.type(field, "PanTS_00000035");
		await user.click(within(tray).getByRole("button", { name: "Add" }));
		const message = document.getElementById("compare-tray-error") as HTMLElement;
		expect(message).toHaveTextContent("Case PanTS_00000035 is already selected.");
		expect(field).toHaveValue("PanTS_00000035");
		expect(field).toHaveAttribute("aria-invalid", "true");

		await user.clear(field);
		expect(message).toBeEmptyDOMElement();
		await user.type(field, "CV");
		await user.click(within(tray).getByRole("button", { name: "Add" }));
		expect(message.textContent).toMatch(/^Enter a case number such as 17 or 9902/);

		await user.clear(field);
		await user.type(field, "cv_00000007");
		await user.click(within(tray).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(tray).toHaveTextContent("#35 vs #CV_00000007"));
	});

	it("offers a shortcut to the tray and names Clear", async () => {
		const { user, tray, field } = await pickFirst();
		await user.click(screen.getByRole("button", { name: "Go to compare bar" }));
		expect(field).toHaveFocus();
		await user.click(within(tray).getByRole("button", { name: "Clear compare selection" }));
		expect(screen.queryByRole("region", { name: "Compare cases" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Go to compare bar" })).not.toBeInTheDocument();
	});
});
