import { Suspense, useEffect, useLayoutEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import "./App.css";
import { warmCuratedCache } from "./helpers/curatedCache";
import AnalyticsRouteTracker from "./components/AnalyticsRouteTracker";
import AuthModal from "./components/AuthModal";
import ErrorBoundary from "./components/ErrorBoundary";
import MessagePage from "./components/MessagePage";
import { lazyRoute, useRetryFailedRoutesOnNavigation } from "./helpers/lazyRoute";
import { reloadOnceForStaleChunk } from "./helpers/staleChunk";
import { AnnotationProvider } from "./contexts/annotationContexts";
import { AuthProvider, useAuth } from "./contexts/authContext";
import { FileProvider } from "./contexts/fileContexts";
import DesignShell from "./components/DesignShell";
import CaseRoute from "./routes/CaseRoute";
import ShowcaseCaseRoute from "./routes/ShowcaseCaseRoute";
import { useShowcaseAccess } from "./helpers/useShowcaseAccess";
import ComparePage from "./routes/ComparePage";
import Homepage from "./routes/Homepage";
import TeamPage from "./routes/TeamPage/index";
import ScrollToTop from "./components/ScrollToTop";
import RouteTitle from "./components/RouteTitle";
import ScrollToTopButton from "./components/ScrollToTopButton";
import { DARK_ROUTE_CLASS, isDarkRoute } from "./helpers/routeSurface";

// The viewer routes pull in the WebGL stack (NiiVue + Cornerstone + three.js), which
// is the bulk of the JS bundle. Code-split them so the landing + dataset pages don't
// download the viewer up front — they only load it when a case is actually opened.
const VisualizationPage = lazyRoute(() => import("./routes/VisualizationPage"));
const CompareViewerPage = lazyRoute(() => import("./routes/CompareViewerPage"));
const UploadPage = lazyRoute(() => import("./routes/UploadPage"));
const LiveRoomPage = lazyRoute(() => import("./liveRooms/LiveRoomPage"));
const SoloChallengePage = lazyRoute(() => import("./education/SoloChallengePage"));
const QuizPracticePage = lazyRoute(() => import("./education/QuizPracticePage"));
const SettingsPage = lazyRoute(() => import("./routes/Settings"));
const ProfileSettings = lazyRoute(() => import("./routes/Settings/ProfileSettings"));
const PlanSettings = lazyRoute(() => import("./routes/Settings/PlanSettings"));
const HistorySettings = lazyRoute(() => import("./routes/Settings/HistorySettings"));
const PrivacySettings = lazyRoute(() => import("./routes/Settings/PrivacySettings"));
// Admin-only sections: split out so the charts and the account list stay out of
// everyone else's bundle.
const AnalyticsSettings = lazyRoute(() => import("./routes/Settings/AnalyticsSettings"));
const PeopleSettings = lazyRoute(() => import("./routes/Settings/PeopleSettings"));
const SignupRedirect = lazyRoute(() => import("./routes/SignupRedirect"));
const ResetPassword = lazyRoute(() => import("./routes/ResetPassword"));
const VerifyEmail = lazyRoute(() => import("./routes/VerifyEmail"));
const LegalPage = lazyRoute(() => import("./routes/LegalPage"));
const ContactPage = lazyRoute(() => import("./routes/ContactPage"));
const SharePatientCard = lazyRoute(() => import("./routes/SharePatientCard"));
// Charts over the three datasets; split out so the library page does not carry them.
const StatisticsPage = lazyRoute(() => import("./routes/Statistics"));

const BASENAME = import.meta.env.VITE_BASENAME;

// Lightweight fallback shown while a lazy route chunk loads (intentionally avoids the
// three.js loader so the fallback itself stays out of the main bundle). It paints
// in the colour of the page that is coming, so a direct load of a light page no
// longer flashes a black screen first.
function RouteFallback() {
  const dark = isDarkRoute(useLocation().pathname);
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="route-fallback"
      style={{
        background: dark ? "#08090b" : "var(--paper)",
      }}
    >
      <div
        className="animate-spin"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: dark ? "2px solid rgba(255,255,255,0.15)" : "2px solid rgba(15,23,42,0.12)",
          borderTopColor: dark ? "rgba(255,255,255,0.6)" : "#002d72",
        }}
      />
    </div>
  );
}

// Keeps the <html> class that paints the dark routes' body in step with the
// route. index.html sets it before the first paint on a hard load; this
// follows in-app navigation, so overscroll and any gap below a page show the
// page's own colour.
function RouteSurface() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle(DARK_ROUTE_CLASS, isDarkRoute(pathname));
  }, [pathname]);
  return null;
}

