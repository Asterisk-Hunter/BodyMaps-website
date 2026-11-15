import { useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE } from "../helpers/constants";
import { isServerOnlyCaseId } from "../helpers/caseIds";
import { numberToCaseId } from "../helpers/caseNumbering";
import { prefetchViewer } from "../helpers/prefetchViewer";
import type { CaseStatus } from "../helpers/assignments";
import styles from "./Preview.module.css";
import "./AssignmentCaseCard.css";

// One case in an annotator's list: the same card as the Dataset page (thumbnail, case id, library number), with the
// state of the case written under it. Sex, age and tumor status are left off on purpose: annotators work from the scan.

export const STATUS_WORDS: Record<CaseStatus, string> = { todo: "Pending", done: "Complete", flagged: "Flagged" };

export default function AssignmentCaseCard({ number, status, task }: { number: number; status: CaseStatus; task?: string }) {
	const id = numberToCaseId(number) ?? number;
	const idText = typeof id === "string" && isServerOnlyCaseId(id) ? id : `PanTS_${String(id).padStart(8, "0")}`;
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<article className={`${styles.card} asg-case asg-case--${status}`} data-testid="assignment-case" data-status={status}>
			<Link to={`/case/${number}`} className={styles.caseLink} aria-label={`Open case ${idText}, ${STATUS_WORDS[status]}`} onMouseEnter={prefetchViewer} onFocus={prefetchViewer}>
				<div className={styles.thumbnail}>
					{!failed && (
						<img
							src={`${API_BASE}/api/get_image_preview/${id}`}
							alt=""
							loading="lazy"
							decoding="async"
							onLoad={() => setLoaded(true)}
							onError={() => setFailed(true)}
							className={`${styles.image} ${loaded ? styles.imageVisible : ""}`}
						/>
					)}
					{!loaded && !failed && <div className={styles.imageStatus} aria-hidden="true"><span className={styles.spinner} /></div>}
					{failed && <span className={styles.imageStatus}>Preview unavailable</span>}
				</div>
				<div className={styles.details}>
					<span className={styles.caseId}>
						{idText}
						<span className="asg-case-number">#{number.toLocaleString("en-US")}</span>
					</span>
					{task && <span className="asg-case-task">{task}</span>}
					<span className={`asg-case-status asg-case-status--${status}`} data-testid="case-status">{STATUS_WORDS[status]}</span>
				</div>
			</Link>
		</article>
	);
}
