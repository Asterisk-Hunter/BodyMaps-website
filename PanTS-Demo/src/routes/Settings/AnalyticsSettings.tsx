import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../contexts/authContext";
import BarList, { type Bar } from "./analytics/BarList";
import Donut from "./analytics/Donut";
import TimeBars from "./analytics/TimeBars";
import TrendLine from "./analytics/TrendLine";
import WorldMap from "./analytics/WorldMap";
import {
	DashboardDisabled, DashboardForbidden, DashboardSignedOut, fetchMeta, fetchOverview,
	type Audience, type Filters, type Meta, type Overview,
} from "./analytics/api";
import {
	count, dateInput, delta, duration, eventArea, eventLabel, lastDay, longDay, plural, serverTo, titleCase,
} from "./analytics/format";
import "./analytics/dashboard.css";

// Usage: who comes to BodyMaps, where from, and what they do once they're here.
//
// Admin-only, and the check is here as well as in the settings nav — hiding a
// link is not access control, and this URL is guessable. The server refuses too;
// this only decides what to draw.
//
// Every panel is drawn from a single /analytics/overview response so they can
// never disagree with each other mid-change.
//
// The order follows the shape of the question, which is also the order Wix's
// traffic overview uses: how many people (with last period beside it), when
// they came, where they were, what they were using — and only then the
// feature-level detail this dashboard already had. Someone opening this page
// wants the first four at a glance; the rest is what they came back for.

// The dates are worked out each time the page opens, not once at load: a tab
// left open past midnight would otherwise start the window on a stale day.
const BASE_FILTERS: Omit<Filters, "from" | "to"> = {
	plan: "",
	accountType: "",
	audience: "all",
	allTime: false,
	country: "",
};

const AUDIENCE_LABELS: Record<Audience, string> = {
	all: "Everyone",
	signed_in: "Signed in",
	anonymous: "Signed out",
};

const DEVICE_LABELS: Record<string, string> = {
	desktop: "Desktop",
	mobile: "Phone",
	tablet: "Tablet",
};

// How many of the quietest features to name. All of them would be the whole
// vocabulary listed twice, most of it at zero.
const LEAST_USED_SHOWN = 8;
// The country list beside the map. Past this the tail is one visit each, and
// the map is already showing that they exist.
const COUNTRIES_SHOWN = 12;

