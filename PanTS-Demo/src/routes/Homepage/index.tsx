import { useDashboard } from "./hooks/useDashboard";
import LibraryHeader from "./components/LibraryHeader";
import SearchBar from "./components/SearchBar";
import FilterPanel from "./components/FilterPanel";
import ResultsSummary from "./components/ResultsSummary";
import CaseGrid from "./components/CaseGrid";
import Pagination from "./components/Pagination";
import CompareTray from "./components/CompareTray";
import styles from "./Homepage.module.css";
import { PER_PAGE } from "./constants";

export default function Homepage() {
  const dash = useDashboard();

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
            onReset={dash.handleResetFilters}
          />
        )}

        {!dash.showSaved && dash.error && <p className={styles.error} role="alert">{dash.error}</p>}

        <CaseGrid
          showSaved={dash.showSaved}
          savedCases={dash.savedCases}
          loading={dash.loading}
          resultCount={dash.resultCount}
          previewIds={dash.previewIds}
          previewMetadata={dash.previewMetadata}
          savedIds={dash.savedIds}
          compareIds={dash.compareIds}
          onToggleSave={dash.handleToggleSave}
          onToggleCompare={dash.toggleCompare}
        />

        {!dash.showSaved && dash.resultCount !== null && dash.resultCount > PER_PAGE && (
          <Pagination
            page={dash.page}
            resultCount={dash.resultCount}
            pageInput={dash.pageInput}
            setPageInput={dash.setPageInput}
            onGoToPage={dash.goToPage}
          />
        )}
      </section>

      {dash.compareIds.length > 0 && (
        <CompareTray
          compareIds={dash.compareIds}
          compareTyped={dash.compareTyped}
          setCompareTyped={dash.setCompareTyped}
          onSubmitTyped={dash.submitTypedCompare}
          onClear={dash.handleClearCompare}
          onCompare={dash.handleCompare}
        />
      )}
    </div>
  );
}
