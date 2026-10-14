import { useRef } from "react";
import type { SearchFilters as Filters, MultiFilterKey } from "../../../../helpers/search";
import type { FacetData } from "../../types";
import {
  TUMOR_OPTIONS,
  SEX_OPTIONS,
  AGE_OPTIONS,
  FACET_GROUPS,
} from "../../constants";
import styles from "./FilterPanel.module.css";

const pillClass = (active: boolean) =>
  `${styles.pill} ${active ? styles.pillActive : ""}`;

// The number is read as "(1,234 cases)" instead, so a year and its count are
// not spoken as one number.
function CountBadge({ count }: { count: number | null }) {
  if (count == null) return null;
  const text = count.toLocaleString();
  return (
    <span className={styles.countBadge}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only"> ({text} {count === 1 ? "case" : "cases"})</span>
    </span>
  );
}

// Each group is named by its title, so a pill is read with the group it is in.
const labelId = (key: string) => `dataset-filter-${key}-label`;

interface Props {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  facetData: FacetData | null;
  // True when the options failed to load; the panel offers Retry.
  facetError?: boolean;
  onRetryFacets?: () => void;
  toggleMulti: (key: MultiFilterKey, value: string) => void;
}

export default function FilterPanel({
  filters,
  setFilters,
  facetData,
  facetError = false,
  onRetryFacets,
  toggleMulti,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const failed = facetError && !facetData;
  const retry = () => {
    // Retry goes away while the options load, so focus moves to the first pill.
    panelRef.current?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.focus();
    onRetryFacets?.();
  };
  const facetCount = (field: string, value: string | number): number | null => {
    const rows = facetData?.counts[field];
    if (!rows) return null;
    const row = rows.find((r) => String(r.value) === String(value));
    return row ? row.count : 0;
  };

  return (
    <div className={styles.filterPanel} id="dataset-filters" aria-label="Advanced filters" ref={panelRef}>
      {failed && (
        <p className={styles.facetsError} role="alert">
          Couldn't load options.
          <button type="button" onClick={retry} className={styles.facetsRetry}>
            Retry
          </button>
        </p>
      )}

      {/* Tumor */}
      <div className="flex flex-col gap-2.5" role="group" aria-labelledby={labelId("tumor")}>
        <span className={styles.filterLabel} id={labelId("tumor")}>Tumor</span>
        <div className="flex flex-wrap gap-2">
          {TUMOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={filters.tumor === opt.value}
              className={pillClass(filters.tumor === opt.value)}
              onClick={() => setFilters((f) => ({ ...f, tumor: opt.value }))}
            >
              {opt.label}
              <CountBadge
                count={
                  opt.value === "tumor"
                    ? facetCount("tumor", 1)
                    : opt.value === "no_tumor"
                      ? facetCount("tumor", 0)
                      : null
                }
              />
            </button>
          ))}
        </div>
      </div>

      {/* Sex */}
      <div className="flex flex-col gap-2.5" role="group" aria-labelledby={labelId("sex")}>
        <span className={styles.filterLabel} id={labelId("sex")}>Sex</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={filters.sex.length === 0}
            className={pillClass(filters.sex.length === 0)}
            onClick={() => setFilters((f) => ({ ...f, sex: [] }))}
          >
            Any
          </button>
          {SEX_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={filters.sex.includes(opt.value)}
              className={pillClass(filters.sex.includes(opt.value))}
              onClick={() => toggleMulti("sex", opt.value)}
            >
              {opt.label}
              <CountBadge
                count={
                  opt.value === "UNKNOWN"
                    ? (facetData?.unknown.sex ?? null)
                    : facetCount("sex", opt.value)
                }
              />
            </button>
          ))}
        </div>
      </div>

      {/* Age */}
      <div className="flex flex-col gap-2.5" role="group" aria-labelledby={labelId("age")}>
        <span className={styles.filterLabel} id={labelId("age")}>Age</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={filters.age.length === 0}
            className={pillClass(filters.age.length === 0)}
            onClick={() => setFilters((f) => ({ ...f, age: [] }))}
          >
            Any
          </button>
          {AGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={filters.age.includes(opt.value)}
              className={pillClass(filters.age.includes(opt.value))}
              onClick={() => toggleMulti("age", opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Facets: tumor type / manufacturer / CT phase / site / year */}
      {FACET_GROUPS.map((g) => {
        const rows = facetData?.counts[g.field] ?? [];
        const selected = filters[g.key];
        return (
          <div
            key={g.key}
            className="flex flex-col gap-2.5"
            role="group"
            aria-labelledby={labelId(g.key)}
          >
            <span className={styles.filterLabel} id={labelId(g.key)}>{g.title}</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={selected.length === 0}
                className={pillClass(selected.length === 0)}
                onClick={() => setFilters((f) => ({ ...f, [g.key]: [] }))}
              >
                Any
              </button>
              {rows.length === 0 ? (
                // After a failure the line above says so; no group waits forever.
                failed ? null : (
                  <span className={styles.facetsLoading}>
                    {facetData ? "—" : "Loading…"}
                  </span>
                )
              ) : (
                rows.map((r) => {
                  const val = String(r.value);
                  return (
                    <button
                      key={val}
                      type="button"
                      aria-pressed={selected.includes(val)}
                      className={pillClass(selected.includes(val))}
                      onClick={() => toggleMulti(g.key, val)}
                    >
                      {r.label ?? val}
                      <CountBadge count={r.count} />
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
