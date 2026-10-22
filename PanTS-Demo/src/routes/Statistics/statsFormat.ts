// Numbers and colours for the Statistics page.

import type { Coverage, DatasetKey, Split } from "./statsApi";
import { DATASET_KEYS } from "./statsApi";

/** Johns Hopkins brand colours (brand.jhu.edu/visual-identity/colors): Heritage Blue, Spirit Blue, Gold.
 *  A dataset keeps its colour on every chart, so a bar's colour always answers "which dataset". */
export const JHU = {
	heritage: "#002D72",
	spirit: "#68ACE5",
	gold: "#F1C400",
} as const;

export const DATASET_COLORS: Record<DatasetKey, string> = {
	PanTS: JHU.heritage,
	CancerVerse: JHU.spirit,
	AbdomenAtlas: JHU.gold,
};

export const DATASET_LABELS: Record<DatasetKey, string> = {
	PanTS: "PanTS",
	CancerVerse: "CancerVerse",
	AbdomenAtlas: "AbdomenAtlas",
};

export const count = (value: number): string => Math.round(value).toLocaleString("en-US");

/** A share of 0..1 as "71.8%" (one decimal under 10%, none at or above 99.95). */
export const percent = (share: number | null | undefined): string => {
	if (share === null || share === undefined || !Number.isFinite(share)) return "—";
	const value = share * 100;
	if (value > 0 && value < 0.1) return "<0.1%";
	return `${value.toFixed(value >= 99.95 ? 0 : 1)}%`;
};

/** "Recorded for 31,300 of 43,585 scans (71.8%)": how many scans a chart is drawn from. */
export const coverageText = (coverage: Coverage, noun = "scans"): string => {
	if (!coverage.total) return `No ${noun} match.`;
	if (coverage.recorded === coverage.total) return `Recorded for all ${count(coverage.total)} ${noun}.`;
	if (!coverage.recorded) return `Recorded for none of the ${count(coverage.total)} ${noun}.`;
	return `Recorded for ${count(coverage.recorded)} of ${count(coverage.total)} ${noun} (${percent(coverage.share)}).`;
};

export const sumSplit = (split: Split): number => DATASET_KEYS.reduce((sum, key) => sum + (split[key] ?? 0), 0);

/** A year, or an age, shown without a spurious decimal: 66, 64.9. */
export const number1 = (value: number | null | undefined): string => {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/** Round a chart maximum up to a tidy axis end: 1,234 -> 1,500; 87 -> 100. */
export const niceMax = (value: number): number => {
	if (value <= 0) return 1;
	const exponent = Math.pow(10, Math.floor(Math.log10(value)));
	const fraction = value / exponent;
	const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
	return step * exponent;
};

export const FIELD_LABELS: Record<string, string> = {
	sex: "Sex",
	age: "Age",
	phase: "Contrast phase",
	manufacturer: "Scanner make",
	model: "Scanner model",
	year: "Acquisition year",
	country: "Site country",
	tumor: "Tumor status",
};
