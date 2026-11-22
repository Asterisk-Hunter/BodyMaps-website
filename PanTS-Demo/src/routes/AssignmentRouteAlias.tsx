import { Navigate, useLocation } from "react-router-dom";

/** Keep old assignment links working while landing on the single workspace route. */
export default function AssignmentRouteAlias({ view, panel }: { view: "mine" | "manage"; panel?: "join" }) {
	const location = useLocation();
	const params = new URLSearchParams(location.search);
	params.set("view", view);
	if (panel) params.set("panel", panel);
	else params.delete("panel");
	return <Navigate to={`/assignment?${params.toString()}${location.hash}`} replace />;
}
