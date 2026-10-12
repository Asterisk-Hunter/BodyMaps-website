import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { IconLayoutSidebar, IconLayoutGrid, IconFocusCentered, IconUsers, IconPlus, IconMenu2, IconX } from "@tabler/icons-react";
import AuthButton from "./AuthButton";
import SiteFooter from "./SiteFooter";
import WorkspaceTour from "./WorkspaceTour";
import { useAuth } from "../contexts/authContext";
import { groupUploads, isGroupInFlight, loadRecentUploads, markRecentUploadViewed, RECENT_UPLOADS_CHANGED, isRecentUploadsStorageKey, type UploadGroup } from "../helpers/recentUploads";
import "./DesignShell.css";

const COLLAPSED_KEY = "bodymaps.sidebar.collapsed";

export default function DesignShell() {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recent, setRecent] = useState(loadRecentUploads);
  const [tourRequest, setTourRequest] = useState(0);
  const sidebar = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const mobileButton = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(location.pathname);
  const isWorkspace = location.pathname === "/" || location.pathname === "/upload";
  const navIndex = location.pathname === "/team" ? 2 : location.pathname === "/dashboard" ? 1 : isWorkspace ? 0 : -1;

  useEffect(() => {
    if (!isWorkspace || !location.state?.replayWorkspaceTour) return;
    setTourRequest((n) => n + 1);
    // Public workspace and protected account routes use separate shell
    // instances. Carry a one-time replay request across that boundary.
    const { replayWorkspaceTour: _request, ...state } = location.state;
    navigate(location.pathname + location.search + location.hash, { replace: true, state });
  }, [isWorkspace, location, navigate]);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    element.scrollTop = 0;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !element.animate) return;
    // Animate the existing outlet, without remounting upload/session state.
    const animation = element.animate([
      { opacity: 0, transform: "translateY(14px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: 650, easing: "cubic-bezier(.22,1,.36,1)" });
    return () => animation.cancel();
  }, [location.pathname]);

  useEffect(() => {
    const refresh = () => setRecent(loadRecentUploads());
    const storage = (event: StorageEvent) => { if (!event.key || isRecentUploadsStorageKey(event.key)) refresh(); };
    window.addEventListener(RECENT_UPLOADS_CHANGED, refresh);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(RECENT_UPLOADS_CHANGED, refresh); window.removeEventListener("storage", storage); };
  }, []);
  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    if (mobileOpen) document.getElementById("workspace-content")?.focus();
    setMobileOpen(false);
  }, [location.pathname, mobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const element = sidebar.current;
    element?.querySelector<HTMLButtonElement>(".design-mobile-close")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobileOpen(false); mobileButton.current?.focus(); }
      if (event.key !== "Tab" || !element) return;
      const nodes = Array.from(element.querySelectorAll<HTMLElement>("a[href],button:not([disabled])"))
        .filter((node) => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [mobileOpen]);

  const toggleCollapsed = () => setCollapsed((previous) => {
    try { localStorage.setItem(COLLAPSED_KEY, String(!previous)); } catch { /* optional preference */ }
    return !previous;
  });
  const newRun = () => {
    // Keep the same component mounted on / and /upload. Focusing the composer
    // never discards selected files or interrupts an upload already in progress.
    if (location.pathname !== "/" && location.pathname !== "/upload") navigate("/upload#scan-composer");
    window.dispatchEvent(new Event("bodymaps:focus-composer"));
    setMobileOpen(false);
  };
  const replayWalkthrough = () => {
    // The V6 walkthrough explains the workspace. Replaying from an account or
    // Team page should show those controls too; replaying here keeps uploads.
    setMobileOpen(false);
    if (!isWorkspace) navigate("/", { state: { replayWorkspaceTour: true } });
    else setTourRequest((n) => n + 1);
  };
  const openRecent = (group: UploadGroup) => {
    if (group.kind === "single" && group.upload.status === "Completed") {
      markRecentUploadViewed(group.upload.sessionId);
      navigate(`/${group.upload.isReconstruction ? "reconstruction" : "session"}/${encodeURIComponent(group.upload.sessionId)}`);
    } else if (isGroupInFlight(group)) {
      navigate("/upload");
    } else {
      // Finished batches and failed runs may have moved out of the workspace.
      // Preserve the selected run so History can open it directly at any age.
      const query = group.kind === "batch"
        ? new URLSearchParams({ batch: group.batchId })
        : new URLSearchParams({ session: group.upload.sessionId });
      navigate(`/account/history?${query}`);
    }
    setMobileOpen(false);
  };

  return <div className={`design-shell${isWorkspace ? " is-workspace" : ""}${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-mobile-open" : ""}`}>
    <a className="design-skip-link" href="#workspace-content">Skip to content</a>
    <div className="design-frame">
      <header className="design-mobile-bar" data-tour="mobile-navigation">
        <button ref={mobileButton} type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="design-sidebar"><IconMenu2 size={20} /></button>
        <Link to="/"> <img src="/bodymaps-logo.svg" alt="" /> BodyMaps</Link>
      </header>
      {mobileOpen && <button className="design-mobile-backdrop" aria-label="Close navigation" tabIndex={-1} onClick={() => { setMobileOpen(false); mobileButton.current?.focus(); }} />}
      <aside ref={sidebar} id="design-sidebar" className="design-sidebar" aria-label="Workspace navigation">
        <div className="design-brand">
          <Link to="/" title="BodyMaps workspace" aria-label="BodyMaps workspace"><img src="/bodymaps-logo.svg" alt="" /><span className="sidebar-label">BodyMaps</span></Link>
          <button className="design-collapse" type="button" onClick={toggleCollapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}><IconLayoutSidebar size={19} /></button>
          <button className="design-mobile-close" type="button" aria-label="Close navigation" onClick={() => { setMobileOpen(false); mobileButton.current?.focus(); }}><IconX size={19} /></button>
        </div>
        <button className="design-new-run" type="button" onClick={newRun} title="New run" data-tour="new-run"><IconPlus size={19} /><span className="sidebar-label">New run</span></button>
        <div className="design-nav-caption sidebar-label">Explore</div>
        <nav className="design-nav" aria-label="Main navigation" data-tour="explore">
          <span className="design-nav-indicator" aria-hidden="true" style={{ opacity: navIndex < 0 ? 0 : 1, transform: `translateY(${Math.max(0, navIndex) * 44}px)` }} />
          <NavLink to="/" end className={({ isActive }) => isActive || location.pathname === "/upload" ? "active" : ""} title="Workspace"><IconFocusCentered size={19} /><span className="sidebar-label">Workspace</span></NavLink>
          <NavLink to="/dashboard" title="Dataset"><IconLayoutGrid size={19} /><span className="sidebar-label">Dataset</span></NavLink>
          <NavLink to="/team" title="Team"><IconUsers size={19} /><span className="sidebar-label">Team</span></NavLink>
        </nav>
        <section className="design-recent sidebar-label" aria-label="Recent runs" data-tour="recent">
          <h2 className="design-nav-caption">Recent runs</h2>
          {recent.length === 0 ? <p>Runs you start appear here.</p> : groupUploads(recent).slice(0, 8).map((group) => {
            const status = group.kind === "single" ? group.upload.status : group.uploads.some((u) => u.status === "Processing") ? "Processing" : group.uploads.every((u) => u.status === "Completed") ? "Completed" : "Needs attention";
            const label = group.kind === "single" ? group.upload.label : group.label;
            return <button key={group.kind === "single" ? group.upload.sessionId : group.batchId} type="button" onClick={() => openRecent(group)} title={`${label} · ${status}`}>
              <span className={`design-run-dot status-${status.toLowerCase().replaceAll(" ", "-")}`} aria-hidden="true" />
              <span><strong>{label}</strong><small>{group.kind === "single" ? group.upload.model : `${group.uploads.length} scans`} · {status}</small></span>
            </button>;
          })}
          {recent.length > 0 && <Link className="design-history" to="/account/history">All history →</Link>}
        </section>
        <div className="design-sidebar-account" data-tour="settings"><AuthButton variant="sidebar" collapsed={collapsed && !mobileOpen} onWalkthrough={replayWalkthrough} /></div>
      </aside>
      <div className="design-main-column">
        <main ref={content} id="workspace-content" className="design-content" tabIndex={-1}><Outlet /></main>
        <div className="design-footer"><SiteFooter /></div>
      </div>
    </div>
    {isAuthenticated && isWorkspace && <WorkspaceTour replay={tourRequest} name={user?.name} />}
  </div>;
}
