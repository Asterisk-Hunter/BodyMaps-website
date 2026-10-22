// Static content of every public page, for readers that do not run JavaScript (AI assistants' fetch tools, link
// previews, simple crawlers). nginx answers every page path with the same index.html, so a fetch of /team or
// /privacy gets index.html; the vite plugin below writes these sections into its hidden #root summary at build time.
// The Terms of Service are deliberately left out (the maintainers do not want AI assistants reading them): no Terms
// section, links to /terms render as plain text, and robots.txt disallows /terms.
// Visitors never see it (index.html hides .bm-static whenever scripts run) and React replaces it on mount.
// The text comes from the same modules the pages render, so it cannot drift from the site.
import type { Plugin } from "vite";
import { FOOTER_INQUIRY_LEAD } from "../helpers/copy";
import { LAST_UPDATED, PRIVACY, PRIVACY_INTRO, type Section } from "../routes/legalText";
import { MEMBERS } from "../routes/TeamPage/members";

export const MARKER = "<!-- bm-static:pages -->";

/** Pages kept out of the summary and out of crawlers' reach (see robots.txt). */
export const NOT_FOR_CRAWLERS = ["/terms"];

const escape = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Legal text with [label](target) links, as LegalPage renders them ("contact" is the contact page). */
const withLinks = (text: string): string => {
	let out = "";
	let from = 0;
	for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
		out += escape(text.slice(from, m.index));
		const href = m[2] === "contact" ? "/contact" : m[2];
		out += NOT_FOR_CRAWLERS.includes(href) ? escape(m[1]) : `<a href="${escape(href)}">${escape(m[1])}</a>`;
		from = (m.index ?? 0) + m[0].length;
	}
	return out + escape(text.slice(from));
};

const legal = (id: string, title: string, intro: string, sections: Section[]): string =>
	`<section id="${id}"><h2><a href="/${id}">${title}</a></h2>` +
	`<p>Provisional, under review. ${escape(LAST_UPDATED)}.</p><p>${withLinks(intro)}</p>` +
	sections.map((s) => `<h3>${escape(s.heading)}</h3><p>${withLinks(s.body)}</p>`).join("") +
	"</section>";

/** One section per public page, in sitemap order after the landing page. */
export function renderPublicSections(): string {
	const team = MEMBERS.map((m) => {
		const link = m.links?.linkedin ? ` (<a href="${escape(m.links.linkedin)}">LinkedIn</a>)` : "";
		return `<li>${escape(m.name)}: ${escape(m.role)}${link}</li>`;
	}).join("");
	return [
		'<section id="dashboard"><h2><a href="/dashboard">Dataset</a></h2>' +
			"<p>The CT library: search body CT scans from public research datasets, including PanTS and CancerVerse, by case " +
			"number and filter them by tumor status, sex and age. Each case opens in a 2D and 3D viewer with its organ and tumor " +
			"labels; opening a case needs an account.</p></section>",
		'<section id="statistics"><h2><a href="/statistics">Statistics</a></h2>' +
			"<p>Interactive charts of the CT library that follow the current search filters: contrast phase, sex, age at scan, " +
			"scanner make, most-used scanner models, tumor status and the country of each scan, with how many scans have each " +
			"field recorded.</p></section>",
		'<section id="upload"><h2><a href="/upload">Workspace</a></h2>' +
			"<p>Upload a CT (NIfTI .nii or .nii.gz, or a DICOM series) and run AI segmentation with ePAI, Atlas-Net or " +
			"LesionSegmenter, then review, annotate and refine the result in the browser.</p></section>",
		`<section id="team"><h2><a href="/team">Team</a></h2><p>BodyMaps is built at Johns Hopkins University by:</p><ul>${team}</ul></section>`,
		'<section id="contact"><h2><a href="/contact">Contact</a></h2>' +
			`<p>${escape(FOOTER_INQUIRY_LEAD)} the <a href="/contact">contact form</a>. Describe your organization, the imaging ` +
			"modalities and scale, and whether you are evaluating, piloting or ready to contract. Do not send protected health " +
			"information.</p></section>",
		legal("privacy", "Privacy Notice", PRIVACY_INTRO, PRIVACY),
	].join("\n        ");
}

/** index.html with the page sections written in at the marker. Throws if the marker is missing or repeated. */
export function injectPublicSections(html: string): string {
	const parts = html.split(MARKER);
	if (parts.length !== 2) throw new Error(`index.html must contain ${MARKER} exactly once (found ${parts.length - 1})`);
	return parts[0] + renderPublicSections() + parts[1];
}

/** Vite plugin: fills the static summary in index.html (dev and build). */
export function staticSummaryPlugin(): Plugin {
	return { name: "bodymaps-static-summary", transformIndexHtml: { order: "pre", handler: injectPublicSections } };
}
