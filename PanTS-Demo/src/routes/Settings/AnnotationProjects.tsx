import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { API_BASE, segmentation_categories } from "../../helpers/constants";
import { parseAnnotationCaseCsv } from "../../helpers/annotationCaseCsv";
// import AnnotatorCodes from "./AnnotatorCodes";
import { IconAlertTriangle, IconRefresh, IconX } from "@tabler/icons-react";
import "./Settings.css";

type Project = { id: string; name: string; description?: string | null; target_labels: number[]; target_names: Record<string, string>; status: string; baseline_mode: string; reviewer_id: string | null; reviewer_has_access?: boolean; due_at: string | null; created_by?: string | null; can_manage?: boolean };
type Person = { id: string; name: string | null; email: string; roles?: string[] };
type Review = { id: string; case_key: string; assignment_id: string; assignee_id?: string | null; submitted_by?: string | null; submitted_by_name: string; version: number; note?: string | null };
type Assignment = { id: string; assignee_id: string | null; assignee_name: string | null; assignee_has_access?: boolean; target_labels?: number[]; note?: string | null; due_at?: string | null; case_count: number; counts: Record<string, number> };
type AssignmentCase = { case_key: string; status: string; unavailable_reason?: string | null };
type HistoryEvent = { id: string; project_id: string; assignment_id: string | null; submission_id: string | null; submission_assignment_id?: string | null; submission_status?: string | null; action: string; actor_name: string; comment?: string | null; created_at: string };
type Confirmation = { eyebrow?: string; title: string; description: string; caseKey?: string; confirmLabel: string; success?: string; action: () => Promise<void> };

