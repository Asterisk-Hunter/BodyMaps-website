# Single Assignment Workspace

## Goal

Provide one clear assignment workspace that uses the upstream assignment page's compact hierarchy and incorporates the richer annotation-project workflow already built in this repository. Users should not have to guess which of two assignment pages to use. Work remains on the existing `integration/upstream-main-20261119` branch. Production is out of scope.

## User-facing structure

- `/assignments` is the one canonical route for assignment management, project setup, and assigned work.
- The page opens with a small, consistent top-level switch: **My work** and **Manage**. The page keeps the upstream pattern of concise cards with details opened on demand.
- **My work** combines project assignments and legacy numeric-range handouts, labels their source and status, and links each case into the existing `/case/:id` viewer. Project case lists remain expandable/lazy-loaded so large assignments do not render thousands of rows at once.
- **Manage** starts with project cards and **Create project** / **Join project** actions. Selecting a project opens its existing three-step hierarchy: setup, assign scans, review and publish. Project-member cards show each person's cases and progress; details and actions appear when a card is opened.
- Legacy numeric-range handouts remain available in the same route under a clearly named **Direct handouts** section, using upstream's per-person assignment hierarchy. They do not appear as a second assignment page.
- `/work`, `/work/projects`, `/work/join`, `/account/annotation-projects`, and `/account/assignments` become compatibility redirects to `/assignments`; `/case/:id` remains the viewer route.
- The sidebar exposes one **Assignments** entry for this workspace and removes the duplicate Worklist link to `/work`.

## Behavior to preserve

The project flow retains project-specific invitations and membership, creator ownership, structure selection, case range/CSV selection and preview, assignment instructions and due dates, seed-mask upload, case availability checks, edit/transfer/release/retry controls, draft and review history, request-rework/approve/publish/restore actions, exports, storage reporting, and close/reopen controls.

The range-handout flow retains its existing create/edit/delete, progress tracking, done/flagged marks, and assignee-facing case list. These capabilities are exposed within the unified route rather than removed. Existing records and API contracts remain intact in this UI consolidation; no assignment data migration is part of the change.

## Access and case safety

- Project management and review continue to follow project creator ownership; a person must join a project before receiving its project work.
- The UI only offers joined project members for project assignments.
- A case with active work cannot be assigned through both workflows or assigned to two people. Keep the shared creation lock and cross-workflow overlap checks in place.
- Keep upstream authorization and role checks that protect direct handouts. Do not silently broaden permissions as part of the visual consolidation.
- Existing unavailable, released, published, and review states must remain distinguishable; do not imply an unavailable case can be opened.

## Compatibility and implementation boundary

Use the upstream assignment page's information hierarchy and card-based management view, then compose existing project workflow components into it. Keep the two persisted assignment models and their APIs separate for this iteration; the route and user-facing navigation are unified, while the already-added exclusivity guard prevents duplicate case ownership. Preserve deep links by redirecting old management URLs. Do not modify production, push, merge, or alter data as part of implementation.

## Verification

Verify that all old management URLs reach the canonical route; both assignment sources appear in **My work**; project creation/joining and the three project steps remain accessible; direct handouts remain manageable; access guards and duplicate-case prevention still reject invalid operations; and project review/publishing behavior remains reachable. Run focused UI/API checks and the repository's relevant build/test commands before calling the consolidation complete.

## Self-review

- Scope covers the intended one-route UI consolidation while preserving both data models and all existing documented capabilities.
- `/case/:id` remains the case viewer, while `/work` is redirected because it currently hosts the project-assignee queue being consolidated.
- No permission widening or data migration is proposed.
- Legacy routes have an explicit compatibility behavior.
