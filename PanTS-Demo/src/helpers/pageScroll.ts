/** The fixed workspace shell scrolls its content; standalone routes scroll the page. */
function contentScrollElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".design-content");
}

export function pageScrollTop(): number {
  return contentScrollElement()?.scrollTop ?? window.scrollY;
}

export function scrollPageToTop(): void {
  const target = contentScrollElement() ?? window;
  const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  target.scrollTo({ top: 0, behavior });
}