// A route that throws while rendering, or whose chunk fails to load (offline, or
// a new build replaced the old files under an open tab), shows this page
// instead of unmounting the whole app to a blank screen. It retries on every
// navigation, including a link to the path it is already on (the location key
// changes even when the path does not), so "Back to the workspace" still works
// from an error page at "/".
// "Try again" retries inside the app while offline, by navigating to the current
// URL: that changes the location key, so the boundary resets and a failed chunk
// is fetched again. A full reload would swap the open page for the browser's own
// offline page when the network is down, so the reload is kept while online (it
// also picks up a new build that replaced the files under an open tab). The
// retry marks its location, so the error page that comes back after a failed
// retry takes keyboard focus on its heading instead of dropping it to the page.
function RouteErrorPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const retried = (location.state as { tryAgain?: boolean } | null)?.tryAgain === true;
  useEffect(() => {
    if (!retried) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, [retried]);
  const tryAgain = () => {
    if (navigator.onLine !== false) window.location.reload();
    else {
      const state = typeof location.state === "object" ? location.state : null;
      navigate(location.pathname + location.search + location.hash, {
        replace: true,
        state: { ...state, tryAgain: true },
      });
    }
  };
  return (
    <MessagePage
      title="This page could not load"
      alert
      actions={[
        { label: "Try again", onClick: tryAgain },
        { label: "Back to the workspace", to: "/" },
      ]}
    >
      Check your connection and try again.
    </MessagePage>
  );
}

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  useRetryFailedRoutesOnNavigation();
  return (
    <ErrorBoundary resetKey={useLocation().key} fallback={<RouteErrorPage />}>
      {children}
    </ErrorBoundary>
  );
}

function ProtectedRoutes() {
  const { isAuthenticated, loading } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setTimeout(warmCuratedCache, 1200);
    return () => window.clearTimeout(id);
  }, [isAuthenticated]);
  if (!isAuthenticated) return <div className="auth-route-pending" role="status" aria-busy={loading}>{loading ? "Restoring your session…" : "Sign in to continue to BodyMaps."}</div>;
  return <Outlet />;
}

function AuthSurface() {
  const { isAuthenticated, loading } = useAuth();
  const { pathname } = useLocation();
  const showcaseAccess = useShowcaseAccess(pathname, !isAuthenticated);
  const publicPage = ["", "/upload", "/team", "/contact", "/dashboard", "/statistics", "/local-nifti", "/dicom", "/terms", "/privacy", "/reset-password", "/verify-email", "/signup", "/login"].includes(pathname.replace(/\/+$/, ""));
  return <AuthModal standalone={!publicPage && showcaseAccess === false && !loading && !isAuthenticated} />;
}

function SessionProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // An account change releases the previous account's local scan, annotations,
  // viewer state and in-flight component callbacks before the next account mounts.
  return <FileProvider key={user?.id ?? "signed-out"}><AnnotationProvider>{children}</AnnotationProvider></FileProvider>;
}

function App() {
  // A chunk that 404s after a deploy: reload once so the tab picks up the new
  // build by itself. If the reload does not fix it the route boundary shows.
  useEffect(() => {
    const onPreloadError = (event: Event) => reloadOnceForStaleChunk(event);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  return (
    <AuthProvider>
      <SessionProviders>
          <div className="App">
            <BrowserRouter basename={BASENAME}>
              <AnalyticsRouteTracker />
              <ScrollToTop />
              <RouteTitle />
              <RouteSurface />
              <RouteErrorBoundary>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route element={<DesignShell />}>
                    <Route path="/" element={<UploadPage />} />
                    <Route path="/upload" element={<UploadPage />} />
                    <Route path="/team" element={<TeamPage />} />
                    <Route path="/contact" element={<ContactPage />} />
                    <Route path="/dashboard" element={<Homepage />} />
                    <Route path="/statistics" element={<StatisticsPage />} />
                  </Route>
                  <Route path="/dicom" element={<VisualizationPage />} />
                  <Route path="/local-nifti" element={<VisualizationPage />} />
                  <Route path="/case/:caseId" element={<ShowcaseCaseRoute><CaseRoute><VisualizationPage /></CaseRoute></ShowcaseCaseRoute>} />
                  <Route element={<ProtectedRoutes />}>
                    <Route element={<DesignShell />}>
                      <Route path="/account" element={<SettingsPage />}>
                        <Route index element={<ProfileSettings />} />
                        <Route path="plan" element={<PlanSettings />} />
                        <Route path="history" element={<HistorySettings />} />
                        <Route path="privacy" element={<PrivacySettings />} />
                        <Route path="analytics" element={<AnalyticsSettings />} />
                        <Route path="people" element={<PeopleSettings />} />
                      </Route>
                    </Route>
                    <Route path="/session/:sessionId" element={<VisualizationPage />} />
                    <Route path="/reconstruction/:reconstructionId" element={<VisualizationPage />} />
                    <Route path="/live/:roomId" element={<LiveRoomPage />} />
                    <Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
                    <Route path="/learn/quiz/:packId" element={<QuizPracticePage />} />
                    <Route path="/share/:shareId" element={<SharePatientCard />} />
                    <Route path="/compare" element={<ComparePage />} />
                    <Route path="/compare-viewer" element={<CompareViewerPage />} />
                  </Route>
                  <Route path="/home.html" element={<Navigate to="/" replace />} />
                  <Route path="/api" element={<Navigate to="/upload" replace />} />
                  <Route path="/login" element={<SignupRedirect mode="signin" />} />
                  <Route path="/signup" element={<SignupRedirect />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="/verify-email" element={<VerifyEmail />} />
                  <Route path="/terms" element={<LegalPage kind="terms" />} />
                  <Route path="/privacy" element={<LegalPage kind="privacy" />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
              </RouteErrorBoundary>
              {/* After the page, so it is the last stop in the tab order rather
                  than the first (it only takes focus while it is showing). */}
              <ScrollToTopButton />
              {/* Global auth popup, above all routes. Inside the router so it
                  can link to the legal pages. */}
              <AuthSurface />
            </BrowserRouter>
          </div>
      </SessionProviders>
    </AuthProvider>
  );
}

export default App;
