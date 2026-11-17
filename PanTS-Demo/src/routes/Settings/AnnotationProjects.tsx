import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { API_BASE, segmentation_categories } from "../../helpers/constants";
import { parseAnnotationCaseCsv } from "../../helpers/annotationCaseCsv";
import AnnotatorCodes from "./AnnotatorCodes";

type Project = { id: string; name: string; description?: string | null; target_labels: number[]; target_names: Record<string, string>; status: string; baseline_mode: string; reviewer_id: string | null; reviewer_has_access?: boolean; due_at: string | null };
type Person = { id: string; name: string | null; email: string; roles?: string[] };
type Review = { id: string; case_key: string; assignment_id: string; assignee_id?: string | null; submitted_by?: string | null; submitted_by_name: string; version: number; note?: string | null };
type Preview = { matched: string[]; missing: { case_key: string; reason: string }[]; conflicts: string[] };
type Assignment = { id: string; assignee_id: string | null; assignee_name: string | null; assignee_has_access?: boolean; target_labels?: number[]; note?: string | null; due_at?: string | null; case_count: number; counts: Record<string, number> };
type AssignmentCase = { case_key: string; status: string; unavailable_reason?: string | null };
type HistoryEvent = { id: string; project_id: string; assignment_id: string | null; submission_id: string | null; submission_assignment_id?: string | null; submission_status?: string | null; action: string; actor_name: string; comment?: string | null; created_at: string };

