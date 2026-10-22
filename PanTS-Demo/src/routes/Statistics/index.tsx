import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { HistBin } from "./Histogram";
import Histogram from "./Histogram";
import StackedBars from "./StackedBars";
import CountryMap from "./CountryMap";
import Completeness from "./Completeness";
import {
	DATASET_KEYS,
	PHASE_FILTER_VALUE,
	activeChips,
	decadeBin,
	fetchStats,
	isFiltered,
	libraryHref,
	readQuery,
	setTumor,
	toggleDataset,
	toggleFilter,
	writeQuery,
	EMPTY_QUERY,
	type DatasetKey,
	type StatsQuery,
	type StatsResponse,
} from "./statsApi";
import {
	DATASET_COLORS,
	DATASET_LABELS,
	coverageText,
	count,
	number1,
	percent,
	sumSplit,
} from "./statsFormat";
import styles from "./Statistics.module.css";

// Statistics across PanTS, CancerVerse and AbdomenAtlas, for whatever the visitor is looking at.
//
// The URL is the state: it holds the library's own filters (plus an optional dataset), the page asks
// /api/stats for exactly that, and every bar, column, country and dataset chip on the page is a filter
// that rewrites the URL. So a link from the library opens the statistics of that search, a click here
// narrows every chart at once, and "View in the library" returns to the same scans.

const AGE_STEP = 5;
const YEAR_TICK_EVERY = 5;

type Phase = "loading" | "ready" | "error";

