import { useEffect, useRef } from "react";
import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconSearch,
} from "@tabler/icons-react";
import { cleanCaseInput } from "../../caseInput";
import styles from "./SearchBar.module.css";

interface Props {
  // What is in the field; empty means Search applies the filters.
  searchId: string;
  setSearchId: (value: string) => void;
  searchError?: string | null;
  // Bumps on every rejected Search, even when the message is unchanged.
  rejectCount?: number;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  activeFilterCount: number;
  onSearch: () => void;
}

export default function SearchBar({
  searchId,
  setSearchId,
  searchError = null,
  rejectCount = 0,
  showFilters,
  setShowFilters,
  activeFilterCount,
  onSearch,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // A rejected search puts the cursor back in the field that needs changing,
  // every time and not only when the message changes.
  useEffect(() => {
    if (searchError) inputRef.current?.focus();
  }, [searchError, rejectCount]);
  return (
    <>
      <div className={styles.searchRow}>
        <div className={styles.inputWrap}>
          <IconSearch size={18} className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            aria-label="Search by case number"
            aria-invalid={searchError ? true : undefined}
            aria-describedby={searchError ? "dataset-search-error" : undefined}
            placeholder="Search by case number, e.g. 17, 121, 9902"
            className={styles.searchInput}
            value={searchId}
            // Keeps an id pasted from a card (PanTS_00000017, CV_00000001) and
            // drops only spaces and a card number's "#" and commas; Search says
            // what is wrong with anything else instead of the field eating it.
            onChange={(e) => setSearchId(cleanCaseInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearch();
            }}
          />
        </div>
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls="dataset-filters"
          onClick={() => setShowFilters((v) => !v)}
          className={`${styles.filterToggle} ${showFilters ? styles.filterToggleOpen : ""}`}
        >
          <span className="flex items-center gap-2">
            <IconAdjustmentsHorizontal size={15} aria-hidden="true" />
            Advanced filters
            {activeFilterCount > 0 && (
              <span className={styles.filterBadge}>
                {activeFilterCount}
                <span className="sr-only"> selected</span>
              </span>
            )}
          </span>
          <IconChevronDown
            size={15}
            aria-hidden="true"
            className={`${styles.chevron} ${showFilters ? styles.chevronOpen : ""}`}
          />
        </button>
        <button type="button" className={styles.searchBtn} onClick={onSearch}>
          Search
        </button>
      </div>
      {/* Mounted even when empty, so a screen reader announces the message
          when it arrives. A repeat of the same message gets a trailing
          non-breaking space on alternate rejections, so the text changes and
          it is read again. */}
      <p
        id="dataset-search-error"
        aria-live="polite"
        className={searchError ? styles.searchError : "sr-only"}
      >
        {searchError ? searchError + (rejectCount % 2 === 0 ? " " : "") : null}
      </p>
    </>
  );
}
