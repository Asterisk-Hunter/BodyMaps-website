import React from "react";
import { Link } from "react-router-dom";
import SiteFooter from "../components/SiteFooter";
import { CONTACT_URL } from "../helpers/copy";
import { LAST_UPDATED, PRIVACY, PRIVACY_INTRO, TERMS, TERMS_INTRO } from "./legalText";
import "./LegalPage.css";

// Terms of Service and Privacy Notice.
//
// Provisional text: written in plain English to describe what the service
// actually does today, pending institutional review. When the wording changes
// materially, bump the date shown under the title. Do not describe behaviour
// (scheduled deletion, export, verification) that is not running in production.

// Section text is plain except for links written [label](target): "contact"
// is the site's contact page (opened in a new tab, like the footer's link), a
// path such as /terms is any other page.

const LINK_TOKEN = /\[([^\]]+)\]\(([^)]+)\)/g;

// Hyphenated words up to a line-friendly length ("de-identified", "need-to-know",
// "scan-contribution") are kept whole: the browser would otherwise break them
// at the hyphen and strand a half-word at the end of a line. Longer runs
// ("email-and-password", "intellectual-property") may break after a hyphen,
// since an unbreakable long run leaves a hole at the end of the previous line
// on a phone.
const COMPOUND = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g;
const MAX_COMPOUND_LENGTH = 17;

/** Plain text with each hyphenated compound kept on one line. */
const keepCompounds = (text: string, key: number): React.ReactNode[] => {
	const nodes: React.ReactNode[] = [];
	let from = 0;
	for (const m of text.matchAll(COMPOUND)) {
		if (m[0].length > MAX_COMPOUND_LENGTH) continue;
		nodes.push(text.slice(from, m.index));
		nodes.push(
			<span key={`${key}-${m.index}`} className="legal-compound">
				{m[0]}
			</span>,
		);
		from = m.index + m[0].length;
	}
	nodes.push(text.slice(from));
	return nodes;
};

/** Plain text with each [label](target) token drawn as a link. */
const withLinks = (text: string): React.ReactNode[] => {
	const nodes: React.ReactNode[] = [];
	let from = 0;
	for (const m of text.matchAll(LINK_TOKEN)) {
		nodes.push(...keepCompounds(text.slice(from, m.index), from));
		nodes.push(
			m[2] === "contact" ? (
				<Link key={m.index} to={CONTACT_URL} target="_blank" rel="noopener noreferrer">
					{m[1]}
				</Link>
			) : (
				<Link key={m.index} to={m[2]}>
					{m[1]}
				</Link>
			),
		);
		from = m.index + m[0].length;
	}
	nodes.push(...keepCompounds(text.slice(from), from));
	return nodes;
};


const LegalPage: React.FC<{ kind: "terms" | "privacy" }> = ({ kind }) => {
	const isTerms = kind === "terms";
	const sections = isTerms ? TERMS : PRIVACY;

	return (
		<div className="legal-wrapper">
			<header className="legal-header">
				<Link to="/" className="legal-brand">
					<img src="/bodymaps-logo.svg" alt="" className="legal-logo" />
					<span>BodyMaps</span>
				</Link>
			</header>

			<main className="legal-main">
				<h1 className="legal-title">{isTerms ? "Terms of Service" : "Privacy Notice"}</h1>

				<p className="legal-status" role="note">
					{isTerms ? "Provisional terms, under review." : "Provisional privacy notice, under review."}{" "}
					<span className="legal-updated">{LAST_UPDATED}</span>
				</p>

				<p className="legal-intro">{withLinks(isTerms ? TERMS_INTRO : PRIVACY_INTRO)}</p>

				{sections.map((s) => (
					<section key={s.heading} className="legal-section">
						<h2 className="legal-heading">{s.heading}</h2>
						<p className="legal-body">{withLinks(s.body)}</p>
					</section>
				))}

				<p className="legal-footer">
					Questions or feedback? Use the{" "}
					<Link to={CONTACT_URL} target="_blank" rel="noopener noreferrer">
						contact page
					</Link>
					. Do not include protected health information.
				</p>
			</main>

			{/* The workspace footer, in the same wrapper the workspace shell gives it. */}
			<div className="design-footer">
				<SiteFooter />
			</div>
		</div>
	);
};

export default LegalPage;
