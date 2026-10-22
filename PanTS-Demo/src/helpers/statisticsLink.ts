// The link from the library to the Statistics page for the scans the library is showing.

import { buildSearchParams, countActiveFilters, parseFiltersFromParams } from "./search";

/** /statistics with the filters the given library query string names (the library's own params), so the
 *  charts describe exactly the list on screen. Paging, sorting and the like are left behind. */
export const statisticsHref = (search: string): string => {
	const filters = parseFiltersFromParams(new URLSearchParams(search));
	if (countActiveFilters(filters) === 0) return "/statistics";
	const params = buildSearchParams({ ...filters, dataset: [] });
	params.delete("dataset");
	return `/statistics?${params.toString()}`;
};
