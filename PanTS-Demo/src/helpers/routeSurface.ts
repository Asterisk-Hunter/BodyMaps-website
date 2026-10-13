// helpers/routeSurface.ts
//
// Which routes paint on a dark surface: the case viewer and the other
// full-screen dark tools (live rooms, quiz practice, the compare page and
// the compare viewer). Every other page is light. index.html runs this same
// pattern inline before the first paint, so a hard load never flashes the
// wrong colour; keep the two in sync.
// Each pattern needs the segment shape its route needs (see App.tsx), so a
// path that only starts like a viewer route ("/case/", "/learn/x",
// "/case/12/extra") has no route and stays light while it is sent to the
// workspace. The patterns ignore case because the router does ("/Case/35"
// renders the viewer).

export const DARK_ROUTE_PATTERN =
	/\/(case|session|reconstruction|live)\/[^/]+\/*$|\/live\/challenge\/[^/]+\/*$|\/learn\/quiz\/[^/]+\/*$|\/(dicom|local-nifti|compare|compare-viewer)\/*$/i;

/** Class on <html> while a dark route is showing. */
export const DARK_ROUTE_CLASS = "bm-dark-route";

export function isDarkRoute(pathname: string): boolean {
	return DARK_ROUTE_PATTERN.test(pathname);
}
