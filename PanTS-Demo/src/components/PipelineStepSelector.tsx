import { useEffect, useRef, useState } from "react";
import type { PipelineOption } from "../helpers/inferencePipeline";

type Props = { stage: "preprocessing" | "postprocessing"; value: string | null; option?: PipelineOption;
  model: string; locked: boolean; previewOnly?: boolean; signedOut?: boolean; onChange: (value: string | null) => void; onLocked: () => void };

/** Real stages require server capability checks; explicit UI previews do not run. */
export default function PipelineStepSelector({ stage, value, option, model, locked, previewOnly = false, signedOut = false, onChange, onLocked }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const title = stage === "preprocessing" ? "Preprocessing" : "Postprocessing";
  const supported = !!option?.supported_models.includes(model);
  const unavailable = (signedOut && !previewOnly) || !option?.available || !supported;
  const reason = model === "None" ? "Skipped when viewing only"
    : previewOnly ? value ? stage === "preprocessing"
      ? "Preview only. This step does not run. Segmentation uses the original CT."
      : "Preview only. This step does not run. No ShapeKit refinement is applied." : ""
    : signedOut ? "Sign in to check availability"
    : !option ? "Server availability could not be checked"
    : !option.available ? option.reason || "Not available on this server"
    : !supported ? "Not available for this model" : "";
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
  const choose = (next: string | null) => {
    setOpen(false);
    if (next && locked) onLocked(); else onChange(next);
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };
  return <div className="pipeline-step" data-tour={stage}>
    <div className="pipeline-step-header"><div className="pipeline-badge">{stage === "preprocessing" ? 1 : 3}</div>
      <span className="pipeline-label">{title}</span><span className="pipeline-optional">optional</span></div>
    <div className="model-dropdown" ref={root}>
      <button type="button" className={`model-dropdown-btn${value ? " has-value" : ""}${open ? " open" : ""}`}
        disabled={unavailable} onClick={() => setOpen(!open)} aria-label={`${title}: ${value || "None (skip)"}`}
        aria-expanded={open} aria-controls={open ? `${stage}-options` : undefined}
        aria-describedby={reason ? `${stage}-availability` : undefined}>
        <span>{value || "None (skip)"}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && <div className="model-dropdown-menu" role="menu" aria-label={title} id={`${stage}-options`}>
        <div role="menuitemradio" tabIndex={0} aria-checked={!value} className={`model-dropdown-item${!value ? " selected" : ""}`}
          onClick={() => choose(null)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(null); } }}>
          <span className="model-dropdown-item-name">None (skip)</span>
        </div>
        {option && <div role="menuitemradio" tabIndex={0} aria-checked={value === option.id}
          className={`model-dropdown-item${value === option.id ? " selected" : ""}${locked ? " locked" : ""}`}
          onClick={() => choose(option.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(option.id); } }}>
          <div className="model-dropdown-item-content"><span className="model-dropdown-item-name">{option.label}</span>
            <span className="model-dropdown-item-desc">{previewOnly ? "Preview only. This step does not run." : stage === "preprocessing" ? "Reconstruct CT with OpenVAE before segmentation" : "Refine supported masks of whole organs. Lesions are preserved."}</span></div>
          {locked && <span className="model-dropdown-lock">Donate</span>}
        </div>}
      </div>}
    </div>
    {reason && <p className="pipeline-unavailable" id={`${stage}-availability`}>{reason}</p>}
  </div>;
}
