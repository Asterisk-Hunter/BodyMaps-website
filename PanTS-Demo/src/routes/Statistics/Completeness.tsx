import { DATASET_KEYS, type StatsResponse } from "./statsApi";
import { DATASET_COLORS, DATASET_LABELS, FIELD_LABELS, count, percent } from "./statsFormat";
import styles from "./Statistics.module.css";

// What each dataset records. The three datasets were assembled differently (AbdomenAtlas names the
// scanner on a few percent of its scans, PanTS gives a year for under a third), so every other chart
// on the page is a picture of the scans that carry its field. This grid is the key to reading them:
// the darker the cell, the more of that dataset the chart above is drawn from.

type Props = { rows: StatsResponse["completeness"] };

const Completeness: React.FC<Props> = ({ rows }) => (
	<div className={styles.completeness}>
		<table className={styles.completenessTable}>
			<caption className="sr-only">
				Share of each dataset's scans that record each field, for the scans selected above.
			</caption>
			<thead>
				<tr>
					<th scope="col" className={styles.completenessCorner}>
						Field
					</th>
					{DATASET_KEYS.map((key) => (
						<th scope="col" key={key}>
							<span className={styles.dot} style={{ background: DATASET_COLORS[key] }} aria-hidden="true" />
							{DATASET_LABELS[key]}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.field}>
						<th scope="row">{FIELD_LABELS[row.field] ?? row.field}</th>
						{DATASET_KEYS.map((key) => {
							const cell = row.datasets[key];
							const share = cell?.share ?? null;
							return (
								<td
									key={key}
									title={
										cell && cell.total
											? `${count(cell.recorded)} of ${count(cell.total)} ${DATASET_LABELS[key]} scans`
											: `No ${DATASET_LABELS[key]} scans in this selection`
									}
								>
									<span
										className={styles.completenessCell}
										style={{
											// the dataset's own colour, as a wash that deepens with the share
											background:
												share === null
													? "transparent"
													: `color-mix(in srgb, ${DATASET_COLORS[key]} ${Math.round(share * 78 + 6)}%, white)`,
											color: share !== null && share > 0.55 && key !== "AbdomenAtlas" ? "#fff" : "#0f172a",
										}}
									>
										{percent(share)}
									</span>
								</td>
							);
						})}
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

export default Completeness;
