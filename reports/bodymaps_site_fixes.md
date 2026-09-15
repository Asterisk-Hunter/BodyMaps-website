# BodyMaps — Site Fixes: UI/UX Pain Points & Implementation Plans

**Scope.** Everything *other than* the model: website UI/UX pains, design fixes, onboarding, and interaction quality. Companion doc: `reports/nninteractive_model_research.md` covers the model research (failures, fine-tuning, speed).

**Method.** Every item is verified in code (`VisualizationPage.tsx/.css`, `AnnotationToolbar.tsx`, `useInteractivePromptTool.ts`, `CornerstoneNifti2.tsx`). Severity: 🔴 frequent + blocks work · 🟠 frequent + workaround exists · 🟡 occasional annoyance.

---

## 1. Pain index (18 items)

| ID | Pain | Severity | Section |
|---|---|---|---|
| U1 | Silent multi-object deletion misattributed to the model | 🔴 | — (model doc M1; platform cause) |
| U2 | Negative-prompt refusal ("the tool said no to my explicit instruction") | 🔴 | — (model doc M-side; platform cause) |
| U3 | First-prompt latency with no "warming up" state | 🔴 | §2 |
| U4 | Long-structure truncation with no surfaced workaround | 🟠 | — (model doc M2) |
| U5 | Wrong-object segmentation on small structures | 🟠 | — (model doc M3) |
| U6 | No trust/quality signal → manual verification erases speed win | 🟠 | §3 |
| U7 | Positive/negative polarity amnesia | 🟠 | §4 |
| U8 | Non-deterministic undo (ledger replay shifts the mask) | 🟠 | §5 |
| U9 | Silent session expiry (600s TTL, LRU capacity 1) | 🟡 | §2 |
| U10 | Ambiguity: no way to express intent | 🟡 | — (model doc M6) |
| U11 | Perceived slowness / per-click latency tax | 🟡 | §2 |
| U12 | Cryptic error messages | 🟡 | §3 |
| U13 | **Dual-cursor confusion** (+ cursor + crosshair reticle + crosshair tool icon) | 🔴 | §6 |
| U14 | **16-icon toolbar overwhelm** (navbar + class row + ribbon stack) | 🔴 | §7 |
| U15 | **Lasso drawing difficulty** (even-odd fill holes, no snapping) | 🟠 | §8 |
| U16 | **Apply/Cancel confirm buttons: raw inline-styled, overlap, clipping, misclicks** | 🔴 | §9 Fix A |
| U17 | **Box resize logic: tiny handles, no clamp, no snap, shape-warping on lasso** | 🔴 | §9 Fix B |
| U18 | Onboarding: instructions at the start are read by no one | 🔴 | §10 |

Items marked "model doc" have their model-side analysis there; their platform-side fixes live in the sections referenced.

---

## 2. Session lifecycle & latency UX

- **"Warming up" state (U3):** distinct "preparing model session…" state for interaction #0 of a session; raise the 35s client timeout for the first prompt; show expected latency tier in the log line. The most common abandonment cause ("I tried it once and gave up") is invisible session creation, not model speed.
- **Session state indicator (U9):** show active/expired in the status line; optionally pre-warm the session when the Annotate toolbar opens — baseline injection is deterministic, so the worst latency leaves the critical path.
- **Optimistic UI (U11):** render the prompt's expected direction immediately (positive → tint the clicked region; negative → flash the region) while inference runs; swap in the true mask. Perceived latency drops even when actual latency doesn't.
- **First-prompt timeout tiering:** 35s for refinements, 60s+ for session creation.

## 3. Trust & error UX

