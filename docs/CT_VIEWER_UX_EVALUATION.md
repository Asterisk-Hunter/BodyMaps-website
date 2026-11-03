# CT viewer UX evaluation

Scope: the CT viewer and its segmentation workflow. Evaluation combines a browser walkthrough with a real dataset CT scan, source review, accessibility checks, and independent implementation reviews. This is an expert assessment, not a clinician usability study.

## Product judgment

The main friction came from competing controls and uncertain state. A physician should be able to identify the action, select the anatomy once, work on the scan, and understand whether changes have been saved. Visual polish follows that hierarchy: quiet dark surfaces, stable alignment, readable action names, and contextual tools.

## Findings and changes

| Finding | Effect on the workflow | Implemented response |
| --- | --- | --- |
| Onboarding paragraphs and large informational hover cards | Reading interrupts scan interpretation | Removed rich hover cards; retained a compact four-step tour with Skip tour, remembered completion, and optional replay from Tour |
| Sidebar class selection duplicates the toolbar picker | Two entry points imply different targets | One searchable structure picker in the segmentation toolbar; removed the redundant annotation sidebar |
| Icon-only primary actions and blanket dimming | Users must guess actions; available controls appear disabled | Visible Measure, Segment, Save, and Report labels; native disabled states; secondary assistant, collaboration, and shortcut tools under More |
| Centered segmentation controls shift as tools appear | The selection target moves between workflow steps | Full-width docked toolbar with a fixed left starting point; Segment precedes history controls in the main toolbar |
| Unused toolbar space offers no context about the selected action | Users must recall how each tool works | Optional one-sentence tool brief showing the selected structure and current action; uses the vacant upper-right area when the main header wraps, returns to the segmentation ribbon on wide screens, and collapses when space is tight |
| Empty structures expose only AI | Manual segmentation has no discoverable starting point | Draw exposes Brush and Eraser immediately; operations that require a mask appear after a mask exists |
| AI options have two equivalent dropdown triggers | Extra controls add no capability | A single labeled AI dropdown, with the active method shown in its label |
| Structure search depends on label order and pointer input | Longer catalogs are difficult to navigate | Token matching, combobox/listbox semantics, arrow navigation, highlighted-option scrolling, and explicit Clear selection |
| Bright native scrollbar and blue-tinted picker compete with the scan | The picker feels visually inconsistent with the viewer | Neutral charcoal surfaces, consistent spacing and typography, restrained selection states, and a thin dark scrollbar |
| “Isolate structure” can imply isolation of the CT anatomy | The control promises more than a mask visibility change | Renamed to “Show only this mask” |
| Done is ambiguous and Save disappears during manual editing | Exiting editing can be mistaken for persistence | Separate Save and Finish editing; saved, unsaved, saving, and failed-save states; Retry after failure |
| Saves fail silently or overlap; browsing structures triggers unnecessary saves | Users cannot judge persistence | Visible feedback, deduplicated requests, revision-aware results, per-case state reset, and autosave on structure switches only when changes need saving |
| A failed mesh view leaves a bare empty pane | No clear next action | Compact “3D structures unavailable” state with View CT volume recovery |
| Box confirmation contains shortcut instructions | A simple decision becomes a reading task | Apply and Cancel only; keyboard focus on Cancel does not accidentally apply |

## Verification and limits

Focused tests cover toolbar states, empty-target drawing and AI selection, picker navigation and management, confirmation, saving and retry, delayed save results, recovery/menu behavior, tour completion and replay, focus, and contextual tool copy. TypeScript and a production build are checked. Browser checks use a real loaded CT at desktop and narrower viewport sizes, including 1535, 1024, and 390 pixels for the refined toolbar and tour.

Successful server persistence and AI inference have not been verified in this UX pass; simulated save tests validate the UI contract, not the storage service. The existing ESLint configuration fails before analyzing source files. No clinical claims or usability score are inferred from these checks.

## Next product validation

Observe physicians completing four tasks without instruction: select anatomy and segment it, create and draw a new structure, cancel a box preview, and save/recover from a save failure. Record completion, misclicks, and moments where assistance is needed. Confirm the narrow-screen tool hierarchy with their actual workstation sizes before making further density changes.
