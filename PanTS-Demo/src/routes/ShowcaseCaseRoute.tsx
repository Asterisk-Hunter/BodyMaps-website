import type { ReactElement } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import { useShowcaseAccess } from "../helpers/useShowcaseAccess";

export default function ShowcaseCaseRoute({ children }: { children: ReactElement }) {
  const { isAuthenticated, loading } = useAuth();
  const { pathname } = useLocation();
  const allowed = useShowcaseAccess(pathname, !isAuthenticated);
  if (isAuthenticated || allowed === true) return children;
  const checking = loading || allowed === null;
  return <div className="auth-route-pending" role="status" aria-busy={checking}>
    {checking ? "Checking showcase access…" : "Sign in to continue to BodyMaps."}
  </div>;
}
