import type { ReactElement } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { numberRouteToCaseId } from "../helpers/caseNumbering";

// /case/<number> for a library number above PanTS' range (/case/9902) goes to the CancerVerse or
// AbdomenAtlas case that number stands for (/case/CV_00000001, /case/34324 -> /case/BDMAP_00000001).
// Every other id renders the viewer untouched, and the query string and hash (the viewer's share
// state) are carried over.
export default function CaseRoute({ children }: { children: ReactElement }) {
	const { caseId = "" } = useParams();
	const { search, hash } = useLocation();
	const target = numberRouteToCaseId(caseId);
	if (target) return <Navigate to={`/case/${target}${search}${hash}`} replace />;
	return children;
}