async function api(path: string, options?: RequestInit) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, { credentials: "include", ...options, signal: options?.signal ?? controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The request took too long and was stopped. Refresh the assignment list before retrying, in case the server completed it.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const post = (data: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

export default function AnnotationProjects({ onJoin: _onJoin }: { onJoin?: () => void } = {}) {
  const [searchParams] = useSearchParams();
  const [workflowStep, setWorkflowStep] = useState(1);
  const createProjectRef = useRef<HTMLDetailsElement>(null);
  const personPickerRef = useRef<HTMLDivElement>(null);
  const assignmentFormRef = useRef<HTMLDivElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvImportRef = useRef<HTMLDetailsElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(() => searchParams.get("project") ?? "");
  const [storage, setStorage] = useState<{ bytes: number; files: number; noncurrent_drafts?: { bytes: number; files: number }; unreferenced_submissions?: { bytes: number; files: number } } | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [source, setSource] = useState("pants");
  const [baseline, setBaseline] = useState("canonical");
  const [targets, setTargets] = useState<number[]>([]);
  const [customTargets, setCustomTargets] = useState<Record<string, string>>({});
  const [customIndex, setCustomIndex] = useState("");
  const [customName, setCustomName] = useState("");
  /* Reviewer picker state is deferred with its UI; retain for when that workflow returns.
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  */
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [peopleSearchMessage, setPeopleSearchMessage] = useState("");
  /* const [inlineInviteLoaded, setInlineInviteLoaded] = useState(false); */
  const [allRegisteredPeople, setAllRegisteredPeople] = useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [assignablePeople, setAssignablePeople] = useState<Person[]>([]);
  const [assignee, setAssignee] = useState("");
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [caseInput, setCaseInput] = useState("");
  const [assignmentNote, setAssignmentNote] = useState("");
  const [assignmentDue, setAssignmentDue] = useState("");
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [limitTargets, setLimitTargets] = useState(false);
  const [assignmentTargets, setAssignmentTargets] = useState<number[]>([]);
  const [waiting, setWaiting] = useState<Review[]>([]);
  const [approved, setApproved] = useState<Review[]>([]);
  const [reviewFilter, setReviewFilter] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [openAssignmentEditor, setOpenAssignmentEditor] = useState<string | null>(null);
  const [assignmentCases, setAssignmentCases] = useState<Record<string, AssignmentCase[]>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [assignmentEdits, setAssignmentEdits] = useState<Record<string, { note: string; due: string }>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notifyReview, setNotifyReview] = useState<Record<string, boolean>>({});
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  /* Reviewer edit state is deferred with its controls; retain for later.
  const [editReviewer, setEditReviewer] = useState("");
  */
  const [editDue, setEditDue] = useState("");
  const [historyCase, setHistoryCase] = useState("");
  const [historyCaseKey, setHistoryCaseKey] = useState("");
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const rollbackRequests = useRef<Record<string, { id: string; revision: string }>>({});

  async function refreshProjects() {
    const data = await api("/projects"); setProjects(data.projects);
  }
  async function refreshReviews(id: string) {
    const [a, b, c] = await Promise.all([api(`/reviews?project=${encodeURIComponent(id)}&status=in_review`), api(`/reviews?project=${encodeURIComponent(id)}&status=approved`), api(`/projects/${encodeURIComponent(id)}/assignments`)]);
    if (selectedRef.current !== id) return;
    setWaiting(a.submissions); setApproved(b.submissions);
    setAssignments(c.assignments); setAssignmentCases({}); setAssignmentEdits({});
  }
  useEffect(() => { void api("/annotation-projects/capabilities").then(data => {
    setEnabled(data.enabled); if (data.enabled) void refreshProjects().catch(e => setError(e.message));
  }).catch(e => { setEnabled(false); setError(e.message); }); }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (!confirmation) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        setConfirmation(null);
      } else if (event.key === "Tab") {
        const buttons = confirmationRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = window.requestAnimationFrame(() => confirmationCancelRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(frame);
      if (confirmationTriggerRef.current?.isConnected) confirmationTriggerRef.current.focus();
      else previousFocus?.focus();
    };
  }, [confirmation]);
  useEffect(() => { setStorage(null); setWaiting([]); setApproved([]); setReviewFilter(""); setAssignments([]); setAssignmentCases({}); setComments({}); setLimitTargets(false); setAssignmentTargets([]); setAssignmentNote(""); setAssignmentDue(""); setCaseInput(""); setAssignee(""); setSelectedPerson(null); setAssigneeSearch(""); setAssignablePeople([]); setAllRegisteredPeople([]); setPeopleSearchMessage(""); setShowAssignForm(false); if (selected) void refreshReviews(selected).catch(e => { if (selectedRef.current === selected) setError(e.message); }); }, [selected]);
  async function run(action: () => Promise<void>, success?: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); if (success) setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function confirmAction() {
    if (!confirmation || busy) return;
    const pending = confirmation;
    void run(async () => {
      await pending.action();
      setConfirmation(null);
    }, pending.success);
  }
  function navigateToStep(target: number) {
    setError(""); setNotice("");
    if (target > 1 && !selected) {
      setFieldErrors({ project: "Choose or create a project before continuing." });
      setWorkflowStep(1);
      return;
    }
    setFieldErrors({}); setWorkflowStep(target);
  }
  function focusAssignmentDetails() {
    setShowAssignForm(true);
    window.requestAnimationFrame(() => {
      assignmentFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("annotation-assignment-cases")?.focus({ preventScroll: true });
    });
  }
  function validateAssignmentFields() {
    const nextErrors: Record<string, string> = {};
    if (!assignee) nextErrors.assignee = "Choose a team member.";
    if (!caseInput.trim()) nextErrors.cases = "Enter one or more case IDs or ranges.";
    else {
      try { selector(); }
      catch { nextErrors.cases = "Enter a case ID or a valid range, such as 55–95."; }
    }
    setFieldErrors(previous => {
      const next = { ...previous };
      delete next.assignee; delete next.cases; delete next.assignment;
      return { ...next, ...nextErrors };
    });
    return Object.keys(nextErrors).length === 0;
  }
  async function requestRework(item: Review) {
    const notify = Boolean(notifyReview[item.id]);
    const result = await api(`/submissions/${item.id}/rework`, post({ comment: comments[item.id] ?? "", notify }));
    setNotice(!notify ? "Changes requested. The team member can revise the draft." : result.notification === "accepted"
      ? "Changes requested. The mail server accepted the notification; delivery is not guaranteed."
      : "Changes requested, but email delivery could not be confirmed. Please notify the team member another way.");
    await refreshReviews(selected);
  }
  function selector() {
    const ids: string[] = []; const ranges: { from: string; to: string }[] = [];
    const normalizedInput = caseInput.replace(/\s*([-–—])\s*/gu, "$1");
    for (const token of normalizedInput.split(/[\s,;]+/).filter(Boolean)) {
      const range = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/u);
      if (range && Number(range[1]) <= Number(range[2])) ranges.push({ from: range[1], to: range[2] });
      else if (range) throw new Error(`Invalid case range: ${token}`);
      else if (/[-–—]/u.test(token)) throw new Error(`Invalid case range: ${token}`);
      else ids.push(token);
    }
    return { ids, ranges };
  }
  const assignmentBody = () => {
    if (limitTargets && assignmentTargets.length === 0) throw new Error("Select at least one structure for this assignment.");
    return { assignee_id: assignee, case_selector: selector(), note: assignmentNote.trim() || null, due_at: assignmentDue ? `${assignmentDue}T23:59:59Z` : null, ...(limitTargets ? { target_labels: assignmentTargets } : {}) };
  };
  const chosen = projects.find(p => p.id === selected);
  useEffect(() => {
    if (!selected) {
      setAllRegisteredPeople([]);
      setAssignablePeople([]);
      return;
    }
    let cancelled = false;
    setLoadingPeople(true);
    void api(`/annotation-projects/people?project_id=${encodeURIComponent(selected)}`)
      .then(response => {
        if (cancelled) return;
        const list = (response.people as Person[]) || [];
        setAllRegisteredPeople(list);
        setAssignablePeople(list);
        setLoadingPeople(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingPeople(false);
      });
    return () => { cancelled = true; };
  }, [selected]);

  useEffect(() => {
    if (!selected || assignee) return;
    const query = assigneeSearch.trim();
    if (!query) {
      setAssignablePeople(allRegisteredPeople);
      setPeopleSearchMessage(allRegisteredPeople.length ? "" : "No registered users in database.");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPeopleSearchMessage("Searching registered users…");
      try {
        const response = await api(`/annotation-projects/people?project_id=${encodeURIComponent(selected)}&q=${encodeURIComponent(query)}`);
        if (cancelled) return;
        const results = response.people as Person[];
        setAssignablePeople(results);
        setPeopleSearchMessage(results.length ? "" : "No registered users found.");
      } catch {
        if (!cancelled) {
          const local = allRegisteredPeople.filter(p =>
            (p.name?.toLowerCase().includes(query.toLowerCase()) ||
             p.email.toLowerCase().includes(query.toLowerCase()))
          );
          setAssignablePeople(local);
          setPeopleSearchMessage(local.length ? "" : "No registered users found.");
        }
      }
    }, 200);

    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [assigneeSearch, assignee, selected, allRegisteredPeople]);
  const selectedAssignee = selectedPerson?.id === assignee ? selectedPerson : undefined;
  const selectedAssigneeAssignments = assignments.filter(item => item.assignee_id === assignee);
  function chooseAssignee(person: Person) {
    setAssignee(person.id); setSelectedPerson(person); setAssigneeSearch("");
    setFieldErrors(previous => { const next = { ...previous }; delete next.assignee; delete next.assignment; return next; });
    const existing = assignments.filter(item => item.assignee_id === person.id);
    if (!existing.length) { focusAssignmentDetails(); return; }
    setShowAssignForm(false);
    setOpenAssignmentEditor(existing[0].id);
    const projectId = selected;
    void (async () => {
      const cases = await Promise.all(existing.map(async item => [item.id, (await api(`/assignments/${encodeURIComponent(item.id)}/cases`)).cases] as const));
      if (selectedRef.current !== projectId) return;
      setAssignmentCases(previous => ({ ...previous, ...Object.fromEntries(cases) }));
      window.requestAnimationFrame(() => document.getElementById(`assignment-${existing[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    })().catch(error => { if (selectedRef.current === projectId) setError(error instanceof Error ? error.message : "Could not load existing case assignments."); });
  }
  function assignCasesNow() {
    if (!validateAssignmentFields()) return;
    void run(async () => {
      const id = selected;
      const result = await api(`/projects/${id}/assignments`, post(assignmentBody()));
      if (selectedRef.current !== id) return;
      setCaseInput(""); setAssignee(""); setSelectedPerson(null); setAssigneeSearch(""); setAssignablePeople([]); setPeopleSearchMessage("");
      setAssignmentNote(""); setAssignmentDue(""); setLimitTargets(false); setAssignmentTargets([]); setFieldErrors({});
      if (csvInputRef.current) csvInputRef.current.value = "";
      if (csvImportRef.current) csvImportRef.current.open = false;
      setNotice(`${result.matched.length} cases assigned${result.missing.length ? `; ${result.missing.length} unavailable` : ""}.`);
      void refreshReviews(id).catch(error => {
        if (selectedRef.current === id) setError(`Assignment was created, but the assignment list could not refresh: ${error instanceof Error ? error.message : "request failed"}`);
      });
      window.requestAnimationFrame(() => { personPickerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); document.getElementById("annotation-team-member-search")?.focus({ preventScroll: true }); });
    });
  }
  const canManageProject = Boolean(chosen?.can_manage);
  const assignedCaseCount = assignments.reduce((total, item) => total + item.case_count, 0);
  const publishedCaseCount = assignments.reduce((total, item) => total + (item.counts.published ?? 0), 0);
  const reviewQuery = reviewFilter.trim().toLowerCase();
  const matchesReview = (item: Review) => [item.case_key, item.submitted_by_name, assignments.find(a => a.id === item.assignment_id)?.assignee_name ?? ""].some(value => value.toLowerCase().includes(reviewQuery));
  const visibleWaiting = waiting.filter(matchesReview);
  const visibleApproved = approved.filter(matchesReview);
  useEffect(() => {
    setEditName(chosen?.name ?? ""); setEditDescription(chosen?.description ?? "");
    /* setEditReviewer(chosen?.reviewer_id ?? ""); */
    setEditDue(chosen?.due_at ? chosen.due_at.slice(0, 10) : "");
  }, [chosen?.id, chosen?.name, chosen?.description, chosen?.due_at]);
  return <><section className="annotation-projects" aria-busy={busy}>
    {error && <div className="annotation-projects__toast annotation-projects__toast--error" role="alert">{error}</div>}
    {busy && <div className="annotation-projects__toast" role="status">Working…</div>}
    {notice && notice !== "Project updated." && <div className="annotation-projects__toast" role="status" aria-live="polite">{notice}</div>}
    {enabled === null ? <p role="status">Loading annotation projects…</p> : !enabled ? <p>Annotation projects are unavailable.</p> : <>
      <div className="annotation-projects__topbar">
        <div className="annotation-projects__selector-row">
          <label className={`annotation-projects__select-label ${fieldErrors.project ? "has-error" : ""}`}>
            <span>Project:</span>
            <select
              aria-label="Project"
              aria-invalid={fieldErrors.project ? "true" : "false"}
              aria-describedby={fieldErrors.project ? "project-field-error" : undefined}
              value={selected}
              disabled={busy}
              onChange={e => { setNotice(""); setError(""); setFieldErrors({}); setSelected(e.target.value); }}
            >
              <option value="">Choose a project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {fieldErrors.project && <small id="project-field-error" className="annotation-projects__field-error">{fieldErrors.project}</small>}
        </div>
        <div className="annotation-projects__topbar-actions">
        {/* Join a team button commented out for global users flow */}
        <details ref={createProjectRef} className="annotation-projects__create">
          <summary><span aria-hidden="true">＋</span> New project</summary>
          <div className="annotation-projects__form">
            <div className="annotation-projects__form-heading"><div><h3>Create project</h3><p>Start with a name and dataset. Structures and settings can be tuned anytime in Settings.</p></div><button type="button" className="annotation-projects__form-close" aria-label="Close new project form" title="Close" onClick={() => { if (createProjectRef.current) createProjectRef.current.open = false; }}><IconX size={18} aria-hidden="true" /></button></div>
            <label className={fieldErrors.projectName ? "has-error" : ""}>Project name <input className="set-input" aria-label="Project name" placeholder="e.g. Pancreas Ductal Study" aria-invalid={fieldErrors.projectName ? "true" : "false"} aria-describedby={fieldErrors.projectName ? "new-project-name-error" : undefined} value={name} onChange={e => { setName(e.target.value); setFieldErrors(previous => { const next = { ...previous }; delete next.projectName; return next; }); }} />{fieldErrors.projectName && <small id="new-project-name-error" className="annotation-projects__field-error">{fieldErrors.projectName}</small>}</label>
            <label>Dataset <select value={source} onChange={e => setSource(e.target.value)}><option value="pants">PanTS</option><option value="cancerverse">CancerVerse</option><option value="abdomenatlas">AbdomenAtlas</option></select></label>
            <label>Project instructions (optional) <textarea className="set-input" placeholder="Guidance for annotators..." value={description} onChange={e => setDescription(e.target.value)} /></label>
            <details className="annotation-projects__advanced"><summary>Optional settings (custom structures, starting mask, due date)</summary>
              <div className="annotation-projects__form-grid">
                <label>Starting mask <select value={baseline} onChange={e => setBaseline(e.target.value)}><option value="canonical">Published mask</option><option value="empty">Empty mask</option><option value="seed">Upload masks</option></select></label>
                <label>Project due date <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /><small>Optional · UTC</small></label>
              </div>
              <label>Custom structure index <input type="number" min={segmentation_categories.length + 1} max={255} value={customIndex} onChange={e => setCustomIndex(e.target.value)} /></label>
              <label>Custom structure name <input className="set-input" value={customName} onChange={e => setCustomName(e.target.value)} /></label>
              <button type="button" onClick={() => void run(async () => { const id = Number(customIndex); if (!Number.isInteger(id) || id <= segmentation_categories.length || id > 255 || !customName.trim()) throw new Error("Enter a custom label index and name."); setCustomTargets(old => ({ ...old, [String(id)]: customName.trim() })); setCustomIndex(""); setCustomName(""); })}>Add custom target</button>
              {Object.entries(customTargets).map(([id, label]) => <p key={id}>{id}: {label} <button type="button" onClick={() => setCustomTargets(old => { const next = { ...old }; delete next[id]; return next; })}>Remove</button></p>)}
              <fieldset className={fieldErrors.projectTargets ? "has-error" : ""} aria-invalid={fieldErrors.projectTargets ? "true" : "false"}><legend>Structures in this project</legend><div className="annotation-projects__select-all"><span>Choose structures.</span><button type="button" disabled={targets.length === segmentation_categories.length} onClick={() => { setTargets(segmentation_categories.map((_, index) => index + 1)); setFieldErrors(previous => { const next = { ...previous }; delete next.projectTargets; return next; }); }}>Select all</button></div><div className="annotation-projects__targets">{segmentation_categories.map((label, index) => <label key={label}><input type="checkbox" checked={targets.includes(index + 1)} onChange={e => { setTargets(old => e.target.checked ? [...old, index + 1] : old.filter(id => id !== index + 1)); setFieldErrors(previous => { const next = { ...previous }; delete next.projectTargets; return next; }); }} /> {label.replaceAll("_", " ")}</label>)}</div>{fieldErrors.projectTargets && <small className="annotation-projects__field-error">{fieldErrors.projectTargets}</small>}</fieldset>
            </details>
            <button className="annotation-projects__primary" type="button" disabled={busy} onClick={() => {
              const createErrors: Record<string, string> = {};
              if (!name.trim()) createErrors.projectName = "Enter a project name.";
              setFieldErrors(previous => { const next = { ...previous }; delete next.projectName; return { ...next, ...createErrors }; });
              if (Object.keys(createErrors).length) return;
              void run(async () => {
                const effectiveTargets = targets.length ? targets : (Object.keys(customTargets).length ? [] : segmentation_categories.map((_, i) => i + 1));
                const names = { ...Object.fromEntries(effectiveTargets.map(id => [String(id), segmentation_categories[id - 1].replaceAll("_", " ")])), ...customTargets };
                const labels = [...effectiveTargets, ...Object.keys(customTargets).map(Number)];
                const created = await api("/projects", post({ name: name.trim(), description: description.trim() || null, due_at: dueDate ? `${dueDate}T23:59:59Z` : null, scan_source: source, baseline_mode: baseline, target_labels: labels, target_names: names, reviewer_id: reviewer && reviewer !== "__choose__" ? reviewer : null }));
                await refreshProjects(); setSelected(created.id); setWorkflowStep(1); if (createProjectRef.current) createProjectRef.current.open = false; setName(""); setDescription(""); setDueDate(""); setTargets([]); setCustomTargets({}); setReviewer(""); setFieldErrors({});
              }, "Project created.");
            }}>Create project</button>
          </div>
        </details>
        </div>
      </div>
      {chosen ? (
        <div className="annotation-projects__workspace">
          <aside className="annotation-projects__aside">
            <div className="annotation-projects__aside-card">
              <div className="annotation-projects__project-card">
                <div>
                  <h3>{chosen.name}</h3>
                  {chosen.description && <p className="annotation-projects__desc">{chosen.description}</p>}
                </div>
                <span className={`annotation-projects__status annotation-projects__status--${chosen.status}`}>{chosen.status}</span>
              </div>
              <div className="annotation-projects__metrics" aria-label="Project progress">
                <div><strong>{assignments.length}</strong><span>assignments</span></div>
                <div><strong>{assignedCaseCount}</strong><span>case assignments</span></div>
                <div><strong>{publishedCaseCount}</strong><span>published</span></div>
                <div><strong>{waiting.length + approved.length}</strong><span>in review</span></div>
              </div>
            </div>
            {canManageProject && chosen.status === "open" && <details className="annotation-projects__admin"><summary>Edit project details</summary>
              <label>Name <input className="set-input" value={editName} onChange={e => { setEditName(e.target.value); setNotice(""); setError(""); }} /></label>
              <label>Project instructions <textarea className="set-input" value={editDescription} onChange={e => { setEditDescription(e.target.value); setNotice(""); setError(""); }} /></label>
              <label>Due date (UTC) <input type="date" value={editDue} onChange={e => { setEditDue(e.target.value); setNotice(""); setError(""); }} /></label>
              <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/projects/${selected}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editName, description: editDescription.trim() || null, due_at: editDue ? `${editDue}T23:59:59Z` : null }) }); await refreshProjects(); }, "Project updated.")}>{busy ? "Saving…" : "Save project"}</button>
              {notice === "Project updated." && <p className="annotation-projects__save-status" role="status">Project saved.</p>}
            </details>}
            <details className="annotation-projects__admin"><summary>Project files and controls</summary>
            {canManageProject && chosen.baseline_mode === "seed" && chosen.status === "open" && <div><label>Seed ZIP <input type="file" accept=".zip,application/zip" onChange={e => setSeedFile(e.target.files?.[0] ?? null)} /></label>
              <button type="button" disabled={!seedFile} onClick={() => void run(async () => { if (!seedFile) return; const data = new FormData(); data.append("file", seedFile); await api(`/projects/${selected}/seed`, { method: "POST", body: data }); setSeedFile(null); })}>Upload mask</button></div>}
            <a href={`${API_BASE}/api/projects/${encodeURIComponent(selected)}/export.csv`}>Download progress CSV</a>
            <button type="button" disabled={busy} onClick={() => void run(async () => { const projectId = selected; const result = await api(`/projects/${encodeURIComponent(projectId)}/storage`); if (selectedRef.current === projectId) setStorage(result); })}>Measure project storage</button>
            {storage && <div><p>Project annotation files: {(storage.bytes / (1024 ** 3)).toFixed(2)} GiB across {storage.files} files. This includes saved drafts and submission snapshots.</p>
              {storage.noncurrent_drafts && storage.unreferenced_submissions && <p>{storage.noncurrent_drafts.files} draft files are not current ({(storage.noncurrent_drafts.bytes / (1024 ** 2)).toFixed(1)} MiB); {storage.unreferenced_submissions.files} submission files are not referenced by a submission ({(storage.unreferenced_submissions.bytes / (1024 ** 2)).toFixed(1)} MiB). These counts are informational and do not mean files are safe to delete.</p>}</div>}
            {canManageProject && chosen.status === "open" && <button type="button" onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "PROJECT CONTROL", title: "Close this project?", description: "New drafts and submissions will stop. Existing submissions can still be reviewed. Unfinished cases stay assigned until you release or complete them.", confirmLabel: "Close project", success: "Project closed.", action: async () => { await api(`/projects/${selected}/close`, post({})); await refreshProjects(); } }); }}>Close project</button>}
            {chosen.status === "closed" && <p>Unfinished assigned cases remain protected from direct shared saves. The project creator can reopen the project or release individual unfinished cases below.</p>}
            {canManageProject && chosen.status === "closed" && <button type="button" disabled={busy} onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "PROJECT CONTROL", title: "Reopen this project?", description: "Assigned team members will be able to resume eligible cases and submit work again.", confirmLabel: "Reopen project", success: "Project reopened.", action: async () => { await api(`/projects/${selected}/reopen`, post({})); await refreshProjects(); } }); }}>Reopen project</button>}
            </details>
          </aside>

          <main className="annotation-projects__main">
            <div className="annotation-projects__steps" role="list" aria-label="Project workflow">{[[1,"Assign scans"],[2,"Review & publish"]].map(([step,label],index)=><Fragment key={step}>{index>0&&<i aria-hidden="true"/>}<button type="button" role="listitem" className={workflowStep===step?"is-current":""} aria-current={workflowStep===step?"step":undefined} onClick={()=>navigateToStep(Number(step))}><b>{String(step).padStart(2,"0")}</b> {label}</button></Fragment>)}</div>

            {workflowStep===1&&<section className="annotation-projects__section"><div className="annotation-projects__section-heading"><div><span className="annotation-projects__step-label">STEP 1</span><h3>Assign scans</h3><p>Choose a radiologist and assign their case range.</p></div></div>
        {assignments.length === 0 && <p className="annotation-projects__empty"><strong>No assignments yet</strong><br />Choose a team member, then assign their cases below.</p>}
        {canManageProject && chosen.status === "open" && <div ref={personPickerRef} className="annotation-projects__person-picker">
          <p><strong>Assign cases to a team member</strong><br />Search or choose any registered user from the database below.</p>
          {assignee && <div className="annotation-projects__selected-person" role="status">
            <div><small>Selected for this assignment</small><strong>{selectedAssignee?.name || selectedAssignee?.email || "Team member"}</strong>{selectedAssignee?.name && <span>{selectedAssignee.email}</span>}</div>
            <button type="button" disabled={busy} onClick={() => { setAssignee(""); setSelectedPerson(null); setAssigneeSearch(""); setAssignablePeople(allRegisteredPeople); }}>Change</button>
          </div>}
          {selectedAssigneeAssignments.length > 0 && <div className="annotation-projects__existing-assignment" role="status">
            <strong>Existing assignment found</strong>
            <p>This person already has {selectedAssigneeAssignments.reduce((total, item) => total + item.case_count, 0)} assigned cases. Their current cases and assignment details are shown below. You can edit the existing details or add another case range.</p>
            <button type="button" disabled={busy} onClick={() => { setShowAssignForm(true); window.requestAnimationFrame(() => { assignmentFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); document.getElementById("annotation-assignment-cases")?.focus({ preventScroll: true }); }); }}>Assign another range</button>
          </div>}
          {!assignee && <div className="annotation-projects__person-search">
            <label htmlFor="annotation-team-member-search">Search team members</label>
            <input id="annotation-team-member-search" className="set-input" type="search" role="combobox" aria-label="Search team members" aria-autocomplete="list" aria-expanded={assignablePeople.length > 0} aria-controls="annotation-team-member-results" aria-describedby="annotation-team-member-hint" placeholder="Search registered users by name or email…" value={assigneeSearch} onChange={e => { setAssigneeSearch(e.target.value); }} />
            <small id="annotation-team-member-hint">{loadingPeople ? "Loading users in database…" : `All registered users in database (${assignablePeople.length}):`}</small>
            {assignablePeople.length > 0 && <div id="annotation-team-member-results" className="annotation-projects__person-results" role="listbox" aria-label="Matching team members">
              {assignablePeople.map(person => <button key={person.id} type="button" role="option" aria-selected="false" disabled={busy} onClick={() => chooseAssignee(person)}>
                <strong>{person.name || person.email}</strong><span>{person.email}</span>
              </button>)}
            </div>}
          </div>}
          {peopleSearchMessage && <p className="annotation-projects__people-search-message" role="status" aria-live="polite">{peopleSearchMessage}</p>}
          {fieldErrors.assignee && <small id="assignee-field-error" className="annotation-projects__field-error">{fieldErrors.assignee}</small>}
          {/* Invite code system commented out
          <details className="annotation-projects__inline-invite">
            <summary><span aria-hidden="true">＋</span> Invite a radiologist</summary>
            <div className="annotation-projects__inline-invite-body">
              <p>Create a one-time code here. They redeem it under Team access, then you can search for them and assign cases.</p>
            </div>
          </details>
          */}
        </div>}
        {assignments.map(item => <div className="annotation-projects__assignment" id={`assignment-${item.id}`} key={item.id}><div className="annotation-projects__assignment-top"><strong>{item.assignee_name || "Needs reassignment"}</strong><span>{item.case_count} cases</span><span>{item.counts.published ?? 0} published</span></div>
          <p>{[
            ["not_started", "not started"], ["in_progress", "in progress"], ["submitted", "awaiting review"],
            ["rework", "changes requested"], ["approved", "approved"], ["unavailable", "unavailable"], ["released", "released"],
          ].filter(([status]) => (item.counts[status] ?? 0) > 0).map(([status, label]) => `${item.counts[status]} ${label}`).join(" · ") || "No outstanding cases."}</p>
          {item.assignee_id && item.assignee_has_access === false && <p>This person no longer has team access. Transfer this assignment.</p>}
          <p>Structures: {(item.target_labels ?? chosen.target_labels).map(id => chosen.target_names[String(id)] || `Structure ${id}`).join(", ")}</p>
          {canManageProject && chosen.status === "open" && <details open={openAssignmentEditor === item.id} onToggle={event => { if (event.currentTarget.open) { setOpenAssignmentEditor(item.id); setAssignmentEdits(old => ({ ...old, [item.id]: { note: item.note ?? "", due: item.due_at?.slice(0, 10) ?? "" } })); } else if (openAssignmentEditor === item.id) setOpenAssignmentEditor(null); }}><summary>Edit assignment details</summary>
            <label>Instructions for {item.assignee_name || "this assignment"} <textarea className="set-input" value={assignmentEdits[item.id]?.note ?? ""} onChange={e => setAssignmentEdits(old => ({ ...old, [item.id]: { note: e.target.value, due: old[item.id]?.due ?? "" } }))} /></label>
            <label>Due date for {item.assignee_name || "this assignment"} <input type="date" value={assignmentEdits[item.id]?.due ?? ""} onChange={e => setAssignmentEdits(old => ({ ...old, [item.id]: { note: old[item.id]?.note ?? "", due: e.target.value } }))} /></label>
            <button type="button" disabled={busy || !assignmentEdits[item.id]} onClick={() => void run(async () => { const edit = assignmentEdits[item.id]; await api(`/assignments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: edit.note.trim() || null, due_at: edit.due ? `${edit.due}T23:59:59Z` : null }) }); await refreshReviews(selected); }, "Assignment details updated.")}>Save assignment details</button>
          </details>}
          <button type="button" disabled={busy} aria-expanded={Boolean(assignmentCases[item.id])} onClick={() => {
            if (assignmentCases[item.id]) { setAssignmentCases(old => { const next = { ...old }; delete next[item.id]; return next; }); return; }
            const projectId = selected;
            void run(async () => { const result = await api(`/assignments/${encodeURIComponent(item.id)}/cases`); if (selectedRef.current === projectId) setAssignmentCases(old => ({ ...old, [item.id]: result.cases })); });
          }}>{assignmentCases[item.id] ? "Hide cases" : "View case progress"}</button>
          {assignmentCases[item.id] && <ul aria-label={`Case progress for ${item.assignee_name || "unassigned"}`}>
            {assignmentCases[item.id].map(row => <li key={row.case_key}>{row.case_key} · {row.status.replaceAll("_", " ")}{row.unavailable_reason ? ` · ${row.unavailable_reason}` : ""}
              {canManageProject && chosen.status === "open" && row.status === "unavailable" && <button type="button" disabled={busy} onClick={() => void run(async () => { const projectId = selected; await api(`/assignments/${encodeURIComponent(item.id)}/cases/${encodeURIComponent(row.case_key)}/retry-availability`, post({})); await refreshReviews(projectId); const result = await api(`/assignments/${encodeURIComponent(item.id)}/cases`); if (selectedRef.current === projectId) setAssignmentCases(old => ({ ...old, [item.id]: result.cases })); }, "Case is available for annotation.")}>Recheck availability</button>}
              {canManageProject && ["not_started", "in_progress", "rework"].includes(row.status) && <button type="button" disabled={busy} onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "CASE RELEASE", title: "Release this case?", caseKey: row.case_key, description: "This removes the case from this assignment. Its saved draft and review history stay on the server but become read-only. It can be assigned again if no other assignment protects it.", confirmLabel: "Release case", success: "Case released; its existing draft was retained.", action: async () => { await api(`/assignments/${encodeURIComponent(item.id)}/cases/${encodeURIComponent(row.case_key)}/release`, post({})); await refreshReviews(selected); const result = await api(`/assignments/${encodeURIComponent(item.id)}/cases`); if (selectedRef.current === selected) setAssignmentCases(old => ({ ...old, [item.id]: result.cases })); } }); }}>Release case</button>}
            </li>)}
          </ul>}
          {canManageProject && chosen.status === "open" && <><button type="button" disabled={busy || !assignee || assignee === item.assignee_id || !((item.counts.not_started ?? 0) + (item.counts.in_progress ?? 0) + (item.counts.rework ?? 0))} onClick={event => { const person = selectedPerson; confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "TRANSFER WORK", title: "Transfer unfinished cases?", description: `Move editable cases and their drafts to ${person?.name || person?.email || "the selected team member"}. Submitted, approved and published cases stay with this assignment.`, confirmLabel: "Transfer unfinished", success: "Unfinished cases transferred.", action: async () => { const result = await api(`/assignments/${item.id}/transfer-unfinished`, post({ assignee_id: assignee })); setAssignmentCases(old => { const next = { ...old }; delete next[item.id]; return next; }); await refreshReviews(selected); setNotice(`${result.transferred_cases} cases transferred.`); } }); }}>Transfer unfinished cases</button>
          <button type="button" disabled={busy || !assignee || assignee === item.assignee_id} onClick={event => { const person = selectedPerson; confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "TRANSFER ASSIGNMENT", title: "Transfer the entire assignment?", description: `Move all ${item.case_count} cases, including drafts and submitted or published work, to ${person?.name || person?.email || "the selected team member"}. The current team member will lose access through this assignment.`, confirmLabel: "Transfer assignment", success: "Assignment transferred.", action: async () => { await api(`/assignments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignee_id: assignee }) }); await refreshReviews(selected); } }); }}>Transfer entire assignment</button></>}</div>)}
        {canManageProject && chosen.status === "open" && showAssignForm && <div ref={assignmentFormRef} className="annotation-projects__assign" id="project-assignment-form">
          {showAssignForm && <button className="annotation-projects__assign-close" type="button" onClick={() => setShowAssignForm(false)}>Hide assignment form</button>}
          {showAssignForm && <div className="annotation-projects__assign-form">
          <label>Instructions for this assignment <textarea className="set-input" value={assignmentNote} onChange={e => setAssignmentNote(e.target.value)} /></label>
          <label>Assignment due date (UTC, optional) <input type="date" value={assignmentDue} onChange={e => setAssignmentDue(e.target.value)} /></label>
          <label><input type="checkbox" checked={limitTargets} onChange={e => { setLimitTargets(e.target.checked); setAssignmentTargets(e.target.checked ? [...chosen.target_labels] : []); }} /> Limit this assignment to selected project structures</label>
          {limitTargets && <fieldset><legend>Assignment structures</legend>{chosen.target_labels.map(id => <label key={id}><input type="checkbox" checked={assignmentTargets.includes(id)} onChange={e => setAssignmentTargets(old => e.target.checked ? [...old, id] : old.filter(value => value !== id))} /> {chosen.target_names[String(id)] || `Structure ${id}`}</label>)}</fieldset>}
          <div className="annotation-projects__case-range-row">
            <label className={fieldErrors.cases ? "has-error" : ""}>Cases and ranges <input id="annotation-assignment-cases" className="set-input" aria-label="Cases and ranges" aria-invalid={fieldErrors.cases ? "true" : "false"} aria-describedby={fieldErrors.cases ? "cases-field-error" : undefined} placeholder="55–95, 145–200" value={caseInput} onChange={e => { setCaseInput(e.target.value); setFieldErrors(previous => { const next = { ...previous }; delete next.cases; delete next.assignment; return next; }); }} />{fieldErrors.cases && <small id="cases-field-error" className="annotation-projects__field-error">{fieldErrors.cases}</small>}</label>
            <button type="button" className="annotation-projects__primary" disabled={busy} onClick={assignCasesNow}>Assign cases</button>
          </div>
          <small className="annotation-projects__hint">Enter case IDs or ranges, separated by commas.</small>
          <details ref={csvImportRef} className="annotation-projects__csv-import"><summary>Import case IDs from CSV</summary>
            <label>Choose a CSV with one case ID per row <input ref={csvInputRef} type="file" accept=".csv,text/csv" onChange={e => {
              const file = e.target.files?.[0]; if (!file) return;
              const projectId = selected;
              void run(async () => { const ids = parseAnnotationCaseCsv(await file.text()); if (selectedRef.current === projectId) setCaseInput(ids.join(", ")); });
            }} /></label>
          </details>
          </div>}
        </div>}
        </section>}
        {workflowStep===2&&<section className="annotation-projects__section annotation-projects__review-section"><div className="annotation-projects__section-heading"><div><span className="annotation-projects__step-label">STEP 2</span><h3>Review & publish</h3><p>Review submitted masks before they are added to the shared dataset.</p></div><div className="annotation-projects__review-counts"><span>{waiting.length} awaiting review</span><span>{approved.length} ready to publish</span></div></div>
        {chosen.status === "closed" && <p>This project is closed. Submissions can still be reviewed and published; reopen the project before asking team members to revise their work.</p>}
        <div className="annotation-projects__review-toolbar"><label htmlFor="annotation-review-search"><span>Find a case or person</span><input id="annotation-review-search" type="search" className="set-input" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const projectId = selected;
          const [pending, ready, progress] = await Promise.all([
            api(`/reviews?project=${encodeURIComponent(projectId)}&status=in_review`),
            api(`/reviews?project=${encodeURIComponent(projectId)}&status=approved`),
            api(`/projects/${encodeURIComponent(projectId)}/assignments`),
          ]);
          if (selectedRef.current !== projectId) return;
          setWaiting(pending.submissions); setApproved(ready.submissions); setAssignments(progress.assignments);
          setAssignmentCases({});
        }, "Review queue refreshed.")} className="annotation-projects__icon-button" aria-label="Refresh review queue" title="Refresh review queue"><IconRefresh size={18} aria-hidden="true" /></button></div>
        <div className="annotation-projects__review-lanes"><section className="annotation-projects__review-lane" aria-labelledby="annotation-awaiting-review"><div className="annotation-projects__review-lane-heading"><h4 id="annotation-awaiting-review">Awaiting review</h4><span>{visibleWaiting.length}</span></div>
        {visibleWaiting.length === 0 && <p className="annotation-projects__empty">{waiting.length === 0 ? "No submissions waiting for review." : "No waiting submissions match your search."}</p>}
        {Object.entries(visibleWaiting.reduce<Record<string, Review[]>>((groups, item) => { (groups[item.assignee_id || item.assignment_id] ??= []).push(item); return groups; }, {})).map(([assigneeId, submissions]) => <section key={assigneeId} aria-label={`Assigned work for ${assignments.find(a => a.assignee_id === assigneeId)?.assignee_name || "unassigned"}`}><h4>{assignments.find(a => a.assignee_id === assigneeId)?.assignee_name || "Unassigned"} · {submissions.length} awaiting review</h4>{submissions.map(item => <div className="annotation-projects__review" key={item.id}><span>{item.case_key} · v{item.version} · {item.submitted_by_name}</span>
          {item.note && <p>Team member note: {item.note}</p>}
          <Link to={`/case/${item.case_key}?assignment=${encodeURIComponent(item.assignment_id)}&submission=${encodeURIComponent(item.id)}&review=${encodeURIComponent(selected)}&hd=1`}>Open submission</Link>
          <label>Comment for {item.case_key} <input className="set-input" value={comments[item.id] ?? ""} onChange={e => setComments(old => ({ ...old, [item.id]: e.target.value }))} /></label>
          <label><input type="checkbox" checked={Boolean(notifyReview[item.id])} onChange={e => setNotifyReview(old => ({ ...old, [item.id]: e.target.checked }))} /> Email the assigned team member a generic notification</label>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/submissions/${item.id}/approve`, post({ comment: comments[item.id] ?? "" })); await refreshReviews(selected); }, "Submission approved. It is ready to publish.")}>Approve</button>
          <button type="button" disabled={busy} onClick={() => void run(() => requestRework(item))}>Request rework</button></div>)}</section>)}
        </section><section className="annotation-projects__review-lane" aria-labelledby="annotation-ready-to-publish"><div className="annotation-projects__review-lane-heading"><h4 id="annotation-ready-to-publish">Ready to publish</h4><span>{visibleApproved.length}</span></div>
        {visibleApproved.length === 0 && <p className="annotation-projects__empty">{approved.length === 0 ? "No submissions ready to publish." : "No approved submissions match your search."}</p>}
        {visibleApproved.map(item => <div className="annotation-projects__review" key={item.id}><span>{item.case_key} · {item.submitted_by_name}</span>
          <Link to={`/case/${item.case_key}?assignment=${encodeURIComponent(item.assignment_id)}&submission=${encodeURIComponent(item.id)}&review=${encodeURIComponent(selected)}&hd=1`}>Open submission</Link>
          <label>Comment for {item.case_key} <input className="set-input" value={comments[item.id] ?? ""} onChange={e => setComments(old => ({ ...old, [item.id]: e.target.value }))} /></label>
          <label><input type="checkbox" checked={Boolean(notifyReview[item.id])} onChange={e => setNotifyReview(old => ({ ...old, [item.id]: e.target.checked }))} /> Email the assigned team member a generic notification</label>
          <button type="button" disabled={busy} onClick={() => void run(() => requestRework(item))}>Request changes instead</button>
           <button type="button" disabled={busy} onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "PUBLISH", title: "Publish this submission?", caseKey: item.case_key, description: "The approved structures will be added to the shared dataset and become visible to its users.", confirmLabel: "Publish submission", success: "Published to the shared dataset.", action: async () => { await api(`/submissions/${item.id}/publish`, post({})); await refreshReviews(selected); } }); }}>Publish</button></div>)}
        </section></div>
        <details className="annotation-projects__history"><summary>Case history and restore</summary>
          <p>{canManageProject ? "Restoring changes only the structures in that submission." : "The project creator can restore a published version."}</p>
          <label>Case ID <input className="set-input" value={historyCase} onChange={e => { setHistoryCase(e.target.value); setHistory([]); }} /></label>
          <button type="button" onClick={() => void run(async () => { const data = await api(`/cases/${encodeURIComponent(historyCase)}/annotation-history`); setHistory(data.events); setHistoryCaseKey(data.case_key); })}>Show history</button>
          {history.filter(item => item.project_id === selected && item.submission_id && item.assignment_id && (item.action === "submit" || item.action === "edit")).map(item => <div className="annotation-projects__review" key={item.id}>
            <span>{item.action === "edit" ? "Reviewer edit" : "Submission"} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}</span>
            <Link to={`/case/${encodeURIComponent(historyCaseKey)}?assignment=${encodeURIComponent(item.submission_assignment_id || item.assignment_id!)}&submission=${encodeURIComponent(item.submission_id!)}&review=${encodeURIComponent(selected)}&hd=1`}>Open historical version</Link>
          </div>)}
          {history.filter(item => item.project_id === selected && (item.action === "approve" || item.action === "rework")).map(item => <p key={item.id}>{item.action === "approve" ? "Approved" : "Changes requested"} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}{item.comment ? ` · ${item.comment}` : ""}</p>)}
          {history.filter(item => item.project_id === selected && ["assign", "reassign", "release_case", "availability_restored", "publish", "republish"].includes(item.action)).map(item => <p key={item.id}>{({ assign: "Cases assigned", reassign: "Assignment transferred", release_case: "Case released", availability_restored: "Case availability restored", publish: "Published", republish: "Version restored" } as Record<string, string>)[item.action]} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}</p>)}
          {canManageProject && history.filter(item => item.project_id === selected && item.submission_id && (item.action === "approve" || item.action === "publish") && (item.submission_status === "approved" || item.submission_status === "published")).filter((item, index, all) => all.findIndex(other => other.submission_id === item.submission_id) === index).map(item => <div className="annotation-projects__review" key={item.id}>
            <span>{item.submission_status === "published" ? "Published" : "Previously approved"} · {new Date(item.created_at).toLocaleString()}</span>
            <button type="button" onClick={event => { if (!item.submission_id) return; const submissionId = item.submission_id; confirmationTriggerRef.current = event.currentTarget; setConfirmation({ eyebrow: "RESTORE VERSION", title: "Restore this submission?", caseKey: historyCase, description: "This republishes the selected historical version to the shared dataset, subject to the latest shared revision.", confirmLabel: "Restore version", success: "Historical version restored.", action: async () => {
              const id = submissionId;
              if (!rollbackRequests.current[id]) {
                try {
                  const saved = JSON.parse(localStorage.getItem(`bodymaps.rollback.${id}`) || "null");
                  if (typeof saved?.id === "string" && typeof saved?.revision === "string") rollbackRequests.current[id] = saved;
                } catch { /* storage is optional */ }
                if (!rollbackRequests.current[id]) {
                  const status = await api(`/shared-annotation/${encodeURIComponent(historyCase)}`);
                  if (!status.supported || !status.revision) throw new Error("Shared revision unavailable.");
                  rollbackRequests.current[id] = { id: crypto.randomUUID(), revision: status.revision };
                  try { localStorage.setItem(`bodymaps.rollback.${id}`, JSON.stringify(rollbackRequests.current[id])); } catch { /* retry remains available in this tab */ }
                }
              }
              const operation = rollbackRequests.current[id];
              await api(`/submissions/${encodeURIComponent(id)}/republish`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": operation.revision, "X-Operation-ID": operation.id }, body: "{}" });
              delete rollbackRequests.current[id];
              try { localStorage.removeItem(`bodymaps.rollback.${id}`); } catch { /* optional */ }
              setHistory((await api(`/cases/${encodeURIComponent(historyCase)}/annotation-history`)).events);
            } }); }}>Restore</button></div>)}
        </details></section>}
            {fieldErrors.assignment && workflowStep === 1 && <p className="annotation-projects__field-error" role="alert">{fieldErrors.assignment}</p>}
            <div className="annotation-projects__wizard-nav" aria-label="Workflow navigation">
              {workflowStep > 1 && <button type="button" disabled={busy} onClick={() => navigateToStep(workflowStep - 1)}>← Previous</button>}
              {workflowStep < 2 && <button type="button" className="annotation-projects__primary" disabled={busy} onClick={() => navigateToStep(workflowStep + 1)}>Next →</button>}
            </div>
          </main>
        </div>
      ) : (
        <div className="annotation-projects__empty-state">
          <p>Choose an annotation project above or create a new one to begin assigning cases and reviewing segmentations.</p>
        </div>
      )}
    </>}
  </section>{confirmation && createPortal(<div className="annotation-projects__confirm-backdrop">
    <section ref={confirmationRef} className="annotation-projects__confirm" role="alertdialog" aria-modal="true" aria-labelledby="annotation-confirm-title" aria-describedby="annotation-confirm-description" tabIndex={-1}>
      <div className="annotation-projects__confirm-heading">
        <span className="annotation-projects__confirm-icon" aria-hidden="true"><IconAlertTriangle size={21} stroke={1.8} /></span>
        <div><span className="annotation-projects__eyebrow">{confirmation.eyebrow || "CONFIRM ACTION"}</span><h2 id="annotation-confirm-title">{confirmation.title}</h2></div>
      </div>
      {confirmation.caseKey && <p className="annotation-projects__confirm-case">{confirmation.caseKey}</p>}
      <p id="annotation-confirm-description">{confirmation.description}</p>
      <div className="annotation-projects__confirm-actions">
        <button ref={confirmationCancelRef} type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
        <button type="button" className="annotation-projects__confirm-release" disabled={busy} onClick={confirmAction}>{busy ? "Working…" : confirmation.confirmLabel}</button>
      </div>
    </section>
  </div>, document.body)}</>;
}
