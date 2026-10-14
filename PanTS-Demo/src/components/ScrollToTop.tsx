import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

// Resets the window's scroll on route change. BrowserRouter has no built-in
// scroll restoration, so without this a page outside the workspace shell (the
// viewer, compare, legal and account-recovery pages) opens at the previous
// page's scroll offset. The shell scrolls its own content region and resets it
// itself (DesignShell). Instant scrollTo (not smooth) so the new page simply
// appears at the top. Keyed on pathname only: query-param changes and hash
// changes must not reset scroll.
//
// Browser Back and Forward (a POP) put the reader back where they were
// instead: the offset is remembered per history entry (location.key) and
// restored once the page is tall enough, since a page can render after its
// data arrives.
const SAVED_LIMIT = 100;
const RESTORE_WINDOW_MS = 1000;
const USER_INPUT = ["wheel", "touchmove", "keydown", "mousedown"] as const;
const saved = new Map<string, number>();

// Skips the call when the window is already there (a page that fits, or one
// that never scrolled), so nothing is scrolled for no reason.
function scrollWindowTo(y: number) {
  if (window.scrollY !== y) window.scrollTo(0, y);
}

export default function ScrollToTop() {
  const { pathname, key } = useLocation();
  const navType = useNavigationType();
  const lastPath = useRef<string | null>(null);
  // Latest offset of the page on screen, kept by the scroll listener. It is
  // read when the location changes, because by then the new page has rendered
  // and a shorter page has already clamped the live scroll position.
  const latest = useRef(0);

  useEffect(() => {
    const track = () => {
      latest.current = window.scrollY;
    };
    window.addEventListener("scroll", track, { passive: true });
    let previous: ScrollRestoration | undefined;
    try {
      previous = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
    } catch {
      /* history API unavailable */
    }
    return () => {
      window.removeEventListener("scroll", track);
      try {
        if (previous) window.history.scrollRestoration = previous;
      } catch {
        /* history API unavailable */
      }
    };
  }, []);

  useLayoutEffect(() => {
    const pathChanged = lastPath.current !== pathname;
    lastPath.current = pathname;
    const target = navType === "POP" ? saved.get(key) : undefined;
    let cancel: (() => void) | undefined;

    if (target !== undefined) {
      latest.current = target;
      cancel = restoreOffset(target);
    } else if (pathChanged) {
      latest.current = 0;
      scrollWindowTo(0);
    }

    return () => {
      cancel?.();
      saved.delete(key);
      saved.set(key, latest.current);
      if (saved.size > SAVED_LIMIT) {
        const oldest = saved.keys().next().value;
        if (oldest !== undefined) saved.delete(oldest);
      }
    };
  }, [pathname, key, navType]);
  return null;
}

// Scrolls to the saved offset, and keeps trying for about a second while the
// page is still too short to reach it. Any wheel, touch, key or click from
// the reader ends it at once. Returns a function that stops it.
function restoreOffset(target: number): () => void {
  let frame = 0;
  let stopped = false;
  const start = performance.now();
  const apply = () => {
    scrollWindowTo(target);
    return document.documentElement.scrollHeight - window.innerHeight >= target;
  };
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const type of USER_INPUT) window.removeEventListener(type, stop, true);
  };
  const tick = () => {
    if (stopped) return;
    if (apply() || performance.now() - start > RESTORE_WINDOW_MS) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  for (const type of USER_INPUT) window.addEventListener(type, stop, true);
  if (apply()) {
    stop();
  } else {
    frame = requestAnimationFrame(tick);
  }
  return stop;
}
