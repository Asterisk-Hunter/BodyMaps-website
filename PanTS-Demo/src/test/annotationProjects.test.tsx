import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AnnotationProjects from "../routes/Settings/AnnotationProjects";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lets a manager preview an assignment and review a submission", async () => {
  const project = { id: "project-1", name: "Ducts", status: "open", baseline_mode: "canonical", target_labels: [7], target_names: { "7": "Duct" }, reviewer_id: null, due_at: null };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes("capabilities")) body = { enabled: true, can_manage: true, can_review: true };
    else if (url.endsWith("/projects")) body = { projects: [project] };
    else if (url.includes("/people?")) body = { people: [{ id: "reader-1", name: "Reader", email: "reader@example.org", roles: ["annotator"] }] };
    else if (url.includes("/assignments") && init?.method === "POST") body = { matched: ["PanTS_00000055"], missing: [], conflicts: [] };
    else if (url.includes("/assignments")) body = { assignments: [{ id: "assignment-1", assignee_id: "reader-1", assignee_name: "Reader", case_count: 1, counts: { submitted: 1 } }] };
    else if (url.includes("status=in_review")) body = { submissions: [{ id: "sub-1", case_key: "PanTS_00000055", assignment_id: "assignment-1", assignee_id: "reader-1", submitted_by: "reviewer-1", submitted_by_name: "Reviewer", version: 2 }] };
    else if (url.includes("status=approved")) body = { submissions: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><AnnotationProjects /></MemoryRouter>);
  const picker = await screen.findByLabelText("Project");
  await screen.findByRole("option", { name: "Ducts" });
  fireEvent.change(picker, { target: { value: "project-1" } });
  expect(await screen.findByRole("heading", { name: "Reader · 1 awaiting review" })).toBeTruthy();
  expect(screen.getByText("PanTS_00000055 · v2 · Reviewer")).toBeTruthy();
  fireEvent.click(screen.getByText("Assign cases"));
  fireEvent.change(screen.getByLabelText("Find an annotator"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
  await within(screen.getByLabelText("Annotator")).findByRole("option", { name: "Reader (reader@example.org)" });
  fireEvent.change(screen.getByLabelText("Annotator"), { target: { value: "reader-1" } });
  fireEvent.change(screen.getByLabelText("Cases and ranges"), { target: { value: "55" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview cases" }));
  await waitFor(() => expect(screen.getByText(/1 available/)).toBeTruthy());
  expect(screen.getByRole("link", { name: "Open submission" }).getAttribute("href"))
    .toContain("assignment=assignment-1");
});
