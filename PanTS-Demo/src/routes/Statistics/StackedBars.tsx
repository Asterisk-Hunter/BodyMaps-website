import { DATASET_KEYS, type StatRow } from "./statsApi";
import { DATASET_COLORS, DATASET_LABELS, count, percent } from "./statsFormat";
import styles from "./Statistics.module.css";

// A ranked list of bars, each split into the datasets that contribute to it.
//
// Length is the count (scaled to the longest bar, so twenty bars stay readable), colour is the dataset
// (the same three colours on every chart on the page). A row whose key means a library filter is a
// button: picking it narrows every chart. The share beside a bar is a share of the scans that RECORD
// the field, which is why the card above it says how many that is.

type Props = {
	rows: StatRow[];
	/** The scans the shares are taken of: those that record the field. */
	denominator: number;
	/** Rows currently filtered on (by key). */
	selected?: string[];
	/** Called with a row when it is picked. Rows are plain text when this is absent. */
	onSelect?: (row: StatRow) => void;
	/** Whether a row can be picked (an "Other" tail cannot). */
	canSelect?: (row: StatRow) => boolean;
	empty?: string;
	/** Noun for the row's accessible name: "scans". */
	noun?: string;
};

const StackedBars: React.FC<Props> = ({
	rows,
	denominator,
	selected = [],
	onSelect,
	canSelect = () => true,
	empty = "Nothing recorded for these scans.",
	noun = "scans",
}) => {
	const visible = rows.filter((row) => row.count > 0 || selected.includes(row.key));
	if (!visible.length) return <p className={styles.empty}>{empty}</p>;
	const max = Math.max(...visible.map((row) => row.count), 1);

	return (
		<ol className={styles.bars}>
			{visible.map((row) => {
				const pickable = !!onSelect && canSelect(row);
				const on = selected.includes(row.key);
				return (
					<li key={row.key} className={`${styles.barRow} ${on ? styles.barRowOn : ""}`}>
						<span className={styles.barLabel}>
							{pickable ? (
								<button
									type="button"
									className={styles.barPick}
									aria-pressed={on}
									aria-label={`${row.label}: ${count(row.count)} ${noun}. ${on ? "Remove this filter" : "Filter to this"}`}
									onClick={() => onSelect!(row)}
								>
									{row.label}
								</button>
							) : (
								row.label
							)}
						</span>
						<span className={styles.barTrack} role="img" aria-label={segmentsText(row)}>
							{DATASET_KEYS.map((key) =>
								row.datasets[key] > 0 ? (
									<span
										key={key}
										className={styles.barSegment}
										style={{
											width: `${(row.datasets[key] / max) * 100}%`,
											background: DATASET_COLORS[key],
										}}
										title={`${DATASET_LABELS[key]}: ${count(row.datasets[key])}`}
									/>
								) : null,
							)}
						</span>
						<span className={styles.barValue}>
							{count(row.count)}
							<span className={styles.barShare}>
								{denominator ? percent(row.count / denominator) : "—"}
							</span>
						</span>
					</li>
				);
			})}
		</ol>
	);
};

const segmentsText = (row: StatRow): string =>
	DATASET_KEYS.filter((key) => row.datasets[key] > 0)
		.map((key) => `${DATASET_LABELS[key]} ${count(row.datasets[key])}`)
		.join(", ") || "none";

export default StackedBars;
