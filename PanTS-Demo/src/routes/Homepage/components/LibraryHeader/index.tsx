import {
  IconArrowsShuffle,
  IconBookmark,
  IconChartBar,
  IconDatabase,
} from "@tabler/icons-react";
import { Link, useLocation } from "react-router-dom";
import type { SavedCase } from "../../../../helpers/savedCases";
import { statisticsHref } from "../../../../helpers/statisticsLink";
import styles from "./LibraryHeader.module.css";

interface Props {
  showSaved: boolean;
  setShowSaved: React.Dispatch<React.SetStateAction<boolean>>;
  savedCases: SavedCase[];
  onBrowseAll: () => void;
  onShuffle: () => void;
}

export default function LibraryHeader({
  showSaved,
  setShowSaved,
  savedCases,
  onBrowseAll,
  onShuffle,
}: Props) {
  // The statistics of the search on screen: the URL carries its filters.
  const { search } = useLocation();
  return (
    <div className={styles.sectionHeader}>
      <span>Browse Library</span>
      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={onBrowseAll}>
          <IconDatabase size={14} aria-hidden="true" />
          Browse all
        </button>
        <button type="button" className={styles.actionBtn} onClick={onShuffle}>
          <IconArrowsShuffle size={14} aria-hidden="true" />
          Shuffle Cases
        </button>
        <Link to={statisticsHref(search)} className={styles.actionBtn}>
          <IconChartBar size={14} aria-hidden="true" />
          Statistics
        </Link>
        <button
          type="button"
          aria-pressed={showSaved}
          className={`${styles.actionBtn} ${showSaved ? styles.actionBtnActive : ""}`}
          onClick={() => setShowSaved((v) => !v)}
        >
          <IconBookmark size={14} aria-hidden="true" />
          {showSaved
            ? "Back to browse"
            : `Saved${savedCases.length ? ` (${savedCases.length})` : ""}`}
        </button>
      </div>
    </div>
  );
}
