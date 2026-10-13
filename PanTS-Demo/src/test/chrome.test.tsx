/**
 * Site chrome: the page surface colour before the app mounts, the keyboard
 * focus ring, and the floating scroll-to-top button (its place in the tab
 * order, reduced motion, the footer it must not cover, and where focus goes
 * after the jump).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScrollToTopButton from "../components/ScrollToTopButton";
import { DARK_ROUTE_CLASS, DARK_ROUTE_PATTERN, isDarkRoute } from "../helpers/routeSurface";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const originalMatchMedia = window.matchMedia;

afterEach(() => {
	window.matchMedia = originalMatchMedia;
	Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
	vi.restoreAllMocks();
});

describe("page surface before the app mounts", () => {
	it("index.html paints the dark routes with the same pattern the app uses", () => {
		const html = read("index.html");
		expect(html).toContain(DARK_ROUTE_PATTERN.source);
		expect(html).toContain(`classList.add("${DARK_ROUTE_CLASS}")`);
	});

	it("marks only the viewer-type routes dark", () => {
		for (const path of ["/case/1", "/session/abc", "/reconstruction/7", "/live/r1", "/live/challenge/c",
			"/learn/quiz/p", "/dicom", "/local-nifti", "/compare", "/compare-viewer"]) {
			expect(isDarkRoute(path), path).toBe(true);
		}
		for (const path of ["/", "/dashboard", "/upload", "/team", "/contact", "/terms", "/privacy", "/account",
			"/account/plan", "/share/abc", "/reset-password", "/verify-email", "/nope"]) {
			expect(isDarkRoute(path), path).toBe(false);
		}
	});

	it("the body is light by default rather than dark navy", () => {
		const css = read("src/index.css");
		const body = css.slice(css.indexOf("\nbody {"), css.indexOf("}", css.indexOf("\nbody {")));
		expect(body).toContain("background: var(--paper)");
		expect(body).not.toContain("min-width");
		expect(css).toContain(`html.${DARK_ROUTE_CLASS} body`);
	});

	it("#root clips sideways overflow without becoming a scroll container", () => {
		const css = read("src/App.css");
		const root = css.slice(css.indexOf("#root {"), css.indexOf("}", css.indexOf("#root {")));
		expect(root).toMatch(/overflow-x:\s*clip/);
	});

	it("buttons show a focus ring for the keyboard only, not after a click", () => {
		const css = read("src/index.css");
		expect(css).not.toMatch(/button:focus\s*,/);
		expect(css).toMatch(/button:focus-visible\s*\{\s*outline: 2px solid var\(--focus-ring\)/);
	});
});

const renderScrollButton = (withFooter = true) =>
	render(
		<MemoryRouter initialEntries={["/terms"]}>
			<main>Page</main>
			<ScrollToTopButton />
			{withFooter && <footer className="design-footer">Contact</footer>}
		</MemoryRouter>,
	);

const scrollWindowTo = (y: number) => {
	Object.defineProperty(window, "scrollY", { configurable: true, value: y });
	fireEvent.scroll(window);
};

describe("scroll-to-top button", () => {
	it("comes after the page in the DOM, so it is the last tab stop, not the first", () => {
		const app = read("src/App.tsx");
		expect(app.indexOf("<ScrollToTopButton />")).toBeGreaterThan(app.indexOf("</Suspense>"));
	});

	it("jumps without smooth scrolling for reduced motion, then hands focus to the page", () => {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})) as unknown as typeof window.matchMedia;
		const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
		renderScrollButton(false);
		scrollWindowTo(600);
		fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
		expect(document.activeElement).toBe(screen.getByRole("main"));
	});

	it("rises above the footer while the footer is on screen", () => {
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
		rect.mockImplementation(function (this: HTMLElement) {
			return (this.classList.contains("design-footer")
				? { top: window.innerHeight - 60, height: 60 }
				: { top: 0, height: 0 }) as DOMRect;
		});
		renderScrollButton();
		scrollWindowTo(600);
		const button = screen.getByRole("button", { name: "Scroll to top" });
		expect(button.style.getPropertyValue("--footer-lift")).toBe("60px");
	});
});
