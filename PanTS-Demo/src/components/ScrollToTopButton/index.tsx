import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { IconArrowUp } from "@tabler/icons-react";
import { pageScrollTop, scrollPageToTop } from "../../helpers/pageScroll";
import styles from "./ScrollToTopButton.module.css";

const SCROLL_THRESHOLD = 300;

export default function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setVisible(pageScrollTop() > SCROLL_THRESHOLD);
    onScroll();
    // Element scroll events do not bubble. Capture them so this also observes a
    // shell mounted later by a lazy route or restored authenticated session.
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("scroll", onScroll);
    };
  }, [pathname]);

  return (
    <button
      type="button"
      className={`${styles.btn} ${visible ? styles.visible : ""}`}
      onClick={scrollPageToTop}
      aria-label="Scroll to top"
      aria-hidden={!visible}
      disabled={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <IconArrowUp size={24} aria-hidden="true" />
    </button>
  );
}
