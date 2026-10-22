import { useId, useState } from "react";
import { DATASET_KEYS, type Split } from "./statsApi";
import { DATASET_COLORS, DATASET_LABELS, count, niceMax } from "./statsFormat";
import styles from "./Statistics.module.css";

// Stacked columns: age in five-year bins, acquisition year. Plain HTML and CSS (flex columns whose
// segments are percentages of the chart height), so the columns glide when a filter changes the data
// and the layout is responsive without measuring anything.
//
// The line above the chart is a readout: it describes the whole distribution until a column is
// hovered or focused, then that column. That keeps the exact numbers one glance away without a
// floating tooltip, and a keyboard user gets the same readout as a mouse user.

export type HistBin = {
	key: string;
	/** Short text under the column (may be blank for crowded axes). */
	tick: string;
	/** Full name of the bin for the readout and the accessible name. */
	label: string;
	count: number;
	datasets: Split;
	/** Part of the active filter. */
	on?: boolean;
};

type Props = {
	bins: HistBin[];
	/** What the readout says when nothing is hovered ("Median 66 · IQR 56–75"). */
	summary: string;
	/** Noun for a bin's accessible name: "scans". */
	noun?: string;
	/** Picks a bin as a filter. Columns are plain when this is absent. */
	onSelect?: (bin: HistBin) => void;
	height?: number;
	empty?: string;
	/** Accessible name of the whole chart. */
	label: string;
};

const Histogram: React.FC<Props> = ({
	bins,
	summary,
	noun = "scans",
	onSelect,
	height = 188,
	empty = "Nothing recorded for these scans.",
	label,
}) => {
	const id = useId();
	const [active, setActive] = useState<HistBin | null>(null);
	const total = bins.reduce((sum, bin) => sum + bin.count, 0);
	if (!total) return <p className={styles.empty}>{empty}</p>;

	const top = niceMax(Math.max(...bins.map((bin) => bin.count), 1));
	const ticks = [top, top / 2, 0];
	const readout = active ? binReadout(active, noun) : summary;

	return (
		<div className={styles.hist} role="group" aria-label={label}>
			<p className={styles.histReadout} id={`${id}-readout`}>
				{readout}
			</p>
			<div className={styles.histPlot} style={{ height }}>
				<div className={styles.histGrid} aria-hidden="true">
					{ticks.map((tick) => (
						<span key={tick} className={styles.histGridLine}>
							<span className={styles.histGridLabel}>{count(tick)}</span>
						</span>
					))}
				</div>
				<div className={styles.histColumns} onMouseLeave={() => setActive(null)}>
					{bins.map((bin) => {
						const Tag = onSelect ? "button" : "div";
						return (
							<Tag
								key={bin.key}
								className={`${styles.histColumn} ${bin.on ? styles.histColumnOn : ""}`}
								{...(onSelect
									? {
											type: "button" as const,
											"aria-pressed": !!bin.on,
											onClick: () => onSelect(bin),
										}
									: {})}
								aria-label={`${bin.label}: ${count(bin.count)} ${noun}`}
								onMouseEnter={() => setActive(bin)}
								onFocus={() => setActive(bin)}
								onBlur={() => setActive(null)}
							>
								<span className={styles.histStack} style={{ height: `${(bin.count / top) * 100}%` }}>
									{DATASET_KEYS.map((key) =>
										bin.datasets[key] > 0 ? (
											<span
												key={key}
												className={styles.histSegment}
												style={{
													flexGrow: bin.datasets[key],
													background: DATASET_COLORS[key],
												}}
											/>
										) : null,
									)}
								</span>
							</Tag>
						);
					})}
				</div>
			</div>
			<div className={styles.histAxis} aria-hidden="true">
				{bins.map((bin) => (
					<span key={bin.key} className={styles.histTick}>
						{bin.tick}
					</span>
				))}
			</div>
		</div>
	);
};

const binReadout = (bin: HistBin, noun: string): string => {
	const parts = DATASET_KEYS.filter((key) => bin.datasets[key] > 0).map(
		(key) => `${DATASET_LABELS[key]} ${count(bin.datasets[key])}`,
	);
	return `${bin.label} · ${count(bin.count)} ${noun}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
};

export default Histogram;
