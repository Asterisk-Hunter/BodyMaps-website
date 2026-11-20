# Single Assignment Workspace Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` and work inline, task by task. Do not use subagents.

**Goal:** Present project assignments, upstream range handouts, and assigned work through one coherent `/assignments` workspace without losing existing behaviors or records.

**Architecture:** Keep the project and range-assignment APIs/models intact for this iteration, and consolidate their frontend navigation and screens in the existing Assignments route. Use the upstream person-card hierarchy, embed the project setup/assign/review flow, combine project and range personal queues, and redirect former work/management URLs to the canonical route.

**Tech Stack:** React, TypeScript, React Router, Flask APIs, existing Vitest/pytest suites.

**Spec:** `docs/superpowers/specs/2026-11-19-single-assignment-workspace-design.md`

## Global Constraints

- `/assignments` is the one canonical route for assignment management, project setup, and assigned work.
- Preserve all documented project and range-handout capabilities and existing records.
- Preserve project creator ownership, project membership checks, authorization, and cross-workflow duplicate-case prevention.
- Keep `/case/:id` as the case viewer and redirect `/work` to `/assignments`.
- Do not modify production, push, merge, or alter data.
- Stay on `integration/upstream-main-20261119`; do not create branches or use subagents.

## Review Focus

- Empty account with no projects or assignments: both create/join and empty work states are clear.
- Project member with an invite but no assigned cases: membership does not imply assignment.
- Person with both project work and range handouts: both appear in My work with distinct sources and statuses.
- Cases unavailable, released, published, or under review: UI actions and labels reflect the server state.
- Old deep links: management links redirect without losing project selection or accidentally opening production.

---

### Task 1: Canonical workspace shell and navigation

**Files:**
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/index.tsx`
- Modify: `PanTS-Demo/src/components/DesignShell.tsx`
- Modify: `PanTS-Demo/src/App.tsx`
- Modify: `PanTS-Demo/src/test/assignmentsNav.test.tsx`

**Interfaces:**
- Consumes the current `useMyAssignments` hook and existing project API/types.
- Produces one `/assignments` shell with `My work` and `Manage` views; old work, project-management, and account-assignment URLs redirect there; `/case/:id` stays unchanged.

- [ ] **Step 1: Add route/navigation tests** for `/assignments`, `/work`, `/work/projects`, `/work/join`, `/account/annotation-projects`, and `/account/assignments`; assert one canonical destination and keep `/case/:id` unchanged.
- [ ] **Step 2: Run the focused route tests** and confirm new redirect assertions fail before implementation.
- [ ] **Step 3: Implement the canonical route and redirects** while preserving protected-route requirements and existing selection query state where supported.
- [ ] **Step 4: Run focused route tests** and confirm all route and sidebar behavior passes.

### Task 2: Unified personal work queue

**Files:**
- Modify: `PanTS-Demo/src/helpers/useMyAssignments.ts`
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/index.tsx`
- Modify: `PanTS-Demo/src/components/AssignmentCaseCard.tsx`
- Modify: `PanTS-Demo/src/test/assignmentsPage.test.tsx`

**Interfaces:**
- Consumes project assignments from `/api/me/assignments` and upstream range handouts from `/api/assignments/mine`.
- Produces a normalized display row/card with source, case ID/number, task/project label, status, due date, and viewer destination; source-specific status updates continue calling their existing APIs.

- [ ] **Step 1: Add tests** for mixed project/range rows, empty states, status labels, case navigation, and state updates routed to the correct API.
- [ ] **Step 2: Run the focused queue tests** and confirm the mixed-source assertions fail before implementation.
- [ ] **Step 3: Normalize and render both sources** in the upstream compact card hierarchy without changing either backend contract.
- [ ] **Step 4: Run focused queue tests** and confirm project and range actions remain distinct and correct.

### Task 3: Unified management hierarchy

**Files:**
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/HandOut.tsx`
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/ManagePanel.tsx`
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/PeopleCards.tsx`
- Modify: `PanTS-Demo/src/routes/Settings/AnnotationProjects.tsx` only as needed to extract/reuse existing project panels
- Modify: `PanTS-Demo/src/test/assignmentsManage.test.tsx`
- Modify: `PanTS-Demo/src/test/annotationProjects.test.tsx`

**Interfaces:**
- Consumes the upstream person-card handout manager and current annotation-project create/join/assign/review components.
- Produces a Manage view with project cards; opening a project exposes its existing three-step setup, assign, and review/publish flow. Direct range handouts remain within the same route under a clearly labeled section.

- [ ] **Step 1: Add tests** that project creation/joining, project-specific accepted-member selection, structure/case selection, seed upload, review/publish/history, and range create/edit/progress are reachable from the unified route.
- [ ] **Step 2: Run the focused management tests** and confirm the new reachability assertions fail before implementation.
- [ ] **Step 3: Compose existing project components into the Manage hierarchy** and use upstream per-person cards for assignment summaries/details; preserve project creator and membership guards in UI behavior.
- [ ] **Step 4: Run focused management/API tests** and confirm existing project/range behaviors are retained.

### Task 4: Styling, compatibility, and final verification

**Files:**
- Modify: `PanTS-Demo/src/routes/AssignmentsPage/AssignmentsPage.css`
- Modify: relevant focused route/UI tests from Tasks 1–3

**Interfaces:**
- Consumes Tasks 1–3 UI states and existing BodyMaps design tokens.
- Produces responsive, accessible navigation and card expansion with clear loading, empty, error, and success states. The sidebar has one Assignments link; `/work` is only a compatibility redirect.

- [ ] **Step 1: Add assertions** for keyboard-operable view switching, narrow viewport card layout, and expansion/collapse state.
- [ ] **Step 2: Run focused UI checks** and confirm the new accessibility/layout assertions fail before implementation.
- [ ] **Step 3: Refine styling and interaction states** without changing upstream clinical viewer behavior or backend permission semantics.
- [ ] **Step 4: Run the relevant frontend and backend suites plus frontend build**; report any failures by name and do not call the consolidation complete if assignment-related checks fail.
- [ ] **Step 5: Inspect the final diff** for lost capabilities, route duplication, weakened permissions, and altered case-exclusivity behavior.
