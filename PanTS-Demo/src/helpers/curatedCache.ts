import { API_BASE } from "./constants";
import { itemToId, type SearchItem } from "./search";

// Shared, in-memory (module-scope, survives route unmount/remount) cache for the
// server-owned eight-case showcase (tumor / no-tumor, interleaved).
//
// The APIs deliberately use private/no-store caching. Homepage fully
// unmounts on tab switch — so without this, EVERY Overview/Team -> Dataset switch
// paid a fresh network round trip + a loading-spinner flash, even though the data
// is deterministic and was already fetched moments earlier by the idle warm-up.
// This module is the single source of truth for that fetch; both the App-level
// warm-up and useDashboard's mount effect read/write it, so whichever runs first
// wins and the other gets an instant synchronous hit.
let cachedItems: SearchItem[] | null = null;
let inFlight: Promise<SearchItem[]> | null = null;

const UNKNOWN_DEMOGRAPHIC_VALUES = new Set([
  "",
  "-",
  "--",
  "—",
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
]);

function hasKnownDemographicValue(value: string | number | null | undefined): boolean {
  if (value == null) return false;
  return !UNKNOWN_DEMOGRAPHIC_VALUES.has(String(value).trim().toLowerCase());
}

/** Return gallery items with complete age and sex information first, preserving ties. */
export function prioritizeKnownDemographics(items: SearchItem[]): SearchItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aKnown = hasKnownDemographicValue(a.item.age) && hasKnownDemographicValue(a.item.sex);
      const bKnown = hasKnownDemographicValue(b.item.age) && hasKnownDemographicValue(b.item.sex);
      return Number(bKnown) - Number(aKnown) || a.index - b.index;
    })
    .map(({ item }) => item);
}

function doFetch(): Promise<SearchItem[]> {
  return fetch(`${API_BASE}/api/showcase`, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) throw new Error("curated fetch failed");
      const result = await response.json();
      const items: SearchItem[] = Array.isArray(result.items) ? result.items : [];
      // The server owns BOTH display order and guest admission. Never fall back
      // to search results, which are not an access grant.
      const ids = items.map((item) => String(itemToId(item)));
      if (items.length !== 8 || new Set(ids).size !== 8 || items.some((item) =>
        item.dataset !== "PanTS" || !/^[1-9][0-9]{0,3}$/.test(String(itemToId(item))) ||
        Number(itemToId(item)) > 9901
      )) throw new Error("invalid showcase response");
      cachedItems = items;
      return items;
    });
}

/** Synchronous read — null if nothing has resolved yet. */
export function getCachedCurated(): SearchItem[] | null {
  return cachedItems;
}

/**
 * Kick off (or join) the curated fetch. Safe to call repeatedly — de-duped via
 * `inFlight` so the idle warm-up and an impatient mount effect never double-fetch.
 */
export function fetchCurated(): Promise<SearchItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (inFlight) return inFlight;
  inFlight = doFetch().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Warm the cache and preload preview images. Called once shortly after app boot
 * (idle time) so a later Dataset tab visit renders from memory.
 */
let warmStarted = false;
export function warmCuratedCache(): void {
  if (warmStarted || typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }
  warmStarted = true;
  fetchCurated()
    .then((items) => {
      for (const it of items) {
        const id = itemToId(it);
        if (!id) continue;
        const img = new Image();
        img.src = `${API_BASE}/api/get_image_preview/${id}`;
      }
    })
    .catch(() => {});
}
