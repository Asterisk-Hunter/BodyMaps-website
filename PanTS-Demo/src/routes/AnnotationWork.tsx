import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconHelpCircle, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { API_BASE } from "../helpers/constants";
import "./AnnotationWork.css";

type Assignment = {
  id: string;
  project: { id: string; name: string; description?: string | null; due_at?: string | null; status: string; target_names: Record<string, string> };
  target_labels?: number[];
  note?: string | null;
  due_at?: string | null;
  case_count: number;
  counts: Record<string, number>;
  status: string;
  next_case?: string | null;
};
type ProjectCase = { case_key: string; status: string; unavailable_reason?: string | null; review_note?: string | null };

const statusLabels: Record<string, string> = {
  not_started: "Not started",
  in_progress: "Draft in progress",
  submitted: "Awaiting review",
  rework: "Changes requested",
  approved: "Approved",
  published: "Published",
  unavailable: "Unavailable",
  released: "Released",
};

export default function AnnotationWork({ embedded = false }: { embedded?: boolean } = {}) {
  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [cases, setCases] = useState<Record<string, ProjectCase[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
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
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
        setHelpOpen(false);
      }
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
      .then(response => { if (!response.ok) throw new Error("Could not load your assignments."); return response.json(); })
      .then(data => setAssignments(data.assignments))
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);

  async function refreshWorklist() {
    setRefreshing(true); setError(""); setRefreshNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/me/assignments`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not refresh your assignments.");
      const data = await response.json();
      setAssignments(data.assignments);
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

  const caseLink = (assignmentId: string, caseKey: string) => `/assignments/${encodeURIComponent(assignmentId)}/cases/${encodeURIComponent(caseKey)}`;

  return (
    <section className={`annotation-work${embedded ? " annotation-work--embedded" : ""}`} aria-label={embedded ? "Project work" : undefined}>
      <div className="annotation-work__heading">
        <div className="annotation-work__heading-text">
          <h2>Assigned projects</h2>
          <p>Cases assigned through a project, including feedback and review status.</p>
        </div>
        <div className="annotation-work__utilities">
          <div className="annotation-work__guide" ref={helpRef}>
            <button
              className="annotation-work__guide-trigger"
              type="button"
              aria-label="How annotation projects work"
              title="How annotation projects work"
              aria-expanded={helpOpen}
              aria-controls="annotation-work-guide"
              onClick={() => setHelpOpen(open => !open)}
            >
              <IconHelpCircle size={17} stroke={2} aria-hidden="true" />
              <span>Guide</span>
            </button>
            {helpOpen && (
              <div className="annotation-work__guide-panel" id="annotation-work-guide" role="region" aria-label="How annotation projects work">
                <ol>
                  <li>Open an assigned case and select target structures.</li>
                  <li>Edit the segmentation and save private drafts anytime.</li>
                  <li>Submit finished drafts for review and approval.</li>
                  <li>Approved work is published directly to the shared dataset.</li>
                </ol>
              </div>
            )}
          </div>
          <button
            className={`annotation-work__refresh-all${refreshing ? " is-refreshing" : ""}`}
            type="button"
            aria-label={refreshing ? "Refreshing worklist" : "Refresh worklist"}
            title={refreshing ? "Refreshing worklist" : "Refresh worklist"}
            disabled={refreshing}
            onClick={() => void refreshWorklist()}
          >
            <IconRefresh size={17} stroke={2} aria-hidden="true" />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {refreshNotice && <div className="annotation-work__toast" role="status">{refreshNotice}</div>}
      {error && <p className="annotation-work__attention" role="alert">{error}</p>}
      {!assignments && !error && <p className="asg-page-note" role="status">Loading assignments…</p>}
      {assignments?.length === 0 && (
        <div className="annotation-work__empty">
          <h3>No assigned projects</h3>
          <p>You don't have any projects assigned right now. When a project manager assigns cases to you, they will appear here.</p>
        </div>
      )}

      {assignments?.map(assignment => {
        const items = cases[assignment.id];
        const closed = assignment.status === "closed" || assignment.project.status === "closed";
        const next = !closed && (items ? ["rework", "in_progress", "not_started"].map(status => items.find(item => item.status === status)?.case_key).find(Boolean) : assignment.next_case);
        const due = assignment.due_at || assignment.project.due_at;
        const filter = (filters[assignment.id] ?? "").trim().toLowerCase();
        const visibleCases = items?.filter(item => item.case_key.toLowerCase().includes(filter) || (statusLabels[item.status] ?? item.status).toLowerCase().includes(filter));
        const counts = items ? items.reduce<Record<string, number>>((result, item) => { result[item.status] = (result[item.status] ?? 0) + 1; return result; }, {}) : assignment.counts;
        
        // Progress calculations
        const done = (counts.published ?? 0) + (counts.approved ?? 0);
        const inReview = counts.submitted ?? 0;
        const inProgress = counts.in_progress ?? 0;
        const rework = counts.rework ?? 0;
        const total = assignment.case_count || 1;
        const donePercent = Math.min(100, Math.round((done / total) * 100));

        return (
          <section className="annotation-work__card" key={assignment.id}>
            <div className="annotation-work__card-header">
              <div className="annotation-work__title-group">
                <h2>{assignment.project.name}</h2>
                <span className={`annotation-work__status-badge ${closed ? "annotation-work__status-badge--closed" : ""}`}>
                  {closed ? "Closed" : "Active"}
                </span>
              </div>
              {due && (
                <span className="annotation-work__due">Due {due.slice(0, 10)}</span>
              )}
            </div>

            {assignment.project.description && (
              <p className="annotation-work__desc">{assignment.project.description}</p>
            )}

            {assignment.note && (
              <p className="annotation-work__note"><strong>Note:</strong> {assignment.note}</p>
            )}

            {rework > 0 && (
              <p className="annotation-work__attention">
                {rework} {rework === 1 ? "case needs" : "cases need"} your attention: changes requested by reviewer.
              </p>
            )}

            {closed && (
              <p className="annotation-work__attention">This assignment is closed. Cases are read-only.</p>
            )}

            {/* Clean Progress Bar in BodyMaps Palette */}
            <div className="annotation-work__progress-block">
              <div className="annotation-work__progress-header">
                <strong>{done} of {assignment.case_count} cases complete ({donePercent}%)</strong>
                <div className="annotation-work__progress-pills">
                  {counts.published ? <span className="annotation-work__count-pill pill-published">{counts.published} published</span> : null}
                  {counts.approved ? <span className="annotation-work__count-pill pill-approved">{counts.approved} approved</span> : null}
                  {inReview ? <span className="annotation-work__count-pill pill-review">{inReview} in review</span> : null}
                  {inProgress ? <span className="annotation-work__count-pill pill-progress">{inProgress} in progress</span> : null}
                  {rework ? <span className="annotation-work__count-pill pill-rework">{rework} changes requested</span> : null}
                  {counts.unavailable ? <span className="annotation-work__count-pill pill-gray">{counts.unavailable} unavailable</span> : null}
                </div>
              </div>
              <div className="asg-bar-track" role="progressbar" aria-valuenow={donePercent} aria-valuemin={0} aria-valuemax={100}>
                <div className="asg-bar-done" style={{ width: `${(done / total) * 100}%` }} />
                <div style={{ background: "#002d72", width: `${(inReview / total) * 100}%` }} />
                <div style={{ background: "#4572b8", width: `${(inProgress / total) * 100}%` }} />
                <div className="asg-bar-flag" style={{ width: `${(rework / total) * 100}%` }} />
              </div>
            </div>

            {/* Actions Bar */}
            <div className="annotation-work__actions">
              {next && (
                <Link className="asg-primary" to={caseLink(assignment.id, next)}>
                  Continue with {next} →
                </Link>
              )}
              {!items ? (
                <button
                  type="button"
                  className="asg-secondary"
                  aria-expanded="false"
                  disabled={loadingId === assignment.id}
                  onClick={() => void openCases(assignment.id)}
                >
                  {loadingId === assignment.id ? "Loading cases…" : `View cases (${assignment.case_count})`}
                </button>
              ) : (
                <button
                  type="button"
                  className="asg-secondary"
                  aria-expanded="true"
                  onClick={() => setCases(previous => { const nextCases = { ...previous }; delete nextCases[assignment.id]; return nextCases; })}
                >
                  Hide cases
                </button>
              )}
            </div>

            {/* Expanded Cases List */}
            {items && (
              <div className="annotation-work__cases-view">
                <div className="annotation-work__search-bar">
                  <IconSearch size={18} className="annotation-work__search-icon" aria-hidden="true" />
                  <input
                    type="search"
                    className="annotation-work__search-input"
                    value={filters[assignment.id] ?? ""}
                    onChange={event => setFilters(previous => ({ ...previous, [assignment.id]: event.target.value }))}
                    placeholder="Search cases by ID or status..."
                    aria-label="Find a case or status"
                  />
                  {filters[assignment.id] && (
                    <button
                      type="button"
                      className="annotation-work__search-clear"
                      aria-label="Clear search"
                      onClick={() => setFilters(previous => ({ ...previous, [assignment.id]: "" }))}
                    >
                      <IconX size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {visibleCases?.length === 0 && <p className="asg-note">No cases match your search.</p>}

                <ul className="annotation-work__cases-list">
                  {visibleCases?.map(item => (
                    <li key={item.case_key} className="annotation-work__case-row">
                      <div className="annotation-work__case-info">
                        <span className="annotation-work__case-key">{item.case_key}</span>
                        <span className={`annotation-work__status status-${item.status}`}>
                          {statusLabels[item.status] ?? item.status}
                        </span>
                        {item.unavailable_reason && (
                          <p className="asg-note">{item.unavailable_reason}</p>
                        )}
                        {item.review_note && (
                          <p className="annotation-work__review-note"><strong>Reviewer:</strong> {item.review_note}</p>
                        )}
                      </div>
                      <div>
                        {item.status !== "unavailable" ? (
                          <Link className="asg-secondary" to={caseLink(assignment.id, item.case_key)}>
                            Open →
                          </Link>
                        ) : (
                          <span className="asg-note">Unavailable</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
