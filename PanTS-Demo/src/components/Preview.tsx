import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { caseIdToNumber } from "../helpers/caseNumbering";
import { IconBookmark, IconCheck } from "@tabler/icons-react";
import styles from "./Preview.module.css";
import { API_BASE } from "../helpers/constants";
import { prefetchViewer } from "../helpers/prefetchViewer";
import { formatTumorBadge, type CaseId } from "../helpers/search";
import type { PreviewType } from "../types";

type Props = {
	id: CaseId;
	previewMetadata: PreviewType;
	saved?: boolean;
	onToggleSave?: () => void;
	compareSelected?: boolean;
	onToggleCompare?: () => void;
	// When the grid coordinates a synchronized reveal, it holds every card hidden
	// (spinner) until the whole batch has settled, then flips `reveal` true for all
	// of them at once. `onSettled` fires once, when this card's image loads or fails.
	reveal?: boolean;
	onSettled?: () => void;
};

export default function Preview({
	id,
	previewMetadata,
	saved = false,
	onToggleSave,
	compareSelected = false,
	onToggleCompare,
	reveal = true,
	onSettled,
}: Props) {
	const [imgLoaded, setImgLoaded] = useState(false);
	const [imgError, setImgError] = useState(false);
	// Report "settled" exactly once (load or terminal error) so the grid can count
	// down to an all-at-once reveal without a broken thumbnail double-counting.
	const settledRef = useRef(false);
	const settle = () => {
		if (!settledRef.current) {
			settledRef.current = true;
			onSettled?.();
		}
	};
	// Prefer the lab's local data via the existing backend endpoint; fall back to
	// the HuggingFace dataset if the local profile image isn't available on the
	// server (so thumbnails never break regardless of deployment). Loaded natively
	// (no blob round-trip) so the browser streams cards in parallel and caches them.
	const [thumbUrl, setThumbUrl] = useState(
		`${API_BASE}/api/get_image_preview/${id}`
	);

	if (!previewMetadata) return null;

	// CancerVerse ids arrive as full strings ("CV_00000001"); PanTS as bare numbers.
	const caseIdStr =
		typeof id === "string" && id.toUpperCase().startsWith("CV")
			? id
			: `PanTS_${id.toString().padStart(8, "0")}`;
	const libraryNumber = caseIdToNumber(id);
	// HuggingFace fallback, routed through the backend's same-origin proxy. A *direct*
	// cross-origin image is blocked by the viewer's COEP: require-corp header (which is
	// why thumbnails went missing); the proxy keeps it same-origin, matching home.html.
	const hfProfileUrl = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/profile_only/${caseIdStr}/profile.jpg`;
	const proxyThumbUrl = `${API_BASE}/api/proxy-image?url=${encodeURIComponent(hfProfileUrl)}`;
	const handleImgError = () => {
		if (thumbUrl !== proxyThumbUrl) {
			setThumbUrl(proxyThumbUrl); // local failed — retry via the same-origin HF proxy
		} else {
			setImgError(true); // both sources failed
			settle(); // count it as settled so one dead thumbnail can't stall the grid
		}
	};
	const tumorLabel =
		previewMetadata.tumor === 1
			? formatTumorBadge(previewMetadata.tumorLabel)
			: previewMetadata.tumor === 0
				? "No Tumor"
				: "Unknown";
	const tumorClass = previewMetadata.tumor === 1
		? styles.tumor
		: previewMetadata.tumor === 0 ? styles.noTumor : styles.unknown;

	return (
		<article className={styles.card} onMouseEnter={prefetchViewer}>
			<Link to={`/case/${id}`} className={styles.caseLink} aria-label={`Open case ${caseIdStr}`} onFocus={prefetchViewer}>
				<div className={styles.thumbnail}>
					{!imgError && (
						<img
							src={thumbUrl}
							alt={`Case ${id} CT scan`}
							loading="eager"
							decoding="async"
							onLoad={() => { setImgLoaded(true); settle(); }}
							onError={handleImgError}
							className={`${styles.image} ${imgLoaded && reveal ? styles.imageVisible : ""}`}
						/>
					)}
					{(!imgLoaded || !reveal) && !imgError && (
						<div className={styles.imageStatus} aria-hidden="true"><span className={styles.spinner} /></div>
					)}
					{imgError && <span className={styles.imageStatus}>Preview unavailable</span>}
				</div>
				<div className={styles.details}>
					<span className={styles.caseId}>{caseIdStr}</span>
                    {libraryNumber !== null && <span data-testid="case-number"
                        title="Case number: 1-9,901 are PanTS, CancerVerse continues from 9,902"
                        style={{ fontSize: "11px", color: "#6b7280", marginLeft: "6px" }}>
                        #{libraryNumber.toLocaleString("en-US")}
                    </span>}
					<div className={`${styles.metadata} flex-wrap`}>
						<span>Sex <strong>{previewMetadata.sex || "—"}</strong></span>
						<span>Age <strong>{previewMetadata.age || "—"}y</strong></span>
						<span className={`${styles.tumorBadge} ${tumorClass}`}>{tumorLabel}</span>
					</div>
				</div>
			</Link>
			{onToggleSave && (
				<button
					type="button"
					aria-label={saved ? `Remove case ${id} from saved` : `Save case ${id}`}
					aria-pressed={saved}
					title={saved ? "Saved. Click to remove" : "Save case"}
					onClick={onToggleSave}
					className={`${styles.bookmark} ${saved ? styles.selected : ""}`}
				>
					<IconBookmark size={17} fill={saved ? "currentColor" : "none"} aria-hidden="true" />
				</button>
			)}
			{onToggleCompare && (
				<button
					type="button"
					aria-label={compareSelected ? `Remove case ${id} from comparison` : `Add case ${id} to comparison`}
					aria-pressed={compareSelected}
					title={compareSelected ? "Selected to compare. Click to remove" : "Select to compare"}
					onClick={onToggleCompare}
					className={`${styles.compare} ${compareSelected ? styles.selected : ""}`}
				>
					<span className={styles.check}>{compareSelected && <IconCheck size={12} aria-hidden="true" />}</span>
					Compare
				</button>
			)}
		</article>
	);
}
