import { type RefObject, useEffect } from "react";

/**
 * Keeps the CSS variable --vp-topbar-h equal to the distance from the top of the window to the bottom edge of the
 * viewer's toolbar. Everything docked "just under the toolbar" (the annotation ribbon, the segment popup, the
 * onboarding hint) is placed with `position: fixed` from the top of the window, so what it needs is where the toolbar
 * ENDS, not how tall it is. The two differ whenever something sits above the toolbar (a live-room header, the
 * assignment bar), and using the height left those panels hidden behind the toolbar.
 *
 * It re-measures when the toolbar resizes, when anything above it resizes, appears or goes away, and when the window
 * resizes, because a bar that arrives after the page loads moves the toolbar without changing the toolbar's own size.
 */
export function useDockOffset(ref: RefObject<HTMLElement | null>, resetKey?: unknown) {
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const root = document.documentElement;
		const measure = () => root.style.setProperty("--vp-topbar-h", `${el.getBoundingClientRect().bottom}px`);

		const observer = new ResizeObserver(measure);
		const watch = () => {
			observer.disconnect();
			observer.observe(el);
			for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling);
			measure();
		};
		watch();

		const mutations = new MutationObserver(watch);
		if (el.parentElement) mutations.observe(el.parentElement, { childList: true });
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", measure);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ref, resetKey]);
}
