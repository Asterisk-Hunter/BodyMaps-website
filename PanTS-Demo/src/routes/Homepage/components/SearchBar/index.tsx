import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconSearch,
} from "@tabler/icons-react";
import styles from "./SearchBar.module.css";

interface Props {
  searchId: number;
  setSearchId: (n: number) => void;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  activeFilterCount: number;
  onSearch: () => void;
}

export default function SearchBar({
  searchId,
  setSearchId,
  showFilters,
  setShowFilters,
  activeFilterCount,
  onSearch,
}: Props) {
  return (
    <div className={styles.searchRow}>
      <div className={styles.inputWrap}>
        <IconSearch size={18} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="text"
          inputMode="numeric"
          aria-label="Search by case number"
          placeholder="Search by case number, e.g. 17, 121, 9902"
          className={styles.searchInput}
          value={searchId || ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" || /^\d+$/.test(val)) {
              setSearchId(val ? Number(val) : 0);
            }
          }}
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
          <IconAdjustmentsHorizontal size={15} />
          Advanced filters
          {activeFilterCount > 0 && (
            <span className={styles.filterBadge}>{activeFilterCount}</span>
          )}
        </span>
        <IconChevronDown
          size={15}
          className={`${styles.chevron} ${showFilters ? styles.chevronOpen : ""}`}
        />
      </button>
      <button type="button" className={styles.searchBtn} onClick={onSearch}>
        Search
      </button>
    </div>
  );
}