const AnalyticsSettings: React.FC = () => {
	const { user, promptAuth } = useAuth();
	const isAdmin = !!user?.roles.includes("admin");

	const [filters, setFilters] = useState<Filters>(() => ({
		...BASE_FILTERS, from: dateInput(29), to: dateInput(0),
	}));
	const [meta, setMeta] = useState<Meta | null>(null);
	const [data, setData] = useState<Overview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fatal, setFatal] = useState(false);
	const [signedOut, setSignedOut] = useState(false);
	const [loading, setLoading] = useState(true);
	// The filters the response in `data` was fetched for. `data` stays on screen
	// while the next request is out, so it can be about a different selection
	// than the one now in `filters`.
	const [loaded, setLoaded] = useState<Filters | null>(null);
	// Names seen so far, so the scope line can still name a country after a new
	// range or filter leaves it with no rows.
	const countryNames = useRef(new Map<string, string>());
	const citiesHeading = useRef<HTMLHeadingElement>(null);
	// Set when the list beside the map picked the country: its button is about
	// to be replaced by the city list, so focus is handed to the heading.
	const focusCities = useRef(false);
	const planSelect = useRef<HTMLSelectElement>(null);

	const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
		setFilters((f) => ({ ...f, [key]: value }));

	// Where focus goes when "Clear filters", "Try again" or "Show the whole
	// world" removes itself, so the next Tab continues from the filters rather
	// than the top of the page. Only for a press from the keyboard (a click with
	// no pointer behind it has detail 0): after a mouse click focus is left to
	// the browser, as before, so the Plan select's focus style does not light up.
	const backToFilters = (e: React.MouseEvent) => {
		if (e.detail === 0) planSelect.current?.focus();
	};

	// Filters change faster than the server answers (a date typed digit by
	// digit, a country clicked and then cleared). Only the newest request may
	// draw: an older one landing late would show figures, or an error, for a
	// selection the controls no longer have.
	const requestSeq = useRef(0);

	// A date typed by hand can pass the other one (the inputs' min and max only
	// limit the calendar popup). The server would refuse that range, and the
	// refusal would blank every panel, so it is caught here: no request goes out
	// and what is on screen stays until the dates agree again.
	const badRange = !filters.allTime && filters.from > filters.to;

	const load = useCallback(async () => {
		const id = ++requestSeq.current;
		if (badRange) {
			// Also drops a reply still out for the range before this one. A
			// failure already on screen stays: a date typo must not hide it.
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [m, o] = await Promise.all([fetchMeta(), fetchOverview({ ...filters, to: serverTo(filters.from, filters.to) })]);
			if (id !== requestSeq.current) return;
			setMeta(m);
			for (const c of o.by_country) countryNames.current.set(c.country_code, c.country_name);
			// A pick whose country never came back (an empty range) has no
			// heading to hand focus to, so a later change must not claim it.
			if (!o.by_country.some((c) => c.country_code === filters.country)) {
				focusCities.current = false;
			}
			setData(o);
			setLoaded(filters);
			setFatal(false);
			setSignedOut(false);
		} catch (e) {
			if (id !== requestSeq.current) return;
			// Switched off, or not yours: both are settled answers, so the page
			// says so once instead of offering a retry that will fail the same way.
			setFatal(e instanceof DashboardDisabled || e instanceof DashboardForbidden);
			setSignedOut(e instanceof DashboardSignedOut);
			focusCities.current = false;
			setError(e instanceof Error ? e.message : "Something went wrong.");
			setData(null);
		} finally {
			if (id === requestSeq.current) setLoading(false);
		}
	}, [filters, badRange]);

	useEffect(() => {
		if (isAdmin) load();
	}, [isAdmin, load]);

	// The country currently drilled into, if it's in the response. Read from the
	// data rather than kept in its own state, so the heading can never name a
	// country the figures below it aren't actually about. Only a response
	// fetched for this country counts: the one still on screen after a pick is
	// the world's, and has no cities in it.
	const selectedCountry = filters.country && loaded?.country === filters.country
		? data?.by_country.find((c) => c.country_code === filters.country)
		: undefined;
	const citiesOf = selectedCountry?.country_code;
	useEffect(() => {
		if (citiesOf && focusCities.current) {
			focusCities.current = false;
			citiesHeading.current?.focus();
		}
	}, [citiesOf]);

	// Signing in again from the session-ended banner swaps the user object but
	// not the admin flag or the filters, so the effect above would not run and
	// the banner would outlive the sign-in until someone pressed Try again.
	const lastUser = useRef(user);
	useEffect(() => {
		const changed = lastUser.current !== user;
		lastUser.current = user;
		if (changed && signedOut && isAdmin) load();
	}, [user, signedOut, isAdmin, load]);

	if (!isAdmin) {
		return (
			<div className="set-group">
				<h2 className="set-heading">Usage</h2>
				<p className="set-sub">You need an admin account to see this.</p>
			</div>
		);
	}

	const totals = data?.totals;
	const previous = data?.previous;

	const countryBars: Bar[] = (data?.by_country ?? [])
		.slice(0, COUNTRIES_SHOWN)
		.map((c) => ({
			id: c.country_code,
			label: c.country_name,
			value: c.sessions,
			note: plural(c.people, "person", "people"),
			title: `${c.country_name}: ${plural(c.sessions, "visit", "visits")} by ${plural(c.people, "person", "people")}`,
		}));

	const cityBars: Bar[] = (data?.by_city ?? []).map((c) => ({
		label: [c.city, c.region].filter(Boolean).join(", "),
		value: c.sessions,
		note: plural(c.people, "person", "people"),
	}));

	// Time is reported per route, and a route is how a feature is reached — so
	// this is "where the time goes", which is the question actually being asked.
	const timeBars: Bar[] = (data?.time_by_route ?? []).map((r) => ({
		label: r.route,
		value: r.total_ms,
		display: duration(r.total_ms),
		note: `${plural(r.views, "visit", "visits")} · ${duration(r.avg_ms)} avg`,
		title: `${r.route}: ${duration(r.total_ms)} across ${plural(r.views, "visit", "visits")} by ${plural(r.people, "person", "people")}`,
	}));

	const actionBars: Bar[] = (data?.top_actions ?? []).map((a) => ({
		label: eventLabel(a.name),
		value: a.count,
		note: `${titleCase(eventArea(a.name))} · ${plural(a.people, "person", "people")}`,
		title: `${a.name}: ${plural(a.count, "time", "times")} by ${plural(a.people, "person", "people")}`,
	}));

	// The least-used list has to be built against the full vocabulary, not
	// against the response: a feature nobody touched has no row in top_actions
	// at all, and those zeroes are the most interesting rows on the page.
	const counted = new Map((data?.top_actions ?? []).map((a) => [a.name, a]));
	const leastBars: Bar[] = data
		? (meta?.action_names ?? [])
			.map((name) => ({ name, hit: counted.get(name) }))
			.sort((a, b) => (a.hit?.count ?? 0) - (b.hit?.count ?? 0))
			.slice(0, LEAST_USED_SHOWN)
			.map(({ name, hit }) => ({
				label: eventLabel(name),
				value: hit?.count ?? 0,
				note: hit
					? `${titleCase(eventArea(name))} · ${plural(hit.people, "person", "people")}`
					: `${titleCase(eventArea(name))} · nobody`,
				title: hit
					? `${name}: ${plural(hit.count, "time", "times")} by ${plural(hit.people, "person", "people")}`
					: `${name}: not used once in this range`,
			}))
		: [];

	const planBars: Bar[] = (data?.by_plan ?? []).map((p) => ({
		label: titleCase(p.plan),
		value: p.events,
		note: plural(p.people, "person", "people"),
	}));

	const typeBars: Bar[] = (data?.by_account_type ?? []).map((t) => ({
		label: titleCase(t.account_type),
		value: t.events,
		note: plural(t.people, "person", "people"),
	}));

	const filtered = filters.plan || filters.accountType || filters.audience !== "all"
		|| filters.country;

	const scopeName = filters.country
		? countryNames.current.get(filters.country) ?? filters.country
		: "";
	// An empty map under a filter is not a server problem, so it gets its own
	// sentence instead of the map's note about the location database.
	const emptyFor = data && loaded && !data.by_country.length
		? loaded.country
			? "No visits from this country in this range."
			: loaded.plan || loaded.accountType || loaded.audience !== "all"
				? "No visitor locations recorded for these filters."
				: null
		: null;
	// The server shows at most a year (MAX_DAYS) and starts a longer range a
	// year before its end, so the From field would then name a day the figures
	// do not reach back to. Only then is the span it used spelled out.
	const capped = data && loaded && !loaded.allTime && data.range.start.slice(0, 10) !== loaded.from
		? loaded
		: null;
	// A range ending today goes out as the UTC day (see serverTo); when the
	// server ran to that day, its end is named as the viewer's own today, like
	// the To field.
	const rangeEnd = (end: string, asked: Filters) => {
		const sent = serverTo(asked.from, asked.to);
		return sent !== asked.to && lastDay(end) === longDay(sent) ? longDay(asked.to) : lastDay(end);
	};

	return (
		<div className="dash">
			<div className="set-group">
				<h2 className="set-heading">Usage</h2>
				<p className="set-sub">
					Who comes to BodyMaps, where from, and what they do once they're here.
					Visible to admins only.
				</p>
			</div>

			{/* Filters sit in one row above everything they affect. */}
			<div className="dash-filters">
				<label className="dash-field">
					<span className="dash-field-label">From</span>
					<input
						type="date" className="set-input dash-input"
						value={filters.from} max={filters.to} disabled={filters.allTime}
						aria-invalid={badRange || undefined}
						aria-describedby={badRange ? "dash-range-note" : undefined}
						onChange={(e) => e.target.value && set("from", e.target.value)}
					/>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">To</span>
					<input
						type="date" className="set-input dash-input"
						value={filters.to} min={filters.from} max={dateInput(0)}
						disabled={filters.allTime}
						aria-invalid={badRange || undefined}
						aria-describedby={badRange ? "dash-range-note" : undefined}
						onChange={(e) => e.target.value && set("to", e.target.value)}
					/>
				</label>
				<div className="dash-field">
					<span className="dash-field-label">Range</span>
					<div className="set-segmented dash-segmented" role="group" aria-label="Range">
						{([false, true] as const).map((all) => (
							<button
								key={String(all)}
								type="button"
								className={`set-segmented-btn${filters.allTime === all ? " set-segmented-btn--on" : ""}`}
								aria-pressed={filters.allTime === all}
								onClick={() => set("allTime", all)}
							>
								{all ? "All time" : "These dates"}
							</button>
						))}
					</div>
				</div>
				<label className="dash-field">
					<span className="dash-field-label">Plan</span>
					<select
						ref={planSelect}
						className="set-select dash-input" value={filters.plan}
						onChange={(e) => set("plan", e.target.value)}
					>
						<option value="">All plans</option>
						{(meta?.plans ?? []).map((p) => (
							<option key={p} value={p}>{titleCase(p)}</option>
						))}
					</select>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">Account type</span>
					<select
						className="set-select dash-input" value={filters.accountType}
						onChange={(e) => set("accountType", e.target.value)}
					>
						<option value="">All types</option>
						{(meta?.account_types ?? []).map((t) => (
							<option key={t} value={t}>{titleCase(t)}</option>
						))}
					</select>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">Audience</span>
					<select
						className="set-select dash-input" value={filters.audience}
						onChange={(e) => set("audience", e.target.value as Audience)}
					>
						{(meta?.audiences ?? (["all", "signed_in", "anonymous"] as Audience[])).map((a) => (
							<option key={a} value={a}>{AUDIENCE_LABELS[a] ?? a}</option>
						))}
					</select>
				</label>
				{filtered && (
					<button
						type="button" className="set-btn dash-reset"
						onClick={(e) => {
							setFilters((f) => ({
								...f, plan: "", accountType: "", audience: "all", country: "",
							}));
							backToFilters(e);
						}}
					>
						Clear filters
					</button>
				)}
			</div>

			{badRange && (
				<p id="dash-range-note" className="dash-range-note" role="alert">
					The start date is after the end date.
				</p>
			)}

			{error && (
				<div className="set-banner set-banner--error dash-banner" role="alert">
					{error}{" "}
					{!fatal && !badRange && (
						<button
							type="button" className="dash-retry"
							onClick={(e) => {
								// The retry clears this banner, button and all.
								backToFilters(e);
								load();
							}}
						>
							Try again
						</button>
					)}
					{!fatal && !badRange && signedOut && " "}
					{signedOut && (
						<button type="button" className="dash-retry" onClick={() => promptAuth()}>Sign in</button>
					)}
				</div>
			)}

			{loading && !data && !error && <p className="dash-empty">Loading…</p>}

			{data && (
				<>
					{capped && (
						<p className="dash-range">
							Showing {longDay(data.range.start)} to {rangeEnd(data.range.end, capped)}.
							The dashboard covers at most a year at a time.
						</p>
					)}

					{/* A country picked on the map filters everything below, so it
					    is said once here rather than repeated on every panel. It
					    stays while the country is picked, even when the new range
					    has no rows for it, so the pick can always be undone here. */}
					{filters.country && (
						<div className="dash-scope">
							Showing <strong>{scopeName}</strong> only.{" "}
							<button
								type="button" className="dash-retry"
								onClick={(e) => {
									focusCities.current = false;
									set("country", "");
									backToFilters(e);
								}}
							>
								Show the whole world
							</button>
						</div>
					)}

					<div className="dash-tiles">
						<Tile
							label="Visits"
							value={count(totals!.sessions)}
							change={delta(totals!.sessions, previous!.sessions)}
						/>
						<Tile
							label="People"
							value={count(totals!.people)}
							note={`${count(totals!.signed_in_people)} signed in`}
							change={delta(totals!.people, previous!.people)}
						/>
						<Tile
							label="Events"
							value={count(totals!.events)}
							change={delta(totals!.events, previous!.events)}
						/>
						<Tile label="Time in app" value={duration(totals!.time_ms)} />
					</div>

					<section className="dash-panel">
						<h2 className="set-heading">Activity</h2>
						<p className="set-sub">Events per day across the selected range.</p>
						<TrendLine points={data.daily} start={data.range.start} end={data.range.end} />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Where visitors are</h2>
						<p className="set-sub">
							Worked out from each visitor's IP address on our own server.
							Accurate to a city at best, and a VPN reports wherever it exits.
							Click a country to see only its traffic.
						</p>
						<div className="dash-map-row">
							{emptyFor ? (
								<p className="dash-empty">{emptyFor}</p>
							) : (
								<WorldMap
									rows={data.by_country}
									selected={filters.country}
									onSelect={(code) => {
										focusCities.current = false;
										set("country", code);
									}}
								/>
							)}
							<div className="dash-map-side">
								<h3 className="dash-subheading" ref={citiesHeading} tabIndex={-1}>
									{selectedCountry ? `Cities in ${selectedCountry.country_name}` : "Top countries"}
								</h3>
								<BarList
									bars={selectedCountry ? cityBars : countryBars}
									// The country list doubles as a keyboard way to pick
									// a country, alongside clicking the map.
									onSelect={
										selectedCountry
											? undefined
											: (code) => {
												focusCities.current = code !== filters.country;
												set("country", code === filters.country ? "" : code);
											}
									}
									selected={filters.country}
									empty={
										selectedCountry
											? "No city could be resolved for this country."
											: "No locations recorded in this range."
									}
								/>
							</div>
						</div>
					</section>

					<div className="dash-split">
						<section className="dash-panel">
							<h2 className="set-heading">Device</h2>
							<p className="set-sub">
								Counted per visit, from the browser's user agent.
							</p>
							<Donut
								slices={data.by_device.map((d) => ({
									label: DEVICE_LABELS[d.device_type] ?? titleCase(d.device_type),
									value: d.sessions,
								}))}
								empty="No device recorded in this range."
							/>
						</section>

						<section className="dash-panel">
							<h2 className="set-heading">New vs returning</h2>
							<p className="set-sub">
								"Returning" means this browser was seen here before the range
								began. Clearing the cookie counts that browser as new again.
							</p>
							<Donut
								slices={[
									{ label: "Returning", value: data.new_vs_returning.returning },
									{ label: "New", value: data.new_vs_returning.new },
								]}
								empty="Nobody visited in this range."
							/>
						</section>
					</div>

					<section className="dash-panel">
						<h2 className="set-heading">When people visit</h2>
						<p className="set-sub">Visits by day of the week, or by hour.</p>
						<TimeBars weekday={data.by_weekday} hour={data.by_hour} />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Most used features</h2>
						<p className="set-sub">
							Counted per event, with the number of distinct people beside it.
							One person clicking forty times is not forty people.
						</p>
						<BarList bars={actionBars} empty="No actions recorded in this range." />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Least used features</h2>
						<p className="set-sub">
							The quietest {LEAST_USED_SHOWN} tracked actions. "Nobody" means not
							once in this range. The feature may be hard to find or not needed.
						</p>
						<BarList bars={leastBars} empty="Nothing is tracked yet." />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Where the time goes</h2>
						<p className="set-sub">
							Total time on each route, counted only while the tab was in front.
						</p>
						<BarList bars={timeBars} empty="No page views recorded in this range." />
					</section>

					<div className="dash-split">
						<section className="dash-panel">
							<h2 className="set-heading">By plan</h2>
							<p className="set-sub">
								The plan each person was on when the event was recorded.
							</p>
							<BarList bars={planBars} />
						</section>

						<section className="dash-panel">
							<h2 className="set-heading">By account type</h2>
							<p className="set-sub">
								Based on what users provide. "Not set" means a user signed in but has not chosen an account type.
							</p>
							<BarList bars={typeBars} />
						</section>
					</div>
				</>
			)}
		</div>
	);
};

const Tile: React.FC<{
	label: string;
	value: string;
	note?: string;
	/** Against the previous period of the same length. Null when there is
	 *  nothing honest to say — see format.delta. */
	change?: ReturnType<typeof delta>;
}> = ({ label, value, note, change }) => (
	<div className="dash-tile">
		<span className="dash-tile-label">{label}</span>
		<span className="dash-tile-value">{value}</span>
		{change && (
			<span
				className={`dash-delta${change.up ? " dash-delta--up" : " dash-delta--down"}`}
				title="Compared with the previous period of the same length"
			>
				<span aria-hidden="true">{change.up ? "▲" : "▼"}</span> {change.label}
				<span className="dash-delta-sr"> compared with the previous period</span>
			</span>
		)}
		{note && <span className="dash-tile-note">{note}</span>}
	</div>
);

export default AnalyticsSettings;