- **Diff overlay (U6):** after each prompt, render added voxels green / removed red with counts (the apply loop already has prior/post arrays — render them). Persist accept/reject per prompt in the interaction log.
- **Baseline Dice display (U6):** one-glance "98% match with auto-seg baseline" style chip; power users get a quality signal without slice-scrolling verification.
- **Classed error messages (U12):** distinguish (a) model found nothing, (b) proposal rejected by guard, (c) timeout, (d) capacity. The backend already classifies infra errors — surface them. Current messages ("Nothing grew from that point", "The interactive update looks inconsistent") don't tell the user *which* failure class they're in, so retries are random rather than diagnostic.

## 4. Polarity (positive/negative) UX

- **Right-click or Alt+click = negative prompt**, matching nnInteractive's own Napari plugin; keep the explicit toggle for discoverability.
- **Live cursor badge** — +/− icon and color (red for negative) whenever an AI tool is armed. Users must never be able to click without knowing the polarity.
- **Rename tooltip:** "Negative prompt — click a region to EXCLUDE it from the mask." (The current label is literally "(±)".)
- **Keyboard:** `X` toggles polarity (see §11).

## 5. Undo determinism

- **Snapshot-based undo (U8):** restore exact prior mask bytes client-side; treat the backend as eventually-consistent via the existing `/sync` replay (background), not the source of truth. The apply loop already snapshots touched indices — extend to full-mask snapshots per edit. Undo must never visibly shift the mask.

---

## 6. One cursor, one truth (U13)

**The moment:** user equips an annotation tool and hovers: there's a `+` (crosshair) OS cursor AND a second aim-like reticle (the OHIF-style crosshair reference-line overlay tracking the cursor) AND the click-to-segment tool's own icon is a crosshair/aim symbol. Three competing "aim" visuals; it's never obvious which marker is the point the model will receive.

**Mechanism (verified):** `.vp-pane--edit-cursor { cursor: crosshair }` in `VisualizationPage.css`; always-on reference-line overlay in `VisualizationPage.tsx`; `IconCrosshair` for click-to-segment in `AnnotationToolbar.tsx`.

**Fix:**
1. While any annotation/prompt tool is active, **suppress the reference-line overlay near the cursor** (or fade it to the two *other* panes only — keep cross-pane alignment utility, kill the local reticle).
2. Replace the OS cursor with a **single custom tool cursor**: `+` for positive, `−` for negative, small polygon-nub for lasso, brush outline for paint. The cursor is the polarity indicator (pairs with §4).
3. Reserve the word/icon "crosshair" exclusively for the navigation tool. Consider renaming the click-to-segment tool's icon (e.g., a target-dot on a slice) so tool identity and navigation never share a symbol.

---

## 7. Decluttering brief (U14)

**The moment:** doctor opens Annotate: navbar, organ/class row, then a ribbon of **16 icon-only tools** (4 AI + 12 classic labelmap-editing) all equal weight. Three stacked bars of chrome before touching the image; the user's goal needs at most 2 of 16.

**Design principle: a clinician's screen should answer the case, not present the software.**

1. **One mode at a time.** Read mode (crosshair, W/L, report — navbar only) vs Annotate mode (one compact ribbon). The 3-bar stack collapses to 2 in annotate mode, 1 in read mode.
2. **Progressive disclosure of tools.** Default AI row: Click / Box / Lasso / Scribble + polarity + undo/redo. The 12 classic tools behind one "Manual editing ▾" expander. Power users pin favorites; the ribbon remembers (localStorage).
3. **Labels before icons.** Icon+text buttons until the ribbon detects familiarity (N uses per tool), then collapse to icon. Icon-only toolbars trade discoverability for density; doctors use this weekly, not hourly.
4. **Class selection inside the flow.** When an AI tool is armed and no class is selected, show a compact in-canvas picker at the cursor (organ list with colors) instead of a round trip to the top row.
5. **Quiet by default.** Status in one line; toasts only for errors; walkthrough runs once (see §10), then exists as a "?" button.

---

## 8. Lasso drawing ergonomics (U15)

