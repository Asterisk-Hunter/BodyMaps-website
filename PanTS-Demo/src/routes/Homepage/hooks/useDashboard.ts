import { type SetStateAction, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import {
  buildSearchParams,
  type CaseId,
  caseIdToApiId,
  countActiveFilters,
  EMPTY_FILTERS,
  itemToId,
  type MultiFilterKey,
  parseFiltersFromParams,
  type SearchFilters as Filters,
  type SearchItem,
} from "../../../helpers/search";
import {
  caseNumberToCaseId,
  caseNumberToPath,
  PANTS_CASE_COUNT,
} from "../../../helpers/caseNumbering";
import { prefetchViewer } from "../../../helpers/prefetchViewer";
import { fetchCurated, getCachedCurated } from "../../../helpers/curatedCache";
import {
  loadSavedCases,
  SAVED_CASES_EVENT,
  type SavedCase,
  toggleSavedCase,
} from "../../../helpers/savedCases";
import type { PreviewType } from "../../../types";
import { API_BASE } from "../../../helpers/constants";
import { CARD_COUNT, PER_PAGE } from "../constants";
import type { FacetData } from "../types";
import { track } from "../../../helpers/analytics";
import { scrollPageToTop } from "../../../helpers/pageScroll";
import { cleanCaseInput, parseCaseInput } from "../caseInput";

// Pure so it can seed both the lazy initial state (skips the first-paint skeleton
// entirely when the curated cache is already warm) and the post-fetch ingest path.
function toPreviewData(items: SearchItem[]) {
  const ids: CaseId[] = [];
  const meta: { [key: string]: PreviewType } = {};
  for (const it of items) {
    const id = itemToId(it);
    if (!id) continue;
    ids.push(id);
    meta[id] = {
      sex: it.sex ?? "",
      age: Number(it.age) || 0,
      tumor: it.tumor === 1 ? 1 : it.tumor === 0 ? 0 : null,
      tumorLabel: it.tumor === 1 ? (it["tumor label"] ?? null) : null,
    };
  }
  return { ids, meta };
}

// The cards of the last Shuffle, kept in the history entry's state: the URL is
// just /dashboard for them, so Back from a shuffled case would otherwise find
// nothing to rebuild the strip from and show the curated cases instead.
type ShuffleState = { items: SearchItem[]; recent: CaseId[] };

function readShuffleState(state: unknown): ShuffleState | null {
  const shuffle = (state as { shuffle?: Partial<ShuffleState> } | null)?.shuffle;
  if (!shuffle || !Array.isArray(shuffle.items) || shuffle.items.length === 0) return null;
  return { items: shuffle.items, recent: Array.isArray(shuffle.recent) ? shuffle.recent : [] };
}

export function useDashboard() {
  const navigation = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialShuffle = readShuffleState(location.state);
  const [filters, setFilters] = useState<Filters>(() => parseFiltersFromParams(searchParams));
  // The paged list rather than the featured strip: filters in the URL, or
  // Browse all (browse=1, see syncListUrl).
  const initialList = countActiveFilters(filters) > 0 || searchParams.get("browse") === "1";
  // Only the curated (no-filter) view is cacheable; a filtered/deep-linked URL
  // always does a live fetch, same as before. `filters` was just initialized from
  // the same searchParams, so reuse it instead of re-parsing.
  const initialCached = initialList || initialShuffle ? null : getCachedCurated();
  const initialItems = initialShuffle && !initialList ? initialShuffle.items : initialCached;
  const initialData = initialItems ? toPreviewData(initialItems) : null;
  const [previewIds, setPreviewIds] = useState<CaseId[]>(initialData?.ids ?? []);
  const [previewMetadata, setPreviewMetadata] = useState<{ [key: string]: PreviewType }>(
    initialData?.meta ?? {},
  );
  const [loading, setLoading] = useState(!initialData);
  // Cards the pending request will bring (featured strip, a full page, or the
  // short last page), so the skeleton grid is as tall as what replaces it.
  const [skeletonCount, setSkeletonCount] = useState(initialList ? PER_PAGE : CARD_COUNT);
  const [error, setError] = useState<string | null>(null);
  // What was typed or pasted in the search box: a case number or an id copied
  // from a card. Empty means Search applies the filters.
  const [searchId, setSearchId] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  // Counts every rejected Search, so pressing it again with the same bad input
  // still moves focus back and is announced again (the message alone would not
  // change).
  const [searchRejectCount, setSearchRejectCount] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [facetData, setFacetData] = useState<FacetData | null>(null);
  const [facetError, setFacetError] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [recentShuffleIds, setRecentShuffleIds] = useState<CaseId[]>(
    initialShuffle?.recent ?? [],
  );

  const [savedCases, setSavedCases] = useState<SavedCase[]>(loadSavedCases);
  // Saved is a view of the dashboard URL (saved=1), so Back from a saved case
  // comes back to it. The list the URL held before is put back on the way out.
  const [showSaved, setShowSavedState] = useState(() => searchParams.get("saved") === "1");
  const listUrlBeforeSavedRef = useRef("");
  // The entry's state goes with it, so a shuffled strip is still one after
  // Saved is toggled on and off.
  const listStateBeforeSavedRef = useRef<unknown>(undefined);
  // True while no list has loaded since the URL named Saved, so leaving Saved
  // has to load one.
  const listSkippedRef = useRef(showSaved);
  const savedIds = new Set(savedCases.map((c) => c.id));

  // Keep in sync when a bookmark is toggled here or in another tab.
  useEffect(() => {
    const refresh = () => setSavedCases(loadSavedCases());
    window.addEventListener(SAVED_CASES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SAVED_CASES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleToggleSave = (id: CaseId, meta?: PreviewType) => {
    const m = meta ?? previewMetadata[id];
    toggleSavedCase({
      id,
      sex: m?.sex ?? "",
      age: m?.age ?? 0,
      tumor: m?.tumor ?? null,
      tumorLabel: m?.tumorLabel ?? null,
    });
  };

  // Cases picked for side-by-side comparison (max 2). Adding a third drops the oldest.
  const [compareIds, setCompareIds] = useState<CaseId[]>([]);
  const [compareTyped, setCompareTyped] = useState("");
  const [compareError, setCompareError] = useState<string | null>(null);

  const toggleCompare = (id: CaseId) => {
    // The tray's field unmounts at two cases and comes back below that, so a
    // half-typed case or its error would otherwise come back with it.
    setCompareTyped("");
    setCompareError(null);
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2),
    );
  };

  const addCompareId = (id: CaseId) => {
    setCompareIds((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-2)));
  };

  // A stale message goes as soon as the field is edited.
  const handleSetCompareTyped = (value: string) => {
    setCompareError(null);
    setCompareTyped(value);
  };

  // Takes what the search box takes: a number on the same running scale (9,902
  // is CV_00000001, 34,324 is BDMAP_00000001, past the end is the last case) or a PanTS_, CV_
  // or BDMAP_ id.
  // Resolves to whether the case was added.
  const submitTypedCompare = async (): Promise<boolean> => {
    const input = parseCaseInput(compareTyped);
    if (!input) return false;
    if (input.kind === "invalid") {
      setCompareError(input.message);
      return false;
    }
    let id: CaseId | null = input.kind === "id" ? input.id : input.n;
    if (input.kind === "number" && input.n > PANTS_CASE_COUNT) {
      id = await caseNumberToCaseId(input.n, API_BASE);
    }
    if (id === null) return false;
    if (compareIds.includes(id)) {
      // Keep what was typed: an emptied field reads as if the add worked.
      setCompareError(`Case ${cleanCaseInput(compareTyped)} is already selected.`);
      return false;
    }
    addCompareId(id);
    setCompareError(null);
    setCompareTyped("");
    return true;
  };

  const handleClearCompare = () => {
    setCompareIds([]);
    setCompareTyped("");
    setCompareError(null);
  };

  const ingestItems = (items: SearchItem[]) => {
    const { ids, meta } = toPreviewData(items);
    listSkippedRef.current = false;
    setPreviewMetadata(meta);
    setPreviewIds(ids);
    setLoading(false);
    return ids;
  };

  // Monotonic sequence shared by every grid fetch (curated / search / shuffle) so
  // a slow, superseded response can never overwrite a newer request's results.
  const requestSeq = useRef(0);
  // The last APPLIED filter set. Pill edits mutate `filters` immediately (they're
  // draft state until Apply/Search), so pagination must not read `filters` directly.
  const appliedFiltersRef = useRef<Filters>(filters);

  // Curated cases: fullest-body scans split half tumor / half no-tumor, interleaved.
  // Reads the shared module-scope cache first: if the app-boot idle warm-up (or an
  // earlier mount) already resolved it, this renders synchronously from memory with
  // no spinner and no network round trip -- the fix for Team/Overview -> Dataset
  // tab switches paying a full refetch every time despite the data being static.
  const loadCurated = async () => {
    const reqId = ++requestSeq.current;
    setError(null);
    const cached = getCachedCurated();
    if (cached) {
      ingestItems(cached);
      return;
    }
    setSkeletonCount(CARD_COUNT);
    setLoading(true);
    setPreviewMetadata({});
    try {
      const items = await fetchCurated();
      if (reqId !== requestSeq.current) return;
      ingestItems(items);
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setError("The library could not be loaded. Try Browse all or Shuffle cases again.");
      setLoading(false);
    }
  };

  // The filters of the list whose count the summary and pager describe.
  const shownListRef = useRef<string | null>(null);
  const runSearch = async (f: Filters, p = 1, expected = PER_PAGE) => {
    const reqId = ++requestSeq.current;
    // A different list replaces the one on screen, so its count and page would
    // be wrong for the whole request (and the pager would page the new filters
    // with the old total). Paging the same list keeps them.
    const listKey = buildSearchParams(f).toString();
    if (shownListRef.current !== listKey) {
      setResultCount(null);
      // A page typed for the old list means nothing for this one.
      setPageInput("");
    }
    setError(null);
    setSkeletonCount(expected);
    setLoading(true);
    setPreviewMetadata({});
    try {
      const params = buildSearchParams(f, { sortBy: "quality", perPage: PER_PAGE });
      params.set("page", String(p));
      const res = await fetch(`${API_BASE}/api/search?${params.toString()}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      if (reqId !== requestSeq.current) return;
      const total = data.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      setResultCount(total);
      shownListRef.current = listKey;
      // Clamp against the fresh total so a page past the end can't render
      // summaries like "5 results, page 2 of 1".
      setPage(Math.min(data.page ?? p, pages));
      ingestItems(data.items ?? []);
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setError("The search could not be completed. Please try again.");
      setLoading(false);
    }
  };

  // What this hook last wrote to the URL. A search string that differs from it
  // was put there from outside (the Dataset link, Back), and the list follows it.
  const ownSearchRef = useRef(searchParams.toString());
  // Whether the strip on screen is a shuffled one, so a click that clears the
  // entry's shuffle state (the Dataset link on the same URL) can reset it too.
  const shuffledRef = useRef(initialShuffle !== null && !initialList);
  const firstRun = useRef(true);
  const writeUrl = (params: URLSearchParams | Record<string, string>, state?: unknown) => {
    const next = new URLSearchParams(params);
    ownSearchRef.current = next.toString();
    shuffledRef.current = readShuffleState(state) !== null;
    setSearchParams(next, { replace: true, state });
  };
  // A response that lands after the page was left must not navigate: the write
  // would replace whatever page the reader moved on to.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The paged list's place goes in the URL (replacing the entry, not adding
  // one): the applied filters, or browse=1 for Browse all, plus the page past
  // the first. Back from a case, a refresh or a shared link then comes back
  // to the same page of the same list, not page 1 or the featured strip.
  const syncListUrl = (f: Filters, p: number) => {
    const params =
      countActiveFilters(f) > 0 ? buildSearchParams(f) : new URLSearchParams({ browse: "1" });
    if (p > 1) params.set("page", String(p));
    writeUrl(params);
  };

  // Same signature as a state setter, for the Saved button. Turning it on puts
  // saved=1 in the URL; turning it off restores the list URL it replaced, or
  // lets the URL effect load the list when none was loaded under Saved.
  const setShowSaved = (value: SetStateAction<boolean>) => {
    const next = typeof value === "function" ? value(showSaved) : value;
    if (next === showSaved) return;
    setShowSavedState(next);
    if (next) {
      listUrlBeforeSavedRef.current = searchParams.toString();
      listStateBeforeSavedRef.current = location.state;
      writeUrl({ saved: "1" });
    } else if (listSkippedRef.current) {
      setSearchParams(new URLSearchParams(listUrlBeforeSavedRef.current), {
        replace: true,
        state: listStateBeforeSavedRef.current,
      });
    } else {
      writeUrl(new URLSearchParams(listUrlBeforeSavedRef.current), listStateBeforeSavedRef.current);
    }
  };

  const goToPage = (p: number) => {
    const pages = resultCount ? Math.max(1, Math.ceil(resultCount / PER_PAGE)) : 1;
    const next = Math.min(Math.max(1, p), pages);
    // Paging by Prev, Next or Go leaves no half-typed page behind.
    setPageInput("");
    // The total is known here, so the last page's skeleton can be exact.
    const expected = resultCount
      ? Math.min(PER_PAGE, Math.max(1, resultCount - (next - 1) * PER_PAGE))
      : PER_PAGE;
    // Paginate with the last-applied filters, never with un-applied pill edits.
    syncListUrl(appliedFiltersRef.current, next);
    runSearch(appliedFiltersRef.current, next, expected);
    scrollPageToTop();
  };

  // Facet option lists + baseline counts — fetched once, unfiltered, so available
  // pills and their counts stay stable regardless of which filter is active.
  const loadFacetOptions = async () => {
    try {
      setFacetError(false);
      const params = new URLSearchParams();
      params.set("fields", "tumor,tumor_type,sex,manufacturer,ct_phase,site_nat,year");
      // The API cuts every group but tumor type to top_k values; 64 is above any
      // group's real value count, so no year, site or manufacturer is left
      // without a pill.
      params.set("top_k", "64");
      const res = await fetch(`${API_BASE}/api/facets?${params.toString()}`);
      // An error status is a failure too, not an empty list of options; the
      // panel offers Retry.
      if (!res.ok) throw new Error(`Facets failed (${res.status})`);
      const data = await res.json();
      const counts = data.facets ?? {};
      // The API orders by count; years read newest first.
      if (Array.isArray(counts.year)) {
        counts.year = [...counts.year].sort(
          (a: { value: unknown }, b: { value: unknown }) => Number(b.value) - Number(a.value),
        );
      }
      setFacetData({
        counts,
        unknown: data.unknown_counts ?? {},
        total: data.total ?? 0,
      });
    } catch (e) {
      console.error(e);
      setFacetError(true);
    }
  };

  // Show the list the URL names: its filters or Browse all (at its page), or
  // the curated grid when it names none. runSearch clamps a page past the end
  // against the fresh total.
  const restoreFromUrl = (first: boolean) => {
    setPageInput("");
    const urlFilters = parseFiltersFromParams(searchParams);
    const urlPage = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const saved = searchParams.get("saved") === "1";
    setShowSavedState(saved);
    if (saved) {
      // The saved cards come from storage; the list loads when Saved is left.
      listSkippedRef.current = true;
      setFilters(EMPTY_FILTERS);
      appliedFiltersRef.current = EMPTY_FILTERS;
      return;
    }
    if (countActiveFilters(urlFilters) > 0) {
      // A link with filters opens on the panel that shows them.
      if (first) setShowFilters(true);
      setFilters(urlFilters);
      appliedFiltersRef.current = urlFilters;
      runSearch(urlFilters, urlPage);
    } else if (searchParams.get("browse") === "1") {
      setFilters(EMPTY_FILTERS);
      appliedFiltersRef.current = EMPTY_FILTERS;
      runSearch(EMPTY_FILTERS, urlPage);
    } else {
      setFilters(EMPTY_FILTERS);
      appliedFiltersRef.current = EMPTY_FILTERS;
      setResultCount(null);
      shownListRef.current = null;
      setPage(1);
      // Back to a shuffled view: put its cards back instead of the curated strip.
      const shuffle = readShuffleState(location.state);
      if (shuffle) {
        requestSeq.current++;
        setError(null);
        setRecentShuffleIds(shuffle.recent);
        ingestItems(shuffle.items);
        shuffledRef.current = true;
      } else {
        shuffledRef.current = false;
        loadCurated();
      }
    }
  };

  // On mount, and again when the URL changes without this hook having written
  // it: the sidebar's Dataset link goes to /dashboard, which keeps this page
  // mounted and only empties the query, so the list has to follow or it would
  // show results the URL (and the Clear filters button) no longer know about.
  // The link on a shuffled /dashboard keeps the query but drops the entry's
  // shuffle state, so that too sends the strip back to the curated cards.
  useEffect(() => {
    const now = searchParams.toString();
    const shuffleDropped = shuffledRef.current && readShuffleState(location.state) === null;
    if (now === ownSearchRef.current && !firstRun.current && !shuffleDropped) return;
    const first = firstRun.current;
    firstRun.current = false;
    ownSearchRef.current = now;
    restoreFromUrl(first);
    // The Dataset link swaps a long list for the short strip under the reader's
    // scroll position, so start at the top like Apply and paging do. Back and
    // Forward (POP) and replaces leave the scroll alone.
    if (!first && navigationType === "PUSH") scrollPageToTop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, location.key]);

  // Fetch static option lists the first time the filter panel opens.
  useEffect(() => {
    if (showFilters && !facetData) loadFacetOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFilters]);

  // Warm the code-split viewer chunk while idle so the first case-open is instant.
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback;
    const id = ric ? ric(() => prefetchViewer()) : window.setTimeout(prefetchViewer, 1500);
    return () => {
      if (ric) w.cancelIdleCallback?.(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  const handleShuffle = async () => {
    const reqId = ++requestSeq.current;
    setShowSavedState(false);
    setError(null);
    setSkeletonCount(CARD_COUNT);
    setLoading(true);
    setPreviewMetadata({});
    setResultCount(null);
    shownListRef.current = null;
    setPage(1);
    setPageInput("");
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    writeUrl({});
    try {
      const params = new URLSearchParams({
        n: String(CARD_COUNT),
        k: "120",
        scope: "all",
      });
      if (recentShuffleIds.length) {
        params.set("recent", recentShuffleIds.map(caseIdToApiId).join(","));
      }
      const res = await fetch(`${API_BASE}/api/random?${params.toString()}`);
      if (!res.ok) throw new Error(`Shuffle failed (${res.status})`);
      const data = await res.json();
      if (reqId !== requestSeq.current) return;
      const items: SearchItem[] = data.items ?? [];
      const ids = ingestItems(items);
      const deduped: CaseId[] = [];
      for (const id of [...recentShuffleIds, ...ids]) {
        const existing = deduped.findIndex((candidate) => candidate === id);
        if (existing >= 0) deduped.splice(existing, 1);
        deduped.push(id);
      }
      const recent = deduped.slice(-32);
      setRecentShuffleIds(recent);
      // The cards ride along in this history entry so Back from one of them
      // rebuilds the same set (see readShuffleState). Only while the URL is
      // still the one this shuffle wrote: opening Saved while it was loading
      // put saved=1 there, and writing now would drop it under the Saved view.
      if (mountedRef.current && ownSearchRef.current === "") {
        writeUrl({}, { shuffle: { items, recent } });
      }
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setError("Cases could not be shuffled. Please try again.");
      setLoading(false);
    }
  };

  const handleBrowseAll = () => {
    setShowSavedState(false);
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    syncListUrl(EMPTY_FILTERS, 1);
    runSearch(EMPTY_FILTERS, 1);
  };

  const activeFilterCount = countActiveFilters(filters);

  const toggleMulti = (key: MultiFilterKey, value: string) => {
    setFilters((f) => {
      const has = f[key].includes(value);
      return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
    });
  };

  const handleApplyFilters = () => {
    setShowSavedState(false);
    appliedFiltersRef.current = filters;
    syncListUrl(filters, 1);
    runSearch(filters, 1);
    setShowFilters(false);
  };

  const handleResetFilters = () => {
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    setResultCount(null);
    shownListRef.current = null;
    setPage(1);
    setPageInput("");
    writeUrl({});
    loadCurated();
  };

  const handleSetSearchId = (value: string) => {
    setSearchError(null);
    setSearchId(value);
  };

  const handleSearch = async () => {
    const input = parseCaseInput(searchId);
    if (input?.kind === "invalid") {
      // Not counted as a search: nothing was looked up.
      setSearchError(input.message);
      setSearchRejectCount((c) => c + 1);
      return;
    }
    track("dataset_search");
    if (!input) {
      handleApplyFilters();
      return;
    }
    // A copied id opens that exact case.
    if (input.kind === "id") {
      navigation(`/case/${input.id}`);
      return;
    }
    // One running number: 1-9,901 are PanTS, CancerVerse continues from 9,902, AbdomenAtlas from 34,324.
    const path = await caseNumberToPath(input.n, API_BASE);
    if (path) navigation(path);
  };

  const handleCompare = () => {
    track("dataset_open_compare");
    navigation(`/compare?a=${compareIds[0]}&b=${compareIds[1]}`);
  };

  return {
    previewIds,
    previewMetadata,
    loading,
    skeletonCount,
    error,
    searchId,
    setSearchId: handleSetSearchId,
    searchError,
    searchRejectCount,
    showFilters,
    setShowFilters,
    filters,
    setFilters,
    facetData,
    facetError,
    retryFacets: loadFacetOptions,
    activeFilterCount,
    page,
    pageInput,
    setPageInput,
    resultCount,
    savedCases,
    showSaved,
    setShowSaved,
    savedIds,
    compareIds,
    compareTyped,
    setCompareTyped: handleSetCompareTyped,
    compareError,
    handleToggleSave,
    toggleCompare,
    submitTypedCompare,
    handleClearCompare,
    handleShuffle,
    handleBrowseAll,
    handleResetFilters,
    handleSearch,
    handleCompare,
    goToPage,
    toggleMulti,
  };
}
