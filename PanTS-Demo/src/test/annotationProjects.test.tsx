import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AnnotationProjects from "../routes/Settings/AnnotationProjects";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lets a project creator search accepted members, assign cases, and review submissions", async () => {
  const project = { id: "project-1", name: "Ducts", status: "open", baseline_mode: "canonical", target_labels: [7], target_names: { "7": "Duct" }, reviewer_id: null, due_at: null, can_manage: true };
  let assigned = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes("capabilities")) body = { enabled: true, can_manage: true, can_review: true };
    else if (url.endsWith("/projects")) body = { projects: [project] };
    else if (url.includes("/people?")) body = { people: [{ id: "reader-1", name: "Reader", email: "reader@example.org", roles: ["annotator"] }] };
    else if (url.includes("/assignments") && init?.method === "POST") { assigned = true; body = { id: "assignment-1", matched: ["PanTS_00000055"], missing: [] }; }
    else if (url.includes("/assignments")) body = { assignments: assigned ? [{ id: "assignment-1", assignee_id: "reader-1", assignee_name: "Reader", case_count: 1, counts: { submitted: 1 } }] : [] };
    else if (url.includes("status=in_review")) body = { submissions: [{ id: "sub-1", case_key: "PanTS_00000055", assignment_id: "assignment-1", assignee_id: "reader-1", submitted_by: "reviewer-1", submitted_by_name: "Reviewer", version: 2 }] };
    else if (url.includes("status=approved")) body = { submissions: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);
  const picker = await screen.findByLabelText("Project");
  await screen.findByRole("option", { name: "Ducts" });
  fireEvent.change(picker, { target: { value: "project-1" } });
  fireEvent.click(screen.getAllByRole("listitem")[0]);
  fireEvent.change(screen.getByLabelText("Search team members"), { target: { value: "reader" } });
  fireEvent.click(await screen.findByRole("option", { name: /Reader.*reader@example.org/ }));
  expect(screen.getAllByText("Reader").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Cases and ranges"), { target: { value: "55" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign cases" }));
  expect(await screen.findByRole("status")).toHaveTextContent("1 cases assigned");
  fireEvent.click(screen.getByText("Review & publish"));
  expect(await screen.findByRole("heading", { name: "Reader · 1 awaiting review" })).toBeTruthy();
  expect(screen.getByText("PanTS_00000055 · v2 · Reviewer")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open submission" }).getAttribute("href"))
    .toContain("assignment=assignment-1");
});

it("hides project controls when the signed-in annotator is not the creator", async () => {
  const project = { id: "project-1", name: "Ducts", status: "open", baseline_mode: "canonical", target_labels: [7], target_names: { "7": "Duct" }, reviewer_id: null, due_at: null, can_manage: false };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("capabilities")
      ? { enabled: true, can_manage: false, can_review: false }
      : url.endsWith("/projects") ? { projects: [project] } : { assignments: [], submissions: [], invites: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "project-1" } });
  expect(await screen.findByRole("heading", { name: "Ducts" })).toBeInTheDocument();
  expect(screen.getByText("New project")).toBeInTheDocument();
  expect(screen.queryByText("Edit project details")).not.toBeInTheDocument();
  expect(screen.queryByText("Assign cases")).not.toBeInTheDocument();
});

it("shows an empty state prompt when no project is selected and does not offer a next button", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("capabilities")
      ? { enabled: true, can_manage: true, can_review: true }
      : url.endsWith("/projects") ? { projects: [] } : { assignments: [], submissions: [], invites: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);

  expect(await screen.findByText(/Choose an annotation project above/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next →" })).not.toBeInTheDocument();
});

it("omits invite codes and displays registered database users directly in search", async () => {
  const project = { id: "project-1", name: "Ducts", status: "open", baseline_mode: "canonical", target_labels: [7], target_names: { "7": "Duct" }, reviewer_id: null, due_at: null, can_manage: true };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("capabilities")
      ? { enabled: true, can_manage: true, can_review: true }
      : url.endsWith("/projects") ? { projects: [project] }
        : url.includes("/annotation-projects/people") ? { people: [{ id: "db-user-1", name: "Dr. Smith", email: "smith@clinic.org" }] }
          : { assignments: [], submissions: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);

  fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "project-1" } });
  expect(screen.queryByText("Invite a radiologist")).not.toBeInTheDocument();
  expect(await screen.findByText("Dr. Smith")).toBeInTheDocument();
  expect(screen.getByText("smith@clinic.org")).toBeInTheDocument();
});

it("marks the case range when assigning without one", async () => {
  const project = { id: "project-1", name: "Ducts", status: "open", baseline_mode: "canonical", target_labels: [7], target_names: { "7": "Duct" }, reviewer_id: null, due_at: null, can_manage: true };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("capabilities")
      ? { enabled: true, can_manage: true, can_review: true }
      : url.includes("/annotation-projects/people")
        ? { people: [{ id: "reader-1", name: "Reader", email: "reader@example.org", roles: ["annotator"] }] }
        : url.includes("/projects") && !url.includes("assignments")
        ? { projects: [project] }
        : { assignments: [], submissions: [], invites: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);

  fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "project-1" } });
  // Directly on Assign scans
  fireEvent.change(await screen.findByLabelText("Search team members"), { target: { value: "reader" } });
  fireEvent.click(await screen.findByRole("option", { name: /Reader.*reader@example.org/ }));
  fireEvent.click(screen.getByRole("button", { name: "Assign cases" }));
  expect(await screen.findByLabelText("Cases and ranges")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("Enter one or more case IDs or ranges.")).toBeInTheDocument();
});