**The moment:** freehand lasso with a mouse around an organ is hard; sloppy ovals are effectively worse boxes, and self-intersecting outlines get rasterized with an even-odd fill (`buildLassoCroppedMask`, verified) so the mask returns with *holes* — and users blame the model.

**Fix:**
1. **Click-per-vertex polygon lasso** (ITK-SNAP/PowerPoint-freeform style): click to place vertices, auto-close on double-click/first-vertex click, Backspace removes last vertex, live fill preview.
2. **Light edge-snapping** (grab nearest strong gradient within ~5 px) so a lazy outline hugs anatomy.
3. **Self-intersection detection:** offer "auto-simplify outline" instead of silently filling with holes.
4. **Suggest box when appropriate:** a very convex/round drawn lasso → "This looks like a box region — try Box-to-segment, it's one drag."
5. Keep freehand drag as an option; default to polygon after A/B testing.

Honest framing: the paper's lasso advantage (AUC 83.4) was measured with *simulated* lassos derived from ground truth — real humans need tooling to produce comparable input.

---

## 9. The two highest-visibility fixes (spec, ready to build)

### Fix A — Confirm bar (Apply/Cancel) redesign (U16)

**The moment:** after drawing a box, two raw inline-styled buttons ("Apply Box" cyan, "Cancel" translucent) pop in **above the box** at `top: -40px` — overlapping anatomy and readouts, clipped when near the pane's top edge, colliding with the W/L readout, and sitting exactly where the mouse already is (misclick bait). User verdict: *"If Apple made a website, would the buttons look like this?"* Duplicated for lasso/scribble.

**Design spec:**
1. **Slim confirm bar docked to the box's *bottom* edge** (below, not above — above collides with readouts). Overlay chip: `border-radius: 10px; backdrop-filter: blur(8px); background: rgba(15,17,20,0.82); border: 1px solid rgba(111,211,255,0.35); box-shadow: 0 4px 16px rgba(0,0,0,0.45); padding: 6px 8px; display: flex; gap: 8px; align-items: center;`
2. **Buttons:** primary `Apply` (solid brand cyan `#6fd3ff`, dark text, semibold, 6px 14px padding, radius 8px, hover raise) and ghost `Cancel` (transparent, 1px border, hover tint). **Drop "Box"/"Lasso"/"Scribble" from Apply** — context is the shape just drawn. Collapse to ✓/✕ icon-only after ≥5 uses.
3. **Smart placement with flip + clamp (the real overlap fix):**
   - Default: centered under the box bottom edge, 8px gap.
   - Would overflow pane bottom → flip above the box top edge.
   - Would overflow top → pin to pane's bottom-right corner with a 1px dashed leader line to the box.
   - Always clamped inside pane bounds (12px inset); never outside the pane; z-index below the W/L readout.
4. **Hit targets:** 10px min gap between buttons; `Esc` = cancel (already wired), `Enter` = apply; faint kbd hints in the bar (`⏎ Apply · Esc Cancel`) — teaches shortcuts without a tutorial.
5. **Confirming-state polish:** box stroke solid 1.5px (not dashed) + faint animated outer glow; handles 12px circles with 2px white ring + shadow, 16px on hover; 4% black dim on the rest of the pane to focus the selection.
6. **One shared `ConfirmBar` component** for box/lasso/scribble (`onApply`, `onCancel`, `shapeBounds` props) — deletes the duplicated inline-styled blocks at both render sites.
7. **`pointerdown`-commit** with `stopPropagation()` so the pane beneath never receives the gesture (kills the misclick-through class of bugs).

**Effort:** ~1 day including the shared-component refactor. Highest polish-per-hour work on the platform.

### Fix B — Best-practice box resize logic (U17)

**The moment:** handles are 10px dots (hard to grab), resize uses raw client pixels (no clamping, no snapping, gesture lost if the cursor leaves the pane), no keyboard nudge, and on lasso/scribble confirm the "resize" **axis-scales the whole outline** — warping anatomical shapes. Feels like a 2005 applet.

