import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconHelpCircle, IconRefresh } from "@tabler/icons-react";
import { API_BASE } from "../helpers/constants";
import "./AnnotationWork.css";

type Assignment = { id: string; status?: string; project: { name: string; status?: string; description?: string | null; target_names: Record<string, string>; due_at?: string | null }; target_labels?: number[]; due_at?: string | null; note?: string | null; case_count: number; counts: Record<string, number>; next_case?: string | null };
type Case = { case_key: string; status: string; review_note?: string | null; unavailable_reason?: string | null };
const statusLabels: Record<string, string> = { not_started: "Not started", in_progress: "Draft in progress", submitted: "Awaiting review", rework: "Changes requested", approved: "Approved", published: "Published", unavailable: "Unavailable", released: "Released" };
const caseLink = (assignmentId: string, caseId: string) => `/case/${caseId}?assignment=${encodeURIComponent(assignmentId)}&hd=1`;

export default function AnnotationWork() {
  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [cases, setCases] = useState<Record<string, Case[]>>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const [refreshNotice, setRefreshNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!refreshNotice) return;
    const timeout = window.setTimeout(() => setRefreshNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [refreshNotice]);
  useEffect(() => {
    if (!helpOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !helpRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [helpOpen]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/api/me/assignments`, { credentials: "include", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Could not load your assignments."); return response.json(); })
      .then(data => setAssignments(data.assignments))
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  async function refreshWorklist() {
    setRefreshing(true); setError(""); setRefreshNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/me/assignments`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not refresh your assignments.");
      const data = await response.json();
      setAssignments(data.assignments);
      // Case access or project status may have changed on the server.
      setCases({});
      setRefreshNotice("Worklist refreshed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh your assignments."); }
    finally { setRefreshing(false); }
  }
  async function openCases(id: string) {
    setLoadingId(id); setError("");
    try {
      const response = await fetch(`${API_BASE}/api/assignments/${encodeURIComponent(id)}/cases`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load the cases.");
      const data = await response.json();
      setCases(previous => ({ ...previous, [id]: data.cases }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the cases."); }
    finally { setLoadingId(null); }
  }
  return <main className="annotation-work">
    <p className="annotation-work__eyebrow">Research annotation</p>
    <h1>Your worklist</h1>
    <p>Open an assigned case, save your draft, and submit it for review.</p>
    <nav className="annotation-work__workspace-actions" aria-label="Annotation workspace">
      <Link to="/work/projects">Create or manage projects</Link>
      <Link to="/work/join">Join a team</Link>
    </nav>
    <div className="annotation-work__utilities">
      <div className="annotation-work__guide" ref={helpRef}>
        <button className="annotation-work__guide-trigger" type="button" aria-label="How annotation projects work" title="How annotation projects work" aria-expanded={helpOpen} aria-controls="annotation-work-guide" onClick={() => setHelpOpen(open => !open)}><IconHelpCircle size={19} stroke={1.8} aria-hidden="true" /></button>
        {helpOpen && <div className="annotation-work__guide-panel" id="annotation-work-guide" role="region" aria-label="How annotation projects work"><ol>
          <li>Open a case and select one of its assigned structures.</li>
          <li>Edit the mask and save your private draft. You can return to it later.</li>
          <li>Submit the saved draft for review. It becomes read-only while the reviewer checks it.</li>
          <li>If changes are requested, read the feedback here and reopen the case. Approved work is published by the reviewer.</li>
        </ol></div>}
      </div>
      <button className={`annotation-work__refresh-all${refreshing ? " is-refreshing" : ""}`} type="button" aria-label={refreshing ? "Refreshing worklist" : "Refresh worklist"} title={refreshing ? "Refreshing worklist" : "Refresh worklist"} disabled={refreshing} onClick={() => void refreshWorklist()}>
        <IconRefresh size={18} stroke={1.8} aria-hidden="true" />
      </button>
    </div>
    {refreshNotice && <div className="annotation-work__toast" role="status">{refreshNotice}</div>}
    {error && <p role="alert">{error}</p>}
    {!assignments && !error && <p role="status">Loading assignments…</p>}
    {assignments?.length === 0 && <p>No assignments yet.</p>}
    {assignments?.map(assignment => {
      const items = cases[assignment.id];
      const closed = assignment.status === "closed" || assignment.project.status === "closed";
      const next = !closed && (items ? ["rework", "in_progress", "not_started"].map(status => items.find(item => item.status === status)?.case_key).find(Boolean) : assignment.next_case);
      const names = (assignment.target_labels ?? Object.keys(assignment.project.target_names).map(Number)).map(id => assignment.project.target_names[String(id)]).filter(Boolean);
      const due = assignment.due_at || assignment.project.due_at;
      const filter = (filters[assignment.id] ?? "").trim().toLowerCase();
      const visibleCases = items?.filter(item => item.case_key.toLowerCase().includes(filter) || (statusLabels[item.status] ?? item.status).toLowerCase().includes(filter));
      const counts = items ? items.reduce<Record<string, number>>((result, item) => { result[item.status] = (result[item.status] ?? 0) + 1; return result; }, {}) : assignment.counts;
      const progress = [["not_started", "not started"], ["in_progress", "in progress"], ["submitted", "awaiting review"], ["approved", "approved"], ["unavailable", "unavailable"], ["released", "released"]]
        .filter(([status]) => (counts[status] ?? 0) > 0).map(([status, label]) => `${counts[status]} ${label}`).join(" · ");
      return <section className="annotation-work__card" key={assignment.id}>
        <div><h2>{assignment.project.name}</h2><p>Structures: {names.join(", ")}</p>
          <p>{assignment.case_count} cases · {counts.published ?? 0} published{due ? ` · Due ${due.slice(0, 10)} (UTC)` : ""}</p>
          {progress && <p>{progress}</p>}
          {closed && <p className="annotation-work__attention">This assignment is closed. Cases are read-only.</p>}
          {(counts.rework ?? 0) > 0 && <p className="annotation-work__attention">{counts.rework} {counts.rework === 1 ? "case needs" : "cases need"} your attention</p>}
          {assignment.project.description && <p>Instructions: {assignment.project.description}</p>}
          {assignment.note && <p>{assignment.note}</p>}</div>
        {!items ? <div className="annotation-work__actions">{next && <Link className="annotation-work__next" to={caseLink(assignment.id, next)}>Continue with {next}</Link>}<button aria-expanded="false" disabled={loadingId === assignment.id} onClick={() => void openCases(assignment.id)}>{loadingId === assignment.id ? "Loading cases…" : "View cases"}</button></div>
          : <><div className="annotation-work__actions">{next && <Link className="annotation-work__next" to={caseLink(assignment.id, next)}>Continue with {next}</Link>}
            <button className="annotation-work__refresh" disabled={loadingId === assignment.id} onClick={() => void openCases(assignment.id)}>Refresh</button><button aria-expanded="true" onClick={() => setCases(previous => { const next = { ...previous }; delete next[assignment.id]; return next; })}>Hide cases</button></div>
            <label className="annotation-work__filter">Find a case or status <input type="search" value={filters[assignment.id] ?? ""} onChange={event => setFilters(previous => ({ ...previous, [assignment.id]: event.target.value }))} placeholder="Case ID or status" /></label>
            {visibleCases?.length === 0 && <p>No cases match your search.</p>}
            <ul>{visibleCases?.map(item => <li key={item.case_key}>
              <span>{item.case_key}</span><span className={`annotation-work__status status-${item.status}`}>{statusLabels[item.status] ?? item.status}</span>
              {item.status !== "unavailable" && <Link to={caseLink(assignment.id, item.case_key)}>Open</Link>}
              {item.status === "unavailable" && item.unavailable_reason && <p className="annotation-work__review-note">{item.unavailable_reason}. Contact the project owner.</p>}
              {item.status === "rework" && item.review_note && <p className="annotation-work__review-note">Reviewer: {item.review_note}</p>}
            </li>)}</ul></>}
      </section>;
    })}
  </main>;
}
