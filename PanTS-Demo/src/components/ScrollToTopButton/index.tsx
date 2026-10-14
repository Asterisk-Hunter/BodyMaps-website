import { useEffect, useState, type CSSProperties } from "react";
import { useLocation } from "react-router-dom";
import { IconArrowUp } from "@tabler/icons-react";
import { pageScrollTop, scrollPageToTop } from "../../helpers/pageScroll";
import styles from "./ScrollToTopButton.module.css";

const SCROLL_THRESHOLD = 300;

/** How far the workspace footer reaches up into the window, in px (0 when there is none). */
function footerOverlap(): number {
  const footer = document.querySelector<HTMLElement>(".design-footer");
  if (!footer) return 0;
  const { top, height } = footer.getBoundingClientRect();
  if (!height) return 0;
  return Math.max(0, Math.round(window.innerHeight - top));
}

export default function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);
  // The workspace footer sits on the bottom edge of the window, under this
  // button's corner; the button rides this far higher so it never covers the
  // footer's contact link.
  const [lift, setLift] = useState(0);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => {
      setVisible(pageScrollTop() > SCROLL_THRESHOLD);
      setLift(footerOverlap());
    };
    onScroll();
    // Element scroll events do not bubble. Capture them so this also observes a
    // shell mounted later by a lazy route or restored authenticated session.
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [pathname]);

  const scrollToTop = () => {
    scrollPageToTop();
    // The button disables itself at the top, which would drop keyboard focus
    // to <body>; hand it to the start of the page content instead.
    const target =
      document.getElementById("workspace-content") ?? document.querySelector<HTMLElement>("main");
    if (target) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  };

  return (
    <button
      type="button"
      className={`${styles.btn} ${visible ? styles.visible : ""}`}
      style={lift ? ({ "--footer-lift": `${lift}px` } as CSSProperties) : undefined}
      onClick={scrollToTop}
      aria-label="Scroll to top"
      aria-hidden={!visible}
      disabled={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <IconArrowUp size={24} aria-hidden="true" />
    </button>
  );
}