**Spec (all in `useInteractivePromptTool.ts` + the box overlay):**
1. **Bigger, smarter handles:** 12px circles with white ring; add **mid-edge handles** (don't exist today); correct `nwse/nesw/ew/ns` cursors per handle.
2. **Pointer Events + `setPointerCapture`** — the single biggest smoothness fix: the drag continues even if the cursor leaves the pane/window and ends reliably anywhere. (`setPointerCapture(e.pointerId)` on handle pointerdown; listen `pointermove`/`pointerup` on the captured element.)
3. **Clamp to pane bounds** before converting to canvas coords — box can never leave the image; min size 4×4 px / 2 voxels makes degenerate boxes impossible by construction.
4. **Voxel snapping, zoom-aware:** moving corner → world→index → round to nearest voxel → back to canvas. The visual box then *exactly* matches the voxel bbox the backend receives. Snap when within 0.6 voxel of a grid line.
5. **Anchor logic:** corners anchor the opposite corner (already correct); **mid-edge handles anchor the opposite edge** with the other axis following the pointer; `move` translates both corners preserving size, clamped in-pane.
6. **Live readout chip** on the confirm bar: `128 × 96 vox · slice 47` — honest preview of the captured region, doubles as a precision aid.
7. **Keyboard nudge:** arrows move 1 voxel (Shift+arrows = 5) while confirming.
8. **rAF-batched updates:** batch `pointermove` into `requestAnimationFrame` — update state once per frame, not per event. The classic fix for "laggy resize."
9. **Lasso/scribble: remove shape-warping resize entirely.** Keep `move` (translate) + add a **"Redraw" button** on the confirm bar + per-vertex editing (§8). Axis-scaling an outline produces nonsense; kill it, don't polish it.
10. **Keep the `confirming` state machine and ledger integration untouched** — changes are confined to the pointer/display layer.

**Effort:** 2–3 days.

---

## 10. Onboarding that people actually read: pull-revelation plan (U18)

**Why not instructions up front:** NN/g's research is unambiguous — tutorials are *push revelations*: they interrupt, get skipped, aren't retained, and don't improve task performance ("paradox of the active user"). Figma/Notion/Linear use *pull revelations*: help triggered by a signal the user needs it *now*. The codebase's existing walkthrough (`components/walkthrough`) is exactly the skipped kind.

**The BodyMaps model: 5 pull-revelations, 0 tutorials.** Each fires at most once per user (localStorage flag), ≤ 2 lines, one-click dismissible, re-accessible from one "?" button in the ribbon.

| # | Trigger (signal the user needs help) | Revelation (≤2 lines, at the point of need) |
|---|---|---|
| R1 | First time the Annotate ribbon opens | Spotlight the 4 AI tools: "Start with Click-to-segment — click an organ, the AI proposes a mask. Other tools appear when you need them." + "Got it" |
| R2 | First successful point prompt | "Try a **lasso** around the whole organ for even better results — the model's strongest prompt type." (fires *after* success — trust is highest) |
| R3 | First ± toggle hover or first negative prompt | "Negative mode **removes** from the mask. The cursor shows − while it's on." (pairs with §4) |
| R4 | **2 consecutive failed prompts** | "Try a box around the region instead — or switch to full-res for small structures." Diagnostics at the moment of failure — the highest-value help moment |
| R5 | First AutoZoom-truncation signature (server reports zoom >2.5×) | "Long structures sometimes need a box around the whole bone first." |

**Sequencing rules:** max one visible at a time (queue, never stack); never during an in-flight prompt (`promptToolBusy`); dismiss via click-outside/Esc/"Got it"; suppressed after 2 dismissals without engagement; all copy in one `ONBOARDING_REVELATIONS` constant.

**First-session skeleton:** session 1, on opening Annotate → R1 only. No card deck, no feature tour, no modal. The "?" button reopens any revelation on demand and links the full walkthrough for those who want it.

**Instrumentation:** log which revelations fired/engaged/dismissed (into the interaction log) — within a month you'll know which 2 lines of copy changed behavior.

**Why this fits doctors:** radiologists are the canonical "paradox of the active user" population — time-pressured, goal-locked, allergic to modals. Onboard *into the task*, not *about the product*.

---

## 11. Keyboard & accessibility — ✅ DONE (September 15, 2026)

- `P/B/L/S` = point/box/lasso/scribble; `X` = toggle polarity; `Esc` = cancel (pre-existing); `Ctrl+Z` / `Ctrl+Z+Shift` / `Ctrl+Y` = undo/redo; arrows = nudge box, Shift+arrows = 5 vox (§9 Fix B); `Enter` = apply (pre-existing). **Implemented** in `useKeyboardShortcuts.ts`: the AI-tool keys are scoped to annotate mode (ribbon open) so `L/B/P` keep selecting measurement tools and `S` keeps taking a snapshot while reading; switching is locked while an inference is in flight and in locked Live Rooms, mirroring the click-path gates (viewer ready + active target).
- Documented in-context (not a tutorial): the confirm bar hint row now reads `⏎ Apply · Esc Cancel · P/B/L/S Tool · X ±`, and the overview walkthrough's welcome step (the replayable "?" surface) lists the shortcuts.
- A11y: annotation-ribbon buttons got a visible `:focus-visible` outline (tooltips already show on focus via onFocus/onBlur); `GuidedStepModal` — which renders the AI "No change"/failure copy — is now `role="dialog" aria-modal="true"` with the instruction line wrapped in `role="alert"`; the busy pill, success toast, HD-loading overlay, and error modal already carried `aria-live`/`role="status"`.

---

## 12. Prioritized action list

| Priority | Item | Effort | Impact |
|---|---|---|---|
| P0 | Fix A: Confirm bar redesign (shared component) | ~1 day | First-minute polish; kills overlap + misclicks |
| P0 | Fix B: Pointer-capture resize + snapping + clamping | 2–3 days | Interaction feel; prompt precision |
| P0 | Dual-cursor fix (§6) | 1 day | Removes the #1 "what am I clicking?" confusion |
| P0 | Polarity cursor badge + right-click negative (§4) | 1–2 days | Trust + data quality |
| P1 | Decluttered ribbon, doctor-default mode (§7) | 3–5 days | The "clean and neat for doctors" ask |
| P1 | "Warming up" session state + tiered timeouts (§2) | 1 day | Abandonment fix |
| P1 | Diff overlay + classed errors (§3) | 2–3 days | Trust signal |
| P1 | Polygon lasso + snapping (§8) | 3–4 days | Unlocks the model's best prompt for real humans |
| P2 | Pull-revelation onboarding (§10) | 2–3 days | Teaches without tutorials |
| P2 | Snapshot undo (§5) | 3–5 days | Data integrity |
| P2 | ✅ Keyboard shortcuts + a11y (§11) — done 2026-09-15 | 1 day | Power users + accessibility |
| P3 | In-canvas class picker (§7.4) | 2 days | Flow polish |

---

## 13. Validation plan

1. Watch 5 real sessions (think-aloud): first prompt, power-user organ run, negative correction, long-bone case, custom CT — plus one session where the user must *find* the lasso tool in the 16-icon ribbon without help (tests U14 honestly).
2. Three micro-surveys: after first prompt (wait rating), after any rejection ("what were you trying to do?"), on session exit ("what slowed you down?" multi-select of U1–U18).
3. **A/B the decluttered ribbon** against the current one with 3–4 annotators for a week: *time-to-first-segment* and *prompts-per-organ* are the two numbers that decide it.
4. Tag support/feedback messages with pain IDs — within a month the real ranking emerges.

---

*Prepared by Buffy (Freebuff) — UI/UX audit grounded in code-verified behavior, September 2026.*
