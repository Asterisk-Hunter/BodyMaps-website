/**
 * Crawler-readable guard: search engines, link previews and AI assistants mostly do not run JavaScript, so
 * index.html carries a static summary inside #root (React replaces it on mount), and public/ ships
 * robots.txt, sitemap.xml and llms.txt. Every page those files point to must be a real guest-accessible route,
 * and robots.txt must never block one of them.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LANDING_OVERVIEW, LANDING_SUBTITLE, NONCLINICAL_WARNING, SITE_DESCRIPTION } from "../helpers/copy";
import { MARKER, NOT_FOR_CRAWLERS, injectPublicSections, renderPublicSections } from "../seo/staticSummary";
import { LAST_UPDATED, PRIVACY, TERMS, TERMS_INTRO } from "../routes/legalText";
import { MEMBERS } from "../routes/TeamPage/members";

// Normalized so a Windows checkout (CRLF) reads the same as the LF files in the repo.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const ORIGIN = "https://bodymaps.wse.jhu.edu";

const app = read("src/App.tsx");
/** Paths in App.tsx's publicPage list ("" is the landing page). */
const publicPages = (): string[] => {
  const m = app.match(/const publicPage = \[([^\]]*)\]/);
  if (!m) throw new Error("publicPage list not found in App.tsx");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1] || "/");
};
const routePaths = new Set([...app.matchAll(/<Route path="([^"]+)"/g)].map((x) => x[1]));

const staticBlock = (): string => {
  const html = read("index.html");
  const m = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<script type="module"/);
  if (!m) throw new Error("#root block not found");
  return m[1];
};
const sitemapPaths = (): string[] =>
  [...read("public/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1].replace(ORIGIN, "") || "/");
const disallowed = (): string[] =>
  read("public/robots.txt").split("\n").filter((l) => l.startsWith("Disallow:")).map((l) => l.slice(9).trim());

describe("crawler-readable site", () => {
  it("React replaces the static summary rather than hydrating it", () => {
    const main = read("src/main.tsx");
    expect(main).toContain("createRoot(document.getElementById('root')!)");
    expect(main).not.toContain("hydrateRoot");
  });

  it("visitors never see the summary: hidden by default in <head>, shown only when JavaScript is off", () => {
    const html = read("index.html");
    const head = html.slice(0, html.indexOf("<body>"));
    // hidden by the base rule itself, so no script has to run before the first paint
    expect(head).toMatch(/\.bm-static \{ display: none;/);
    expect(head).toContain("<noscript><style>.bm-static { display: block; }</style></noscript>");
    expect(html).not.toContain("bm-js");
  });

  it("index.html has readable text for non-JavaScript readers, in the canonical copy", () => {
    const block = staticBlock();
    for (const text of [LANDING_SUBTITLE, LANDING_OVERVIEW, NONCLINICAL_WARNING]) expect(block).toContain(text);
    expect(block).toMatch(/<h1>BodyMaps<\/h1>/);
    for (const model of ["ePAI", "Atlas-Net", "LesionSegmenter"]) expect(block).toContain(model);
    expect(block).not.toMatch(/—/);
    expect(read("index.html")).toContain('"application/ld+json"');
  });

  it("the build writes every public page into the summary, since nginx serves this one file for all of them", () => {
    const html = read("index.html");
    expect(html.split(MARKER).length).toBe(2);
    expect(staticBlock()).toContain(MARKER);
    expect(read("vite.config.ts")).toMatch(/plugins: \[[^\]]*staticSummaryPlugin\(\)/);
    const built = injectPublicSections(html);
    expect(built).not.toContain(MARKER);
    const inRoot = built.slice(built.indexOf('<div id="root">'), built.indexOf('<script type="module"'));
    for (const m of MEMBERS) {
      expect(inRoot).toContain(m.name.replace(/&/g, "&amp;"));
      expect(inRoot).toContain(m.role);
    }
    for (const s of PRIVACY) expect(inRoot).toContain(`<h3>${s.heading.replace(/&/g, "&amp;")}</h3>`);
    expect(inRoot).toContain(LAST_UPDATED);
    for (const id of ["dashboard", "statistics", "upload", "team", "contact", "privacy"]) {
      expect(inRoot).toContain(`<section id="${id}"><h2><a href="/${id}">`);
    }
    expect(() => injectPublicSections(html.replace(MARKER, ""))).toThrow();
    expect(() => injectPublicSections(html + MARKER)).toThrow();
  });

  it("the Terms of Service stay out: not in the summary, not linked, not listed, disallowed in robots.txt", () => {
    expect(NOT_FOR_CRAWLERS).toEqual(["/terms"]);
    const built = injectPublicSections(read("index.html"));
    const inRoot = built.slice(built.indexOf('<div id="root">'), built.indexOf('<script type="module"'));
    const privacyHeadings = new Set(PRIVACY.map((s) => s.heading));
    for (const s of TERMS) {
      if (!privacyHeadings.has(s.heading)) expect(inRoot).not.toContain(`<h3>${s.heading.replace(/&/g, "&amp;")}</h3>`);
      expect(inRoot).not.toContain(s.body.slice(0, 80).replace(/&/g, "&amp;"));
    }
    expect(inRoot).not.toContain(TERMS_INTRO.slice(0, 60));
    expect(inRoot).not.toContain('<section id="terms"');
    expect(inRoot).not.toMatch(/href="\/terms"/);
    expect(read("public/llms.txt")).not.toContain("/terms");
    expect(sitemapPaths()).not.toContain("/terms");
    expect(disallowed()).toContain("/terms");
  });

  it("the generated sections escape the source text and link legal [label](target) tokens", () => {
    const out = renderPublicSections();
    expect(out).not.toMatch(/\[[^\]]+\]\([^)]+\)/);             // every [label](target) became a link
    expect(out).toContain('<a href="/contact">');
    expect(out).not.toMatch(/<(?!\/?(section|h2|h3|p|a|ul|li)\b)/); // only the tags it writes
    expect(out).not.toMatch(/—/);
  });

  it("every link in the static summary, sitemap and llms.txt is a real, guest-accessible route", () => {
    const pub = new Set(publicPages());
    const links = [
      ...[...staticBlock().matchAll(/href="([^"]+)"/g)].map((x) => x[1]),
      ...[...renderPublicSections().matchAll(/href="(\/[^"]*)"/g)].map((x) => x[1]),
      ...sitemapPaths(),
      ...[...read("public/llms.txt").matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((x) => x[1].replace(ORIGIN, "") || "/"),
    ];
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      expect(link.startsWith("/"), `${link} is not on this site`).toBe(true);
      expect(routePaths.has(link), `${link} is not a route in App.tsx`).toBe(true);
      expect(pub.has(link), `${link} is not in App.tsx's publicPage list`).toBe(true);
    }
  });

  it("robots.txt allows crawling, points at the sitemap, and blocks none of the listed pages", () => {
    const robots = read("public/robots.txt");
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const blocked = disallowed();
    expect(blocked).not.toContain("/");
    expect(blocked).toContain("/api/");
    for (const page of sitemapPaths()) {
      for (const prefix of blocked) expect(page.startsWith(prefix), `${page} blocked by ${prefix}`).toBe(false);
    }
  });

  it("the sitemap covers every guest page except auth flows and local-file viewers", () => {
    const skip = new Set(["/upload", "/local-nifti", "/dicom", "/reset-password", "/verify-email", "/signup", "/login", ...NOT_FOR_CRAWLERS]);
    expect(new Set(sitemapPaths())).toEqual(new Set(publicPages().filter((p) => !skip.has(p))));
  });

  it("ships exactly one IndexNow key file whose content is its own name", () => {
    const keys = readdirSync(resolve(process.cwd(), "public")).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
    expect(keys).toHaveLength(1);
    expect(read(`public/${keys[0]}`)).toBe(keys[0].slice(0, 32));
    expect(read("scripts/indexnow-submit.mjs")).toContain("api.indexnow.org/indexnow");
  });

  it("llms.txt opens with the site description", () => {
    const llms = read("public/llms.txt");
    expect(llms.startsWith("# BodyMaps\n")).toBe(true);
    expect(llms).toContain(`> ${SITE_DESCRIPTION}`);
    expect(llms).toContain(NONCLINICAL_WARNING);
  });
});