export default function StatisticsPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const key = searchParams.toString();
	const query = useMemo(() => readQuery(new URLSearchParams(key)), [key]);
	// The last good answer stays on screen while a newer one loads or fails.
	const [data, setData] = useState<StatsResponse | null>(null);
	// Which request (query + retry count) has finished, and how. Loading and error are read off this,
	// so no state is set synchronously inside the effect.
	const [attempt, setAttempt] = useState(0);
	const [settled, setSettled] = useState<{ key: string; attempt: number; ok: boolean } | null>(null);
	const current = settled !== null && settled.key === key && settled.attempt === attempt;
	const phase: Phase = !current ? "loading" : settled.ok ? "ready" : "error";

	useEffect(() => {
		const controller = new AbortController();
		fetchStats(readQuery(new URLSearchParams(key)), controller.signal)
			.then((body) => {
				// A slow older answer must never replace a newer one, even when it finished reading
				// just before this effect was cleaned up.
				if (controller.signal.aborted) return;
				setData(body);
				setSettled({ key, attempt, ok: true });
			})
			.catch(() => {
				if (!controller.signal.aborted) setSettled({ key, attempt, ok: false });
			});
		return () => controller.abort();
	}, [key, attempt]);

	const apply = (next: StatsQuery) => setSearchParams(writeQuery(next));
	const clearAll = () => apply(EMPTY_QUERY);

	const labelFor = (group: string, value: string): string => {
		const rows =
			group === "tumorType" ? data?.tumor.types : group === "siteNat" ? data?.country.rows : null;
		const found = rows?.find((row) => row.key.toLowerCase() === value.toLowerCase());
		return found?.label ?? value;
	};
	const chips = activeChips(query, labelFor);
	const filtered = isFiltered(query);

	return (
		<div className={styles.page}>
			<main className={styles.main} aria-labelledby="stats-title" aria-busy={phase === "loading"}>
				<header className={styles.hero}>
					<span className={styles.eyebrow}>Explore</span>
					<h1 id="stats-title">Statistics</h1>
					<p>
						What is in the library, across three datasets. Select any bar, column, country or dataset to
						narrow every chart.
					</p>
				</header>

				<div className={styles.toolbar}>
					<div className={styles.legend} role="group" aria-label="Datasets">
						{DATASET_KEYS.map((dataset) => (
							<DatasetChip
								key={dataset}
								dataset={dataset}
								count={data?.datasets.find((d) => d.key === dataset)?.count ?? null}
								total={data?.total ?? null}
								on={query.dataset === dataset}
								onClick={() => apply(toggleDataset(query, dataset))}
							/>
						))}
					</div>
					<div className={styles.actions}>
						<Link to={libraryHref(query)} className={styles.primaryLink}>
							{data ? `View ${count(data.total)} ${data.total === 1 ? "scan" : "scans"} in the library` : "View in the library"}
						</Link>
						{filtered && (
							<button type="button" className={styles.ghostButton} onClick={clearAll}>
								Clear filters
							</button>
						)}
					</div>
				</div>

				{chips.length > 0 && (
					<ul className={styles.chips} aria-label="Active filters">
						{chips.map((chip) => (
							<li key={chip.id}>
								<button
									type="button"
									className={styles.chip}
									onClick={() => apply(chip.remove(query))}
									aria-label={`Remove filter ${chip.group}: ${chip.text}`}
								>
									<span className={styles.chipGroup}>{chip.group}</span>
									{chip.text}
									<span aria-hidden="true" className={styles.chipX}>
										×
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{query.dataset && (
					<p className={styles.note}>
						Showing {query.dataset} only. The library lists every dataset, so its count can be higher.
					</p>
				)}

				{phase === "error" && (
					<p className={styles.error} role="alert">
						{data ? "The statistics could not be refreshed; these are the previous numbers." : "The statistics could not be loaded."}{" "}
						<button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
							Try again
						</button>
					</p>
				)}

				{!data && phase !== "error" && <Skeleton />}

				{data && data.total === 0 && (
					<section className={styles.emptyCard} aria-live="polite">
						<h2>No scans match these filters</h2>
						<p>Remove a filter to see the library again.</p>
						<button type="button" className={styles.primaryButton} onClick={clearAll}>
							Clear filters
						</button>
					</section>
				)}

				{data && data.total > 0 && (
					<div className={`${styles.board} ${phase === "loading" ? styles.boardBusy : ""}`}>
						<Kpis data={data} />

						<Card title="Contrast phase" subtitle={coverageText(data.phase)} span="half">
							<StackedBars
								rows={data.phase.rows}
								denominator={data.phase.recorded}
								selected={data.phase.rows
									.filter((row) => selectedPhase(query, row.key))
									.map((row) => row.key)}
								canSelect={(row) => PHASE_FILTER_VALUE[row.key] !== undefined}
								onSelect={(row) => apply(togglePhase(query, row.key))}
							/>
						</Card>

						<Card title="Sex" subtitle={coverageText(data.sex)} span="half">
							<StackedBars
								rows={data.sex.rows}
								denominator={data.sex.recorded}
								selected={query.filters.sex}
								onSelect={(row) => apply(toggleFilter(query, "sex", row.key))}
							/>
							{data.sex.ratio && (
								<p className={styles.figures}>
									<Figure value={`${data.sex.ratio.male_percent}%`} label="male" />
									<Figure value={`${data.sex.ratio.female_percent}%`} label="female" />
									<Figure value={count(data.sex.not_reported)} label="not reported" />
								</p>
							)}
						</Card>

						<Card title="Age at scan" subtitle={coverageText(data.age)} span="full">
							<Histogram
								label="Scans by age at scan, in five-year bins"
								bins={ageBins(data, query)}
								summary={ageSummary(data)}
								onSelect={(bin) => apply(toggleFilter(query, "age", decadeBin(Number(bin.key))))}
							/>
							<p className={styles.hint}>Selecting a column filters to its ten-year age band, as in the library.</p>
						</Card>

						<Card title="Scanner make" subtitle={coverageText(data.manufacturer)} span="half">
							<StackedBars
								rows={data.manufacturer.rows}
								denominator={data.manufacturer.recorded}
								selected={query.filters.manufacturer}
								canSelect={(row) => row.key !== "__other__"}
								onSelect={(row) => apply(toggleFilter(query, "manufacturer", row.key))}
							/>
							<RecordedBy data={data} field="manufacturer" />
						</Card>

						<Card title="Most-used scanner models" subtitle={coverageText(data.model)} span="half">
							<StackedBars rows={data.model.rows} denominator={data.model.recorded} />
							<RecordedBy data={data} field="model" />
						</Card>

						<Card title="Tumor" subtitle={coverageText(data.tumor, "scans with a known tumor status")} span="half">
							<TumorSplit data={data} query={query} apply={apply} />
							<StackedBars
								rows={data.tumor.types}
								denominator={data.tumor.types.reduce((sum, row) => sum + row.count, 0) || 1}
								selected={query.filters.tumorType}
								onSelect={(row) => apply(toggleFilter(query, "tumorType", row.key))}
								empty="No tumor organ is recorded for these scans."
								noun="scans with a tumor"
							/>
							<p className={styles.hint}>A scan with tumors in two organs counts in both.</p>
						</Card>

						<Card title="Acquisition year" subtitle={coverageText(data.year)} span="half">
							<Histogram
								label="Scans by acquisition year"
								bins={yearBins(data, query)}
								summary={yearSummary(data)}
								onSelect={(bin) => apply(toggleFilter(query, "year", bin.key))}
							/>
							{data.year.range_only > 0 && (
								<p className={styles.hint}>
									{count(data.year.range_only)} scans give only a range of years (for example 2012; 2016; 2020) and are
									left out rather than placed in one of them.
								</p>
							)}
							<RecordedBy data={data} field="year" />
						</Card>

						<Card title="Sites and countries" subtitle={coverageText(data.country)} span="full">
							<div className={styles.countryLayout}>
								<CountryMap
									rows={data.country.rows}
									selected={query.filters.siteNat}
									onSelect={(code) => apply(toggleFilter(query, "siteNat", code))}
								/>
								<div>
									<StackedBars
										rows={data.country.rows.slice(0, 10)}
										denominator={data.country.recorded}
										selected={query.filters.siteNat}
										onSelect={(row) => apply(toggleFilter(query, "siteNat", row.key))}
										empty="No site country is recorded for these scans."
									/>
									<RecordedBy data={data} field="country" />
								</div>
							</div>
						</Card>

						<Card
							title="Image geometry"
							subtitle="Slice spacing and the length of body each scan covers (slices × spacing)."
							span="full"
						>
							<div className={styles.twoUp}>
								<div>
									<h3 className={styles.subhead}>Slice spacing</h3>
									<StackedBars rows={data.slice_thickness.rows} denominator={data.slice_thickness.recorded} />
									<p className={styles.hint}>
										Median {number1(data.slice_thickness.median)} mm · {coverageText(data.slice_thickness)}
									</p>
								</div>
								<div>
									<h3 className={styles.subhead}>Coverage along the body</h3>
									<StackedBars rows={data.coverage.rows} denominator={data.coverage.recorded} />
									<p className={styles.hint}>
										Median {number1(data.coverage.median === null ? null : Math.round(data.coverage.median))} cm ·{" "}
										{coverageText(data.coverage)}
									</p>
								</div>
							</div>
						</Card>

						<Card
							title="What each dataset records"
							subtitle="Every chart above is drawn from the scans that record its field. This is how many that is, per dataset."
							span="full"
						>
							<Completeness rows={data.completeness} />
						</Card>
					</div>
				)}

				<p className={styles.footnote}>
					These are counts only; nothing here identifies a patient. Fields come from each dataset's published
					metadata, and a scan that does not record a field is left out of that chart, never counted as zero.
				</p>
			</main>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------- pieces
const Card: React.FC<{ title: string; subtitle?: string; span: "half" | "full"; children: React.ReactNode }> = ({
	title,
	subtitle,
	span,
	children,
}) => (
	<section className={`${styles.card} ${span === "full" ? styles.cardFull : ""}`} aria-label={title}>
		<h2 className={styles.cardTitle}>{title}</h2>
		{subtitle && <p className={styles.cardSub}>{subtitle}</p>}
		{children}
	</section>
);

const Figure: React.FC<{ value: string; label: string }> = ({ value, label }) => (
	<span className={styles.figure}>
		<strong>{value}</strong> {label}
	</span>
);

const DatasetChip: React.FC<{
	dataset: DatasetKey;
	count: number | null;
	total: number | null;
	on: boolean;
	onClick: () => void;
}> = ({ dataset, count: n, total, on, onClick }) => (
	<button
		type="button"
		className={`${styles.datasetChip} ${on ? styles.datasetChipOn : ""}`}
		aria-pressed={on}
		onClick={onClick}
	>
		<span className={styles.dot} style={{ background: DATASET_COLORS[dataset] }} aria-hidden="true" />
		<span className={styles.datasetName}>{DATASET_LABELS[dataset]}</span>
		<span className={styles.datasetCount}>
			{n === null ? "…" : count(n)}
			{n !== null && total ? <span className={styles.datasetShare}>{percent(n / total)}</span> : null}
		</span>
	</button>
);

const Kpis: React.FC<{ data: StatsResponse }> = ({ data }) => {
	const withTumor = sumSplit(data.tumor.with_tumor);
	const known = data.tumor.recorded;
	return (
		<div className={styles.kpis}>
			<Kpi label="Scans" value={count(data.total)} note={`across ${data.datasets.filter((d) => d.count > 0).length} dataset${data.datasets.filter((d) => d.count > 0).length === 1 ? "" : "s"}`} />
			<Kpi
				label="With a tumor"
				value={known ? percent(withTumor / known) : "—"}
				note={known ? `${count(withTumor)} of ${count(known)} with a known status` : "no tumor status recorded"}
			/>
			<Kpi
				label="Median age"
				value={data.age.median === null ? "—" : `${number1(data.age.median)} y`}
				note={data.age.q1 === null ? "no age recorded" : `IQR ${number1(data.age.q1)}–${number1(data.age.q3)}`}
			/>
			<Kpi
				label="Contrast phase recorded"
				value={percent(data.phase.share)}
				note={`${count(data.phase.recorded)} of ${count(data.phase.total)} scans`}
			/>
		</div>
	);
};

const Kpi: React.FC<{ label: string; value: string; note: string }> = ({ label, value, note }) => (
	<div className={styles.kpi}>
		<span className={styles.kpiLabel}>{label}</span>
		<span className={styles.kpiValue}>{value}</span>
		<span className={styles.kpiNote}>{note}</span>
	</div>
);

const TumorSplit: React.FC<{ data: StatsResponse; query: StatsQuery; apply: (q: StatsQuery) => void }> = ({
	data,
	query,
	apply,
}) => {
	const with_ = sumSplit(data.tumor.with_tumor);
	const without = sumSplit(data.tumor.without_tumor);
	const unknown = sumSplit(data.tumor.unknown);
	return (
		<div className={styles.splitRow} role="group" aria-label="Tumor status">
			<button
				type="button"
				className={`${styles.splitButton} ${query.filters.tumor === "tumor" ? styles.splitButtonOn : ""}`}
				aria-pressed={query.filters.tumor === "tumor"}
				onClick={() => apply(setTumor(query, "tumor"))}
			>
				<strong>{count(with_)}</strong> with a tumor
			</button>
			<button
				type="button"
				className={`${styles.splitButton} ${query.filters.tumor === "no_tumor" ? styles.splitButtonOn : ""}`}
				aria-pressed={query.filters.tumor === "no_tumor"}
				onClick={() => apply(setTumor(query, "no_tumor"))}
			>
				<strong>{count(without)}</strong> without
			</button>
			<span className={styles.splitStatic}>
				<strong>{count(unknown)}</strong> unknown
			</span>
		</div>
	);
};

/** Which datasets actually record a field ("Recorded by PanTS."): the honest footnote under a chart
 *  that only one or two of them feed. */
const RecordedBy: React.FC<{ data: StatsResponse; field: string }> = ({ data, field }) => {
	const row = data.completeness.find((r) => r.field === field);
	if (!row) return null;
	const names = DATASET_KEYS.filter((key) => (row.datasets[key]?.recorded ?? 0) > 0).map((key) => DATASET_LABELS[key]);
	if (!names.length || names.length === DATASET_KEYS.length) return null;
	return <p className={styles.hint}>Recorded by {names.join(" and ")} only.</p>;
};

const Skeleton: React.FC = () => (
	<div className={styles.skeleton} role="status" aria-label="Loading statistics">
		<div className={styles.skeletonKpis}>
			{[0, 1, 2, 3].map((i) => (
				<span key={i} className={styles.skeletonBlock} />
			))}
		</div>
		<span className={`${styles.skeletonBlock} ${styles.skeletonTall}`} />
	</div>
);

// ---------------------------------------------------------------------------------------------- mapping
const phaseFilterValue = (key: string): string | undefined => PHASE_FILTER_VALUE[key];

const selectedPhase = (query: StatsQuery, key: string): boolean => {
	const value = phaseFilterValue(key);
	return !!value && query.filters.ctPhase.some((v) => v.toLowerCase() === value.toLowerCase());
};

const togglePhase = (query: StatsQuery, key: string): StatsQuery => {
	const value = phaseFilterValue(key);
	if (!value) return query;
	const existing = query.filters.ctPhase.find((v) => v.toLowerCase() === value.toLowerCase());
	return toggleFilter(query, "ctPhase", existing ?? value);
};

const ageBins = (data: StatsResponse, query: StatsQuery): HistBin[] =>
	data.age.bins.map((bin) => ({
		key: String(bin.lo),
		tick: bin.lo % (AGE_STEP * 2) === 0 ? String(bin.lo) : "",
		label: `Age ${bin.label}`,
		count: bin.count,
		datasets: bin.datasets,
		on: query.filters.age.includes(decadeBin(bin.lo)),
	}));

const ageSummary = (data: StatsResponse): string => {
	const a = data.age;
	if (a.median === null) return "No age recorded";
	const parts = [`Median ${number1(a.median)}`, `IQR ${number1(a.q1)}–${number1(a.q3)}`, `mean ${number1(a.mean)}`];
	if (a.under_15) parts.push(`${count(a.under_15)} under 15`);
	return parts.join(" · ");
};

const yearBins = (data: StatsResponse, query: StatsQuery): HistBin[] =>
	data.year.rows.map((row) => ({
		key: String(row.year),
		tick: row.year % YEAR_TICK_EVERY === 0 ? String(row.year) : "",
		label: String(row.year),
		count: row.count,
		datasets: row.datasets,
		on: query.filters.year.includes(String(row.year)),
	}));

const yearSummary = (data: StatsResponse): string => {
	const rows = data.year.rows;
	if (!rows.length) return "No acquisition year recorded";
	const peak = rows.reduce((best, row) => (row.count > best.count ? row : best), rows[0]);
	return `${rows[0].year}–${rows[rows.length - 1].year} · most scans in ${peak.year} (${count(peak.count)})`;
};
