import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import "./App.css";
import { warmCuratedCache } from "./helpers/curatedCache";
import AnalyticsRouteTracker from "./components/AnalyticsRouteTracker";
import AuthModal from "./components/AuthModal";
import { AnnotationProvider } from "./contexts/annotationContexts";
import { AuthProvider, useAuth } from "./contexts/authContext";
import { FileProvider } from "./contexts/fileContexts";
import DesignShell from "./components/DesignShell";
import CaseRoute from "./routes/CaseRoute";
import ComparePage from "./routes/ComparePage";
import Homepage from "./routes/Homepage";
import TeamPage from "./routes/TeamPage/index";
import ScrollToTopButton from "./components/ScrollToTopButton";

// The viewer routes pull in the WebGL stack (NiiVue + Cornerstone + three.js), which
// is the bulk of the JS bundle. Code-split them so the landing + dataset pages don't
// download the viewer up front — they only load it when a case is actually opened.
const VisualizationPage = lazy(() => import("./routes/VisualizationPage"));
const CompareViewerPage = lazy(() => import("./routes/CompareViewerPage"));
const UploadPage = lazy(() => import("./routes/UploadPage"));
const LiveRoomPage = lazy(() => import("./liveRooms/LiveRoomPage"));
const SoloChallengePage = lazy(() => import("./education/SoloChallengePage"));
const QuizPracticePage = lazy(() => import("./education/QuizPracticePage"));
const SettingsPage = lazy(() => import("./routes/Settings"));
const ProfileSettings = lazy(() => import("./routes/Settings/ProfileSettings"));
const PlanSettings = lazy(() => import("./routes/Settings/PlanSettings"));
const HistorySettings = lazy(() => import("./routes/Settings/HistorySettings"));
const PrivacySettings = lazy(() => import("./routes/Settings/PrivacySettings"));
// Admin-only sections: split out so the charts and the account list stay out of
// everyone else's bundle.
const AnalyticsSettings = lazy(() => import("./routes/Settings/AnalyticsSettings"));
const PeopleSettings = lazy(() => import("./routes/Settings/PeopleSettings"));
const SignupRedirect = lazy(() => import("./routes/SignupRedirect"));
const ResetPassword = lazy(() => import("./routes/ResetPassword"));
const VerifyEmail = lazy(() => import("./routes/VerifyEmail"));
const LegalPage = lazy(() => import("./routes/LegalPage"));
const SharePatientCard = lazy(() => import("./routes/SharePatientCard"));
const RotatingHeartLoader = lazy(() => import("./components/Loading"));

const BASENAME = import.meta.env.VITE_BASENAME;

// Lightweight fallback shown while a lazy route chunk loads (intentionally avoids the
// three.js loader so the fallback itself stays out of the main bundle).
function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#08090b",
      }}
    >
      <div
        className="animate-spin"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,0.15)",
          borderTopColor: "rgba(255,255,255,0.6)",
        }}
      />
    </div>
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
  const publicPage = ["", "/upload", "/team", "/local-nifti", "/dicom", "/terms", "/privacy", "/reset-password", "/verify-email", "/signup", "/login"].includes(pathname.replace(/\/+$/, ""));
  return <AuthModal standalone={!publicPage && !loading && !isAuthenticated} />;
}

function SessionProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // An account change releases the previous account's local scan, annotations,
  // viewer state and in-flight component callbacks before the next account mounts.
  return <FileProvider key={user?.id ?? "signed-out"}><AnnotationProvider>{children}</AnnotationProvider></FileProvider>;
}

function App() {
  return (
    <AuthProvider>
      <SessionProviders>
          <div className="App">
            <BrowserRouter basename={BASENAME}>
              <AnalyticsRouteTracker />
              <ScrollToTopButton />
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route element={<DesignShell />}>
                    <Route path="/" element={<UploadPage />} />
                    <Route path="/upload" element={<UploadPage />} />
                    <Route path="/team" element={<TeamPage />} />
                  </Route>
                  <Route path="/dicom" element={<VisualizationPage />} />
                  <Route path="/local-nifti" element={<VisualizationPage />} />
                  <Route element={<ProtectedRoutes />}>
                    <Route element={<DesignShell />}>
                      <Route path="/dashboard" element={<Homepage />} />
                      <Route path="/account" element={<SettingsPage />}>
                        <Route index element={<ProfileSettings />} />
                        <Route path="plan" element={<PlanSettings />} />
                        <Route path="history" element={<HistorySettings />} />
                        <Route path="privacy" element={<PrivacySettings />} />
                        <Route path="analytics" element={<AnalyticsSettings />} />
                        <Route path="people" element={<PeopleSettings />} />
                      </Route>
                    </Route>
                    <Route path="/case/:caseId" element={<CaseRoute><VisualizationPage /></CaseRoute>} />
                    <Route path="/session/:sessionId" element={<VisualizationPage />} />
                    <Route path="/reconstruction/:reconstructionId" element={<VisualizationPage />} />
                    <Route path="/live/:roomId" element={<LiveRoomPage />} />
                    <Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
                    <Route path="/learn/quiz/:packId" element={<QuizPracticePage />} />
                    <Route path="/share/:shareId" element={<SharePatientCard />} />
                    <Route path="/compare" element={<ComparePage />} />
                    <Route path="/compare-viewer" element={<CompareViewerPage />} />
                    <Route path="/test" element={<RotatingHeartLoader />} />
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
