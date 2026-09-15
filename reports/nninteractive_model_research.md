# nnInteractive — Model Research: Pain Points, Gaps & Improvement Plan

**Scope.** Everything about the *model* — how nnInteractive behaves inside BodyMaps, where it fails, how to measure failures, and how to fine-tune it. Companion doc: `reports/bodymaps_site_fixes.md` covers all UI/UX and website issues.

**Sources of evidence**
- Code audit: `flask-server/services/nninteractive_predictor.py`, `/api/interactive-segment` endpoints, `advanced_analysis.py`, and the vendored `nnInteractive/` client/server library (internal z-score normalization, AutoZoom, interaction decay, server flags).
- The nnInteractive paper (Isensee et al., arXiv:2503.08373).
- Web research: CVPR 2025 SEGFM3D challenge, warm-start fine-tuning work (arXiv:2510.03189), 3D Slicer community failure reports.

**Pain severity:** 🔴 frequent + blocks work · 🟠 frequent + workaround exists · 🟡 occasional annoyance

---

## 1. Executive summary

The integration is architecturally sound (stateful sessions, authoritative target buffer, undo replay), and the model is **already good enough for its core job** — fast organ-level segmentation with light correction. The research opportunity is concentrated in four capability areas: **multi-object targets, long/tubular structures, small structures, and ambiguity handling**. The single most important action is instrumentation: **the failure-detection dataset already flows through the server and is thrown away.**

Top findings:

