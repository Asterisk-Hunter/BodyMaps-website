import { useRef } from "react";
import { useDashboard } from "./hooks/useDashboard";
import LibraryHeader from "./components/LibraryHeader";
import SearchBar from "./components/SearchBar";
import FilterPanel from "./components/FilterPanel";
import ResultsSummary from "./components/ResultsSummary";
import CaseGrid from "./components/CaseGrid";
import Pagination from "./components/Pagination";
import CompareTray, { type CompareTrayHandle } from "./components/CompareTray";
import styles from "./Homepage.module.css";
import { PER_PAGE } from "./constants";

export default function Homepage() {
  const dash = useDashboard();
  // Clear filters and the tray's Clear unmount with focus on them, and paging
  // swaps the cards and scrolls to the top away from the pager. This region
  // outlives each swap, so focus goes here.
  const resultsRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<CompareTrayHandle>(null);
  const focusResults = () => resultsRef.current?.focus({ preventScroll: true });
  const resetFilters = () => {
    dash.handleResetFilters();
    focusResults();
  };
  const goToPage = (p: number) => {
    dash.goToPage(p);
    focusResults();
  };
  const clearCompare = () => {
    dash.handleClearCompare();
    focusResults();
  };

  // Always mounted, so the first pick is announced too (the tray itself only
  // exists once something is picked).
  const compareStatus =
    dash.compareIds.length === 0
      ? ""
      : dash.compareIds.length === 1
        ? "1 of 2 cases selected"
        : "2 cases selected, Compare is ready";

  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="dataset-title">
        <div className={styles.heading}>
          <span className={styles.eyebrow}>Explore</span>
          <h1 id="dataset-title">Dataset</h1>
          <p>Browse the CT library in 2D and 3D.</p>
        </div>
        <div className={styles.libraryCard}>
          <LibraryHeader
            showSaved={dash.showSaved}
            setShowSaved={dash.setShowSaved}
            savedCases={dash.savedCases}
            onBrowseAll={dash.handleBrowseAll}
            onShuffle={dash.handleShuffle}
          />

          <SearchBar
            searchId={dash.searchId}
            setSearchId={dash.setSearchId}
            searchError={dash.searchError}
            rejectCount={dash.searchRejectCount}
            showFilters={dash.showFilters}
            setShowFilters={dash.setShowFilters}
            activeFilterCount={dash.activeFilterCount}
            onSearch={dash.handleSearch}
          />

          {dash.showFilters && (
            <FilterPanel
              filters={dash.filters}
              setFilters={dash.setFilters}
              facetData={dash.facetData}
              facetError={dash.facetError}
              onRetryFacets={dash.retryFacets}
              toggleMulti={dash.toggleMulti}
            />
          )}

        </div>

        {dash.showSaved && (
          <p className={styles.collectionLabel} role="status">
            {dash.savedCases.length} saved {dash.savedCases.length === 1 ? "case" : "cases"}
          </p>
        )}
        {!dash.showSaved && dash.resultCount === null && (
          <p className={styles.collectionLabel}>Explore the library</p>
        )}
        {!dash.showSaved && dash.resultCount !== null && (
          <ResultsSummary
            resultCount={dash.resultCount}
            page={dash.page}
            onReset={resetFilters}
          />
        )}

        <div ref={resultsRef} tabIndex={-1} role="region" aria-label="Cases" className={styles.results}>
          {/* The tray is fixed on screen but last in the page; this stays out of
              sight until it has keyboard focus. */}
          {dash.compareIds.length > 0 && (
            <button
              type="button"
              className="design-skip-link"
              onClick={() => trayRef.current?.focus()}
            >
              Go to compare bar
            </button>
          )}
          {!dash.showSaved && dash.error && <p className={styles.error} role="alert">{dash.error}</p>}

          <CaseGrid
            showSaved={dash.showSaved}
            savedCases={dash.savedCases}
            loading={dash.loading}
            skeletonCount={dash.skeletonCount}
            resultCount={dash.resultCount}
            previewIds={dash.previewIds}
            previewMetadata={dash.previewMetadata}
            savedIds={dash.savedIds}
            compareIds={dash.compareIds}
            onToggleSave={dash.handleToggleSave}
            onToggleCompare={dash.toggleCompare}
          />
        </div>

        {!dash.showSaved && dash.resultCount !== null && dash.resultCount > PER_PAGE && (
          <Pagination
            page={dash.page}
            resultCount={dash.resultCount}
            pageInput={dash.pageInput}
            setPageInput={dash.setPageInput}
            onGoToPage={goToPage}
          />
        )}
      </section>

      {dash.compareIds.length > 0 && (
        <CompareTray
          ref={trayRef}
          compareIds={dash.compareIds}
          compareTyped={dash.compareTyped}
          setCompareTyped={dash.setCompareTyped}
          compareError={dash.compareError}
          onSubmitTyped={dash.submitTypedCompare}
          onClear={clearCompare}
          onCompare={dash.handleCompare}
        />
      )}
      <p role="status" className="sr-only">
        {compareStatus}
      </p>
    </div>
  );
}