async function api(path: string, options?: RequestInit) {
  const response = await fetch(`${API_BASE}/api${path}`, { credentials: "include", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const post = (data: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

export default function AnnotationProjects() {
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(() => searchParams.get("project") ?? "");
  const [storage, setStorage] = useState<{ bytes: number; files: number; noncurrent_drafts?: { bytes: number; files: number }; unreferenced_submissions?: { bytes: number; files: number } } | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
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
  const [search, setSearch] = useState("");
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [assignablePeople, setAssignablePeople] = useState<Person[]>([]);
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [caseInput, setCaseInput] = useState("");
  const [assignmentNote, setAssignmentNote] = useState("");
  const [assignmentDue, setAssignmentDue] = useState("");
  const [limitTargets, setLimitTargets] = useState(false);
  const [assignmentTargets, setAssignmentTargets] = useState<number[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewSignature = useRef("");
  const [waiting, setWaiting] = useState<Review[]>([]);
  const [approved, setApproved] = useState<Review[]>([]);
  const [reviewFilter, setReviewFilter] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentCases, setAssignmentCases] = useState<Record<string, AssignmentCase[]>>({});
  const [assignmentEdits, setAssignmentEdits] = useState<Record<string, { note: string; due: string }>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notifyReview, setNotifyReview] = useState<Record<string, boolean>>({});
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editReviewer, setEditReviewer] = useState("");
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
    setEnabled(data.enabled); setCanManage(data.can_manage); if (data.enabled && (data.can_manage || data.can_review)) void refreshProjects().catch(e => setError(e.message));
  }).catch(e => { setEnabled(false); setError(e.message); }); }, []);
  useEffect(() => { setStorage(null); setPreview(null); setWaiting([]); setApproved([]); setReviewFilter(""); setAssignments([]); setAssignmentCases({}); setComments({}); setLimitTargets(false); setAssignmentTargets([]); setAssignmentNote(""); setAssignmentDue(""); setCaseInput(""); setAssignee(""); if (selected) void refreshReviews(selected).catch(e => { if (selectedRef.current === selected) setError(e.message); }); }, [selected]);
  async function run(action: () => Promise<void>, success?: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); if (success) setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function requestRework(item: Review) {
    const notify = Boolean(notifyReview[item.id]);
    const result = await api(`/submissions/${item.id}/rework`, post({ comment: comments[item.id] ?? "", notify }));
    setNotice(!notify ? "Changes requested. The annotator can revise the draft." : result.notification === "accepted"
      ? "Changes requested. The mail server accepted the notification; delivery is not guaranteed."
      : "Changes requested, but email delivery could not be confirmed. Please notify the annotator another way.");
    await refreshReviews(selected);
  }
  function selector() {
    const ids: string[] = []; const ranges: { from: string; to: string }[] = [];
    for (const token of caseInput.split(/[\s,;]+/).filter(Boolean)) {
      const parts = token.split("-");
      if (parts.length === 1) ids.push(parts[0]);
      else if (parts.length === 2 && parts[0] && parts[1]) ranges.push({ from: parts[0], to: parts[1] });
      else throw new Error(`Invalid case range: ${token}`);
    }
    return { ids, ranges };
  }
  const assignmentBody = () => {
    if (limitTargets && assignmentTargets.length === 0) throw new Error("Select at least one structure for this assignment.");
    return { assignee_id: assignee, case_selector: selector(), note: assignmentNote.trim() || null, due_at: assignmentDue ? `${assignmentDue}T23:59:59Z` : null, ...(limitTargets ? { target_labels: assignmentTargets } : {}) };
  };
  const currentAssignmentSignature = JSON.stringify({ selected, assignee, caseInput, assignmentNote, assignmentDue, limitTargets, assignmentTargets });
  const currentAssignmentSignatureRef = useRef(currentAssignmentSignature);
  currentAssignmentSignatureRef.current = currentAssignmentSignature;
  const chosen = projects.find(p => p.id === selected);
  const reviewQuery = reviewFilter.trim().toLowerCase();
  const matchesReview = (item: Review) => [item.case_key, item.submitted_by_name, assignments.find(a => a.id === item.assignment_id)?.assignee_name ?? ""].some(value => value.toLowerCase().includes(reviewQuery));
  const visibleWaiting = waiting.filter(matchesReview);
  const visibleApproved = approved.filter(matchesReview);
  useEffect(() => {
    setEditName(chosen?.name ?? ""); setEditDescription(chosen?.description ?? ""); setEditReviewer(chosen?.reviewer_id ?? "");
    setEditDue(chosen?.due_at ? chosen.due_at.slice(0, 10) : "");
  }, [chosen?.id, chosen?.name, chosen?.description, chosen?.reviewer_id, chosen?.due_at]);
  return <section className="annotation-projects" aria-busy={busy}>
    <h2>Annotation projects</h2><p>Manage research assignments and review submitted masks.</p>
    {error && <p role="alert">{error}</p>}
    {(busy || notice) && <p role="status">{busy ? "Working…" : notice}</p>}
    {enabled === null ? <p role="status">Loading annotation projects…</p> : !enabled ? <p>Annotation projects are unavailable.</p> : <>
      {canManage && <details><summary>Invite annotators</summary><p>These codes grant the existing site-wide annotator role; assigning a project is a separate step.</p><AnnotatorCodes /></details>}
      {canManage && <details><summary>Create a project</summary>
        <label>Project name <input className="set-input" value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Instructions <textarea className="set-input" value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label>Due date (UTC, optional) <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
        <label>Dataset <select value={source} onChange={e => setSource(e.target.value)}><option value="pants">PanTS</option><option value="cancerverse">CancerVerse</option><option value="abdomenatlas">AbdomenAtlas</option></select></label>
        <label>Starting mask <select value={baseline} onChange={e => setBaseline(e.target.value)}><option value="canonical">Published mask</option><option value="empty">Empty mask</option><option value="seed">Uploaded seed masks</option></select></label>
        <label>Find a reviewer <input className="set-input" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <button type="button" onClick={() => void run(async () => setPeople((await api(`/annotation-projects/people?q=${encodeURIComponent(search)}`)).people))}>Search people</button>
        <label>Reviewer <select value={reviewer} onChange={e => setReviewer(e.target.value)}><option value="">Managers review this project</option>{people.map(p => <option key={p.id} value={p.id}>{p.name || p.email} ({p.email})</option>)}</select></label>
        <fieldset><legend>Target structures</legend><div className="annotation-projects__targets">{segmentation_categories.map((label, index) => <label key={label}><input type="checkbox" checked={targets.includes(index + 1)} onChange={e => setTargets(old => e.target.checked ? [...old, index + 1] : old.filter(id => id !== index + 1))} /> {label.replaceAll("_", " ")}</label>)}</div></fieldset>
        <label>Custom structure index <input type="number" min={segmentation_categories.length + 1} max={255} value={customIndex} onChange={e => setCustomIndex(e.target.value)} /></label>
        <label>Custom structure name <input className="set-input" value={customName} onChange={e => setCustomName(e.target.value)} /></label>
        <button type="button" onClick={() => void run(async () => { const id = Number(customIndex); if (!Number.isInteger(id) || id <= segmentation_categories.length || id > 255 || !customName.trim()) throw new Error("Enter a custom label index and name."); setCustomTargets(old => ({ ...old, [String(id)]: customName.trim() })); setCustomIndex(""); setCustomName(""); })}>Add custom target</button>
        {Object.entries(customTargets).map(([id, label]) => <p key={id}>{id}: {label} <button type="button" onClick={() => setCustomTargets(old => { const next = { ...old }; delete next[id]; return next; })}>Remove</button></p>)}
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const names = { ...Object.fromEntries(targets.map(id => [String(id), segmentation_categories[id - 1].replaceAll("_", " ")])), ...customTargets };
          const labels = [...targets, ...Object.keys(customTargets).map(Number)];
          const created = await api("/projects", post({ name, description: description.trim() || null, due_at: dueDate ? `${dueDate}T23:59:59Z` : null, scan_source: source, baseline_mode: baseline, target_labels: labels, target_names: names, reviewer_id: reviewer || null }));
          await refreshProjects(); setSelected(created.id); setName(""); setDescription(""); setDueDate(""); setTargets([]); setCustomTargets({});
        }, "Project created.")}>Create project</button>
      </details>}
      <label>Project <select value={selected} disabled={busy} onChange={e => { setNotice(""); setError(""); setSelected(e.target.value); }}><option value="">Choose a project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {chosen && <><p>Structures: {Object.values(chosen.target_names).join(", ")} · {chosen.status}</p>
        {canManage && chosen.reviewer_has_access === false && <p role="status">The assigned reviewer no longer has access. Restore their role or select another reviewer; managers can still review submissions.</p>}
        {canManage && chosen.status === "open" && <details><summary>Edit project</summary>
          <label>Name <input className="set-input" value={editName} onChange={e => setEditName(e.target.value)} /></label>
          <label>Project instructions <textarea className="set-input" value={editDescription} onChange={e => setEditDescription(e.target.value)} /></label>
          <label>Due date (UTC) <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)} /></label>
          <label>Find reviewer <input className="set-input" value={search} onChange={e => setSearch(e.target.value)} /></label>
          <button type="button" onClick={() => void run(async () => setPeople((await api(`/annotation-projects/people?q=${encodeURIComponent(search)}`)).people))}>Search people</button>
          <label>Reviewer <select value={editReviewer} onChange={e => setEditReviewer(e.target.value)}><option value="">Managers review</option>
            {editReviewer && !people.some(person => person.id === editReviewer) && <option value={editReviewer}>Current reviewer</option>}
            {people.map(person => <option key={person.id} value={person.id}>{person.name || person.email} ({person.email})</option>)}</select></label>
          <button type="button" onClick={() => void run(async () => { await api(`/projects/${selected}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editName, description: editDescription.trim() || null, reviewer_id: editReviewer || null, due_at: editDue ? `${editDue}T23:59:59Z` : null }) }); await refreshProjects(); }, "Project updated.")}>Save project</button>
        </details>}
        {canManage && chosen.baseline_mode === "seed" && chosen.status === "open" && <div><label>Seed ZIP <input type="file" accept=".zip,application/zip" onChange={e => setSeedFile(e.target.files?.[0] ?? null)} /></label>
          <button type="button" disabled={!seedFile} onClick={() => void run(async () => { if (!seedFile) return; const data = new FormData(); data.append("file", seedFile); await api(`/projects/${selected}/seed`, { method: "POST", body: data }); setSeedFile(null); })}>Upload seeds before assigning cases</button></div>}
        <a href={`${API_BASE}/api/projects/${encodeURIComponent(selected)}/export.csv`}>Download progress CSV</a>
        <button type="button" disabled={busy} onClick={() => void run(async () => { const projectId = selected; const result = await api(`/projects/${encodeURIComponent(projectId)}/storage`); if (selectedRef.current === projectId) setStorage(result); })}>Measure project storage</button>
        {storage && <div><p>Project annotation files: {(storage.bytes / (1024 ** 3)).toFixed(2)} GiB across {storage.files} files. This includes saved drafts and submission snapshots.</p>
          {storage.noncurrent_drafts && storage.unreferenced_submissions && <p>{storage.noncurrent_drafts.files} draft files are not current ({(storage.noncurrent_drafts.bytes / (1024 ** 2)).toFixed(1)} MiB); {storage.unreferenced_submissions.files} submission files are not referenced by a submission ({(storage.unreferenced_submissions.bytes / (1024 ** 2)).toFixed(1)} MiB). These counts are informational and do not mean files are safe to delete.</p>}</div>}
        {canManage && chosen.status === "open" && <button type="button" onClick={() => { if (window.confirm("Close this project to new drafts and submissions? Existing submissions can still be reviewed. Unfinished cases remain protected from direct shared saves until a manager releases them or their work is completed.")) void run(async () => { await api(`/projects/${selected}/close`, post({})); await refreshProjects(); }); }}>Close project</button>}
        {chosen.status === "closed" && <p>Unfinished assigned cases remain protected from direct shared saves. A manager can reopen the project or release individual unfinished cases below.</p>}
        {canManage && chosen.status === "closed" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Reopen this project so assigned annotators can resume their work?")) void run(async () => { await api(`/projects/${selected}/reopen`, post({})); await refreshProjects(); }, "Project reopened."); }}>Reopen project</button>}
        <h3>Assignments</h3>{assignments.length === 0 && <p>No cases assigned yet.</p>}
        {canManage && chosen.status === "open" && <div className="annotation-projects__person-picker">
          <p>Select an annotator to assign cases or transfer an existing assignment.</p>
          <label>Find an annotator <input className="set-input" value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)} /></label>
          <button type="button" disabled={busy} onClick={() => void run(async () => { const results: Person[] = ((await api(`/annotation-projects/people?q=${encodeURIComponent(assigneeSearch)}`)).people as Person[]).filter(person => person.roles?.includes("annotator")); setAssignablePeople(results); if (!results.some(person => person.id === assignee)) { setAssignee(""); setPreview(null); } if (!results.length) setNotice("No annotators found. Check the name or invite the person first."); })}>Search</button>
          <label>Annotator <select value={assignee} onChange={e => { setAssignee(e.target.value); setPreview(null); }}><option value="">Select a person</option>{assignablePeople.map(p => <option key={p.id} value={p.id}>{p.name || p.email} ({p.email})</option>)}</select></label>
        </div>}
        {assignments.map(item => <div className="annotation-projects__review" key={item.id}><span>{item.assignee_name || "Needs reassignment"} · {item.case_count} cases · {item.counts.published ?? 0} published</span>
          <p>{[
            ["not_started", "not started"], ["in_progress", "in progress"], ["submitted", "awaiting review"],
            ["rework", "changes requested"], ["approved", "approved"], ["unavailable", "unavailable"], ["released", "released"],
          ].filter(([status]) => (item.counts[status] ?? 0) > 0).map(([status, label]) => `${item.counts[status]} ${label}`).join(" · ") || "No outstanding cases."}</p>
          {item.assignee_id && item.assignee_has_access === false && <p>Annotator access has been removed. Restore access or transfer this assignment.</p>}
          <p>Structures: {(item.target_labels ?? chosen.target_labels).map(id => chosen.target_names[String(id)] || `Structure ${id}`).join(", ")}</p>
          {canManage && chosen.status === "open" && <details onToggle={event => { if (event.currentTarget.open) setAssignmentEdits(old => ({ ...old, [item.id]: { note: item.note ?? "", due: item.due_at?.slice(0, 10) ?? "" } })); }}><summary>Edit assignment details</summary>
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
              {canManage && chosen.status === "open" && row.status === "unavailable" && <button type="button" disabled={busy} onClick={() => void run(async () => { const projectId = selected; await api(`/assignments/${encodeURIComponent(item.id)}/cases/${encodeURIComponent(row.case_key)}/retry-availability`, post({})); await refreshReviews(projectId); const result = await api(`/assignments/${encodeURIComponent(item.id)}/cases`); if (selectedRef.current === projectId) setAssignmentCases(old => ({ ...old, [item.id]: result.cases })); }, "Case is available for annotation.")}>Recheck availability</button>}
              {canManage && ["not_started", "in_progress", "rework"].includes(row.status) && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Release ${row.case_key} from this assignment? Its draft and review history will be retained but become read-only. Direct shared saves and a new assignment may become possible if no other assignment protects this case.`)) void run(async () => { const projectId = selected; await api(`/assignments/${encodeURIComponent(item.id)}/cases/${encodeURIComponent(row.case_key)}/release`, post({})); await refreshReviews(projectId); const result = await api(`/assignments/${encodeURIComponent(item.id)}/cases`); if (selectedRef.current === projectId) setAssignmentCases(old => ({ ...old, [item.id]: result.cases })); }, "Case released; its existing draft was retained."); }}>Release case</button>}
            </li>)}
          </ul>}
          {canManage && chosen.status === "open" && <><button type="button" disabled={busy || !assignee || assignee === item.assignee_id || !((item.counts.not_started ?? 0) + (item.counts.in_progress ?? 0) + (item.counts.rework ?? 0))} onClick={() => { const person = assignablePeople.find(p => p.id === assignee); if (window.confirm(`Transfer unfinished editable cases and their drafts to ${person?.name || person?.email || "the selected annotator"}? Submitted, approved and published cases will remain in this assignment.`)) void run(async () => { const result = await api(`/assignments/${item.id}/transfer-unfinished`, post({ assignee_id: assignee })); setAssignmentCases(old => { const next = { ...old }; delete next[item.id]; return next; }); await refreshReviews(selected); setNotice(`${result.transferred_cases} cases transferred.`); }); }}>Transfer unfinished cases</button>
          <button type="button" disabled={busy || !assignee || assignee === item.assignee_id} onClick={() => { const person = assignablePeople.find(p => p.id === assignee); if (window.confirm(`Transfer all ${item.case_count} cases in this assignment to ${person?.name || person?.email || "the selected annotator"}? This includes drafts and cases already submitted or published. The current annotator will no longer have access through this assignment.`)) void run(async () => { await api(`/assignments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignee_id: assignee }) }); await refreshReviews(selected); }, "Assignment transferred."); }}>Transfer entire assignment</button></>}</div>)}
        {canManage && chosen.status === "open" && <details><summary>Assign cases</summary>
          <label>Assignment instructions (optional) <textarea className="set-input" value={assignmentNote} onChange={e => { setAssignmentNote(e.target.value); setPreview(null); }} /></label>
          <label>Assignment due date (UTC, optional) <input type="date" value={assignmentDue} onChange={e => { setAssignmentDue(e.target.value); setPreview(null); }} /></label>
          <label><input type="checkbox" checked={limitTargets} onChange={e => { setLimitTargets(e.target.checked); setAssignmentTargets(e.target.checked ? [...chosen.target_labels] : []); setPreview(null); }} /> Limit this assignment to selected project structures</label>
          {limitTargets && <fieldset><legend>Assignment structures</legend>{chosen.target_labels.map(id => <label key={id}><input type="checkbox" checked={assignmentTargets.includes(id)} onChange={e => { setAssignmentTargets(old => e.target.checked ? [...old, id] : old.filter(value => value !== id)); setPreview(null); }} /> {chosen.target_names[String(id)] || `Structure ${id}`}</label>)}</fieldset>}
          <label>Cases and ranges <input className="set-input" placeholder="55-95, 145-200" value={caseInput} onChange={e => { setCaseInput(e.target.value); setPreview(null); }} /></label>
          <label>Import a CSV with one case ID per row <input type="file" accept=".csv,text/csv" onChange={e => {
            const file = e.target.files?.[0]; if (!file) return;
            const projectId = selected;
            void run(async () => { const ids = parseAnnotationCaseCsv(await file.text()); if (selectedRef.current === projectId) { setCaseInput(ids.join(", ")); setPreview(null); } });
          }} /></label>
          <button type="button" disabled={busy} onClick={() => void run(async () => { const id = selected; const signature = currentAssignmentSignature; const result = await api(`/projects/${id}/assignments`, post({ ...assignmentBody(), dry_run: true })); if (selectedRef.current === id && currentAssignmentSignatureRef.current === signature) { previewSignature.current = signature; setPreview(result); } })}>Preview cases</button>
          {preview && <div aria-live="polite"><p>{preview.matched.length} available · {preview.missing.length} unavailable · {preview.conflicts.length} conflicts</p>
            {preview.matched.length > 0 && <details><summary>Show matched cases</summary><p>{preview.matched.join(", ")}</p></details>}
            {preview.missing.map(c => <p key={c.case_key}>{c.case_key}: {c.reason}</p>)}
            {preview.conflicts.length > 0 && <p>Already assigned: {preview.conflicts.join(", ")}</p>}
            <button type="button" disabled={busy || preview.conflicts.length > 0 || previewSignature.current !== currentAssignmentSignature} onClick={() => void run(async () => { if (previewSignature.current !== currentAssignmentSignatureRef.current) throw new Error("Assignment details changed. Preview the cases again."); await api(`/projects/${selected}/assignments`, post({ ...assignmentBody(), expected_matched: preview.matched })); setPreview(null); setCaseInput(""); await refreshReviews(selected); }, "Assignment created.")}>Create assignment</button></div>}
        </details>}
        <h3>Review queue</h3>
        {chosen.status === "closed" && <p>This project is closed. Submissions can still be reviewed and published; reopen the project before asking annotators to revise their work.</p>}
        <p>{waiting.length} awaiting review · {approved.length} ready to publish</p>
        <label>Find a case or person <input type="search" className="set-input" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)} /></label>
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
        }, "Review queue refreshed.")}>Refresh review queue</button>
        {visibleWaiting.length === 0 && <p>{waiting.length === 0 ? "No submissions waiting for review." : "No waiting submissions match your search."}</p>}
        {Object.entries(visibleWaiting.reduce<Record<string, Review[]>>((groups, item) => { (groups[item.assignee_id || item.assignment_id] ??= []).push(item); return groups; }, {})).map(([assigneeId, submissions]) => <section key={assigneeId} aria-label={`Assigned work for ${assignments.find(a => a.assignee_id === assigneeId)?.assignee_name || "unassigned"}`}><h4>{assignments.find(a => a.assignee_id === assigneeId)?.assignee_name || "Unassigned"} · {submissions.length} awaiting review</h4>{submissions.map(item => <div className="annotation-projects__review" key={item.id}><span>{item.case_key} · v{item.version} · {item.submitted_by_name}</span>
          {item.note && <p>Annotator note: {item.note}</p>}
          <Link to={`/case/${item.case_key}?assignment=${encodeURIComponent(item.assignment_id)}&submission=${encodeURIComponent(item.id)}&review=${encodeURIComponent(selected)}&hd=1`}>Open submission</Link>
          <label>Comment for {item.case_key} <input className="set-input" value={comments[item.id] ?? ""} onChange={e => setComments(old => ({ ...old, [item.id]: e.target.value }))} /></label>
          <label><input type="checkbox" checked={Boolean(notifyReview[item.id])} onChange={e => setNotifyReview(old => ({ ...old, [item.id]: e.target.checked }))} /> Email the assigned annotator a generic notification</label>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/submissions/${item.id}/approve`, post({ comment: comments[item.id] ?? "" })); await refreshReviews(selected); }, "Submission approved. It is ready to publish.")}>Approve</button>
          <button type="button" disabled={busy} onClick={() => void run(() => requestRework(item))}>Request rework</button></div>)}</section>)}
        <h3>Approved</h3>{visibleApproved.length === 0 && <p>{approved.length === 0 ? "No submissions ready to publish." : "No approved submissions match your search."}</p>}
        {visibleApproved.map(item => <div className="annotation-projects__review" key={item.id}><span>{item.case_key} · {item.submitted_by_name}</span>
          <Link to={`/case/${item.case_key}?assignment=${encodeURIComponent(item.assignment_id)}&submission=${encodeURIComponent(item.id)}&review=${encodeURIComponent(selected)}&hd=1`}>Open submission</Link>
          <label>Comment for {item.case_key} <input className="set-input" value={comments[item.id] ?? ""} onChange={e => setComments(old => ({ ...old, [item.id]: e.target.value }))} /></label>
          <label><input type="checkbox" checked={Boolean(notifyReview[item.id])} onChange={e => setNotifyReview(old => ({ ...old, [item.id]: e.target.checked }))} /> Email the assigned annotator a generic notification</label>
          <button type="button" disabled={busy} onClick={() => void run(() => requestRework(item))}>Request changes instead</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Publish the approved structures for ${item.case_key} to the shared dataset?`)) void run(async () => { await api(`/submissions/${item.id}/publish`, post({})); await refreshReviews(selected); }, "Published to the shared dataset."); }}>Publish</button></div>)}
        <details><summary>Case history and restore</summary>
          <p>{canManage ? "Restoring changes only the structures in that submission." : "A project manager can restore a published version."}</p>
          <label>Case ID <input className="set-input" value={historyCase} onChange={e => { setHistoryCase(e.target.value); setHistory([]); }} /></label>
          <button type="button" onClick={() => void run(async () => { const data = await api(`/cases/${encodeURIComponent(historyCase)}/annotation-history`); setHistory(data.events); setHistoryCaseKey(data.case_key); })}>Show history</button>
          {history.filter(item => item.project_id === selected && item.submission_id && item.assignment_id && (item.action === "submit" || item.action === "edit")).map(item => <div className="annotation-projects__review" key={item.id}>
            <span>{item.action === "edit" ? "Reviewer edit" : "Submission"} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}</span>
            <Link to={`/case/${encodeURIComponent(historyCaseKey)}?assignment=${encodeURIComponent(item.submission_assignment_id || item.assignment_id!)}&submission=${encodeURIComponent(item.submission_id!)}&review=${encodeURIComponent(selected)}&hd=1`}>Open historical version</Link>
          </div>)}
          {history.filter(item => item.project_id === selected && (item.action === "approve" || item.action === "rework")).map(item => <p key={item.id}>{item.action === "approve" ? "Approved" : "Changes requested"} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}{item.comment ? ` · ${item.comment}` : ""}</p>)}
          {history.filter(item => item.project_id === selected && ["assign", "reassign", "release_case", "availability_restored", "publish", "republish"].includes(item.action)).map(item => <p key={item.id}>{({ assign: "Cases assigned", reassign: "Assignment transferred", release_case: "Case released", availability_restored: "Case availability restored", publish: "Published", republish: "Version restored" } as Record<string, string>)[item.action]} · {item.actor_name} · {new Date(item.created_at).toLocaleString()}</p>)}
          {canManage && history.filter(item => item.project_id === selected && item.submission_id && (item.action === "approve" || item.action === "publish") && (item.submission_status === "approved" || item.submission_status === "published")).filter((item, index, all) => all.findIndex(other => other.submission_id === item.submission_id) === index).map(item => <div className="annotation-projects__review" key={item.id}>
            <span>{item.submission_status === "published" ? "Published" : "Previously approved"} · {new Date(item.created_at).toLocaleString()}</span>
            <button type="button" onClick={() => { if (!item.submission_id || !window.confirm(`Restore this submission for ${historyCase}?`)) return; void run(async () => {
              const id = item.submission_id!;
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
            }); }}>Restore</button></div>)}
        </details>
      </>}
    </>}
  </section>;
}