| # | Finding | Type | Severity |
|---|---------|------|----------|
| 1 | No interaction-telemetry capture — the fine-tuning dataset is discarded | Research infra | **Critical** |
| 2 | Largest-CC cleanup makes multi-object/lesion/instance segmentation impossible by design | Post-processing | **High** |
| 3 | Low-res sessions mean the model never sees native resolution → systematic boundary blur | Accuracy | **High** |
| 4 | CT sent as raw HU while the model z-scores internally over the nonzero region — protocol mismatch risk | Model protocol | **High** |
| 5 | AutoZoom truncates long thin structures (femur/aorta) at consistent slice boundaries | Model heuristic | **High** |
| 6 | Points (the model's worst prompt, AUC 71.8 vs lasso 83.4) are the platform default; scribbles are 2D-only | Prompt coverage | Medium |
| 7 | No Dice/HD95/NSD quality layer exists server-side | Research infra | Medium |
| 8 | Ambiguity resolution (headline feature) has no user-intent affordance and is unlogged | Model/UX | Medium |
| 9 | `torch.compile` off → slower inference → more friction → more abandoned prompts | Performance | Medium |
| 10 | 2D-only prompts: a 3D bbox/lasso variant exists in the literature as a natural fine-tuning direction | Research direction | Medium |

---

## 2. How the model is used (pipeline as-built)

```
Frontend prompt (point/box/lasso/scribble, +/−)
  → POST /api/interactive-segment/<case_id>
    → CT cache (float32) → optional SuPreM baseline injection
    → nninteractive_predictor.predict()  [LRU store: (case, label, res), TTL 600s]
      → _pad_to_even → set_image (raw HU) → add_*_interaction on remote Docker session
    → largest-CC cleanup → resample to seg grid → gzip NIfTI (X-Mask-Voxels)
Undo → /sync endpoint replays the surviving prompt ledger into a fresh session
```

Key library facts (verified in vendored source): the model z-scores internally using statistics over the nonzero region; interaction channels decay ×0.9 per follow-up; AutoZoom zooms out by 1.5× up to 4×; server supports `--no-autozoom`, `set_do_autozoom`, `run_prediction=False`, and `override_capability_checks`.

---

## 3. Model-side pain points (what users experience because of the model)

### 🔴 M1. Multi-object targets come back cut in half
Bilateral kidneys, both lungs, multiple lesions: one prompt *should* return several components, but the platform keeps only the largest connected piece. The model often predicted the rest correctly — the post-processor deleted it. **Research angle:** the model is instance-based by training design (paper converts semantic labels to instances via CC), so multi-object output is native capability being silently clipped. Fine-tuning data collected under this cleanup would teach the model to imitate the bug — fix the cleanup first, then collect.

### 🟠 M2. Long structures truncate at a flat boundary
Femur/tibia/aorta: the mask ends cleanly at some slice; more prompts extend it slightly, then it truncates again. Confirmed by real users in the Slicer community; AutoZoom is a heuristic that under-captures when a long thin structure becomes sub-voxel at zoom-out. **Research angle:** log per-session zoom-out factors (server already tracks `new_interaction_zoom_out_factors`); correlate zoom >2.5× with correction counts to quantify the truncation class; a "large structure" mode (autozoom off + box restriction) is both a workaround and an ablation study.

### 🟠 M3. Small structures — "it segments the thing next to what I meant"
Points are the model's weakest prompt; at low-res the grid quantizes intent; vessel walls/nodes/small lesions suffer most. **Research angle:** prompt-type routing per structure class (see §7), plus measuring the low-res accuracy cost (M5).

### 🟠 M4. No trust signal — users verify everything, erasing the speed win
No Dice-vs-baseline, no change summary, no uncertainty. Users re-check masks slice-by-slice. **Research angle:** this is the quality-layer gap (§4 G8) plus a UX surface in the site doc; the model research contribution is the frozen benchmark + per-prompt predicted quality estimates.

### 🟡 M5. Low-res default grid blurs boundaries
Interactive segmentation defaults to `res: "low"`. nnInteractive is trained at native resolution with no resampling (paper A1). Low-res sessions blur the image the model sees and quantize returned masks. **Research angle:** quantify Dice delta low vs full on the same prompts; consider auto-promotion or full-res inference with downsampled preview.

### 🟡 M6. Ambiguity — "the model decides what I meant"
Liver with/without tumor, kidney with/without cyst: intent is expressible through prompts but the platform's only intent signal is the active segment; `inject_baseline` is implicit and always-on. **Research angle:** does baseline injection anchor the model to baseline errors? Does prompt order/polarity teach intent? Both measurable with per-session logging (RQ3/RQ4, §8).

---

## 4. Technical gap register

### G1. No observation pipeline (P0 — build first)
Persist one JSONL row per interaction server-side:
```
ts, case_id, segment_label, res, session_id, interaction_index,
prompt_type, is_positive, mask_voxels_before, mask_voxels_after,
voxel_delta, latency_ms, zoom_out_factors, baseline_injected,
downstream: {accepted | undone | overwritten | superseded}
```
`X-Mask-Voxels` before/after and interaction counts already exist at the endpoint — it just needs to write them down. Rejected prompts (removed from the ledger via `/sync`) = rejected corrections. Add `GET /api/interaction-log/<case_id>` for annotation-session export. Longer term: persist the prompts themselves (ledger already encodes them) so the training triple `(image, prompt history, final mask)` is recoverable.

### G2. Largest-CC cleanup must become conditional
Keep cleanup default-on for single-organ targets; disable when the user opts into multi-object mode or when the baseline mask has >1 component; consider keeping components ≥ some % of the largest. (Backend fix + research gate for M1.)

### G3. HU normalization protocol experiment
Official guidance: feed raw intensities; the library normalizes internally. Raw HU has a long negative tail (air ≈ −1000), shifting the normalized distribution versus training. Cheap A/B: same prompts with raw HU vs clipped [−1024, 3071]; log which variant ran; measure. One-day experiment, possible free accuracy.

### G4. Low-res vs full-res study
Add `res` to the interaction log; measure the accuracy cost of the low-res preview pipeline; explore auto-promotion to full-res for small structures or full-res inference with downsampled preview. (See M5.)

### G5. Prompt-type coverage
Paper Fig. 8: lasso AUC 83.4 > 2D bbox 80.7 > scribble 79.1 > points 71.8. Gaps: (1) no first-click nudge toward the strongest prompt; (2) platform scribbles are single-slice 2D constructions while the paper shows out-of-plane 3D scribbles carry more signal — either extend the tool or fine-tune on 2D-scribble reality to match the platform's data.

### G6. AutoZoom instrumentation
Log zoom-out factors; offer large-structure mode; test `force_full_refine` for refinement drift. (See M2.)

### G7. No quantitative quality layer
Implement `segmentation_metrics.py` (currently an explicit stub): server-side Dice + HD95 vs the SuPreM baseline or user-verified finals. Powers regression tests, low-quality session flagging, and the frozen benchmark.

### G8. Backend behaviors invisible to research
Largest-CC removal counts, empty-mask 422s, undo-heal resets (empty target → baseline re-injection) all materially change masks with only print-log traces. Log them as structured events — each can masquerade as a "model failure" during annotation studies.

### G9. Error-classification exists but isn't persisted
Capacity/timeout/unavailable classification (HTTP 429/503/etc.) is good; persist it per prompt so infra failures can be excluded from model-quality analysis.

---

## 5. "Is the model good enough?" — verdict per task

Rating: ✅ good enough today · ⚠️ good enough with conditions · ❌ not good enough yet

| Task | Verdict | The one thing standing in the way |
|---|---|---|
| Large solid organs (liver, spleen, single kidney) | ✅ | Trust needs metrics feedback (M4) |
| Bilateral / multi-object structures | ❌ *post-processing-caused* | Largest-CC cleanup (M1/G2) |
| Small structures (nodes, vessels, small lesions) | ⚠️ | Points weakest + low-res grid (M3, G4/G5) |
| Long tubular structures / long bones | ⚠️/❌ | AutoZoom truncation (M2/G6) |
| Tumor-in-organ ambiguity | ⚠️ | Intent affordance + research (M6) |
| First-pass then manual paint finishing | ✅ | The hybrid is genuinely fast today |
| Custom/OOD uploads (e.g., Case-99-style CTs) | ⚠️ | HU/spacing protocol sensitivity (G3); usually recovers with prompts |
| Fully automatic expectation | ❌ | Not the design; expectation-setting, not fine-tuning |

**Overall:** for organ-level segmentation with light correction the model is good enough that attrition comes from platform bugs and invisible behaviors, not capability. Fine-tuning effort should concentrate on multi-object, long/tubular, small structures, and ambiguity — nothing else.

---

## 6. Failure taxonomy — the annotation rubric

Annotate logged sessions into classes; only the last class is a fine-tuning target:

| Class | Example | Actionable? |
|---|---|---|
| Boundary under/over-segmentation | mask leaks into adjacent organ | refinement prompts help |
| AutoZoom truncation | femur cut at slice boundary | config/workaround (G6) |
| Ambiguity mismatch | got liver+tumor, wanted tumor-only | intent design (M6) |
| Low-res blur | vessel wall fuzzy | pipeline (G4) |
| Post-processing artifact | second kidney component removed | platform bug (G2) |
| OOD intensity/spacing | custom uploaded CT | protocol (G3) |
| **Model genuinely wrong after 5+ prompts** | none of the above | **fine-tuning candidate** |

Rule: a failure is a fine-tuning target only if the other six are excluded — otherwise you'd teach the model to imitate platform bugs.

---

## 7. Speed research: annotation speed without accuracy loss

Three layers multiply: **model time**, **pipeline time**, **interaction count** (human prompts needed). Most projects optimize the first; the biggest wins are usually the other two.

### 7.1 Model-time wins (low accuracy risk)
| Change | Expected effect | Accuracy risk |
|---|---|---|
| Enable `torch.compile` (server supports it; warm up at session init) | 1.3–2× per-prompt latency | None (same math) |
| Pre-warm session when Annotate opens (baseline injection is deterministic) | Moves the 15–40 s first-prompt cost off the critical path | None |
| Cap AutoZoom escalation: return first zoom-level result immediately, refine in background if borders keep moving | Sub-second first response on large organs | Momentarily coarse mask — "refining…" shimmer |
| bf16/fp16 (already used) + CUDA graphs for the fixed 192³ patch | Marginal gains on top of compile | None |

### 7.2 Pipeline-time wins
- **Deltas, not volumes:** the client library already returns the changed-region bbox (`_last_paste_bbox`). Ship only the changed sub-volume → multi-MB becomes KB for refinements.
- **Skip the NIfTI container** for interactive responses (raw uint8 + dims in HTTP headers).
- **Optimistic UI** (render expected direction immediately, swap in the true mask) — site-doc item, listed here for completeness.

### 7.3 Interaction-count wins (the research frontier)
Each human correction costs 10–30 s vs ~0.2–2 s model time, so the highest-leverage research is **"fewer prompts per organ at equal Dice"**:
1. **Prompt-type routing:** learn which prompt type converges fastest per structure class; deliver as UI defaults per target class.
2. **Baseline seeding quality:** quantify whether a good SuPreM baseline cuts prompts-to-Dice by 1–2 interactions, and whether bad baselines *increase* them (anchoring cost).
3. **Accept-early UX:** show Dice-vs-baseline per prompt; when ΔDice gain < ε, suggest "accept and move on" (paper's user study: experts spent time the model didn't need).
4. **Fine-tuning objective:** train on interaction-efficiency (AUC-interactions), not just final Dice — a model reaching Dice 0.9 in 1.5 prompts beats one reaching 0.92 in 4.
5. **Batch prompts:** let users place several positive points across slices, then one combined refinement — one round trip instead of N.

**KPI to institutionalize:** *interactions-to-0.90-Dice* (median, per structure class), reported next to Dice in every experiment.

### 7.4 What NOT to do
- Don't shrink the patch size or disable AutoZoom globally — that trades away long-structure accuracy.
- Don't move inference client-side/WebGPU — VRAM and determinism favor the server design.
- Don't return low-res masks to save time — boundary blur is the root complaint.

---

## 8. Fine-tuning plan & research questions

### Stage 0 — Instrument (1–2 weeks, no model changes)
G1 logging + G7 metrics + G8 events. Freeze a benchmark split (e.g., 30 verified cases) *before* any fine-tuning.

### Stage 1 — Failure taxonomy annotation (2–4 weeks)
Use §6's rubric on logged sessions. Export via the interaction-log endpoint.

### Stage 2 — Fine-tuning (4–8 weeks)
- **Recipe:** nnU-Net ResEnc-L backbone, early prompt channels (6 interaction channels), simulated interaction agents (Random / Sunk-Cost / Single-Interaction), decay 0.9, AutoZoom. Initialize from `nnInteractive_v1.0` weights — arXiv:2510.03189 demonstrates warm-starting from public weights on a single GPU is viable.
- **Compute reality:** full reproduction was 8×A100 × ~12 days; the realistic single-GPU path is frozen-encoder + LoRA-style adapters on the decoder.
- **Data:** BodyMaps correction triples (prompt history → accepted final mask), converted to *instances* (CC) to match training convention. Augment with public data if distribution shift hurts (catastrophic-forgetting guard).
- **Eval:** frozen benchmark from Stage 0; Dice/NSD vs interactions 1–5 (paper protocol), separately per prompt type; OOD set of custom-CT uploads.
- **Risks:** CC BY-NC-SA 4.0 (non-commercial) license on weights; narrow-distribution forgetting (replay from public data / LoRA); interaction-simulation cost (the dynamic-prompt paper's no-grad simulation stage is the fix).

### Stage 3 — Publication-worthy research questions the platform uniquely enables
1. **Real refinement behavior at scale** — the paper's user study: 12 lesions, 2 raters; BodyMaps can log hundreds of sessions with exact prompt provenance.
2. **Which prompt type do real (naive) users converge with fastest?** (paper says lasso with simulated lassos; verify with humans).
3. **Baseline anchoring:** does SuPreM injection bias the model toward baseline errors, and does decay-0.9 correction recover?
4. **Low-res preview vs full-res accuracy tradeoff** for interactive refinement.
5. **3D bbox / slice-stack lasso fine-tune** (SEGFM3D participants adapted nnInteractive to true 3D boxes).
6. **Interaction-efficiency training objective** (§7.3.4).

---

## 9. Evidence plan

1. Ship G1 first — without it everything above stays anecdotal.
2. Watch 5 real sessions (think-aloud): first prompt, power-user organ run, negative correction, long-bone case, custom CT upload.
3. Three micro-surveys: after first prompt (wait rating), after any rejection ("what were you trying to do?"), on session exit ("what slowed you down?").
4. Tag feedback messages with pain IDs — within a month the true ranking emerges.

---

*Prepared by Buffy (Freebuff) — code audit + literature review, September 2026.*
