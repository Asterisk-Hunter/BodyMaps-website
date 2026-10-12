import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { layoutWorkspaceTour, type Rect, type WorkspaceTourPlacement } from "../helpers/workspaceTourLayout";
import "./WorkspaceTour.css";

const SEEN_KEY = "bodymaps.workspace-tour.v6";
type Step = { target: string; label: string; title: string; text: string; preferred?: WorkspaceTourPlacement[] };
const STEPS: Step[] = [
  { target: "scan-input", label: "Upload", title: "Start with a CT scan", text: "Drop a scan here, or upload a NIfTI file or DICOM series. No scan on hand? Try the sample case from the library." },
  { target: "preprocessing", label: "Preprocessing", title: "Prepare your scan", text: "Choose an available preprocessing step, or leave None selected. A step labelled Preview only does not run; segmentation uses the original CT." },
  { target: "model", label: "Model", title: "Choose your model", text: "Select a model for your scan. Additional info explains what it does. Choose None to view your scan locally without running inference." },
  { target: "postprocessing", label: "Postprocessing", title: "Refine the result", text: "Choose a supported refinement step when it is available on the server, or leave None selected. Availability appears below the control." },
  { target: "run", label: "Run", title: "Bring it all together", text: "Select Run to start your chosen pipeline. Inference requires sign in and the appropriate account access. Progress follows the actual server status." },
  { target: "explore", label: "Explore", title: "Your imaging workspace", text: "Move between your workspace, the CT dataset and the team. Dataset viewing requires sign in.", preferred: ["right", "below", "above", "left"] },
  { target: "mobile-navigation", label: "Explore", title: "Your imaging workspace", text: "Open the navigation menu to explore the dataset, return to your workspace, or find your account settings.", preferred: ["below", "above", "right", "left"] },
  { target: "recent", label: "Recent runs", title: "Pick up where you left off", text: "Recent runs show their real status. Open a completed result or see all your runs in History. Starting a new run keeps earlier results.", preferred: ["right", "above", "below", "left"] },
  { target: "settings", label: "Settings", title: "Make it yours", text: "Open Settings to edit your profile and picture, check your plan, or manage privacy. You can replay this walkthrough here anytime.", preferred: ["right", "above", "below", "left"] },
];

function visible(target: HTMLElement | null): target is HTMLElement {
  return !!target?.isConnected && Array.from(target.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)
    && !target.closest('[inert],[hidden],[aria-hidden="true"]')
    && !["hidden", "collapse"].includes(getComputedStyle(target).visibility);
}
function targetFor(step?: Step) {
  return step ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
}
function clippingBounds(target: HTMLElement | null) {
  const clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom);
    }
  }
  return clip;
}
function spotlightPath(width: number, height: number, hole: Rect | null, scale: number) {
  const x = (hole?.left ?? width / 2) / scale, y = (hole?.top ?? height / 2) / scale;
  const w = (hole?.width ?? 0) / scale, h = (hole?.height ?? 0) / scale;
  const r = Math.min(22, w / 2, h / 2);
  return `path(evenodd, "M 0 0 H ${width / scale} V ${height / scale} H 0 Z M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z")`;
}

export default function WorkspaceTour({ replay, name }: { replay: number; name?: string | null }) {
  // Zero is the welcome card; subsequent indices refer to visible real controls.
  const [step, setStep] = useState<number | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [geometry, setGeometry] = useState({ width: window.innerWidth, height: window.innerHeight, scale: 1, hole: null as Rect | null, cardWidth: 372, cardHeight: 240 });
  const dialog = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = () => {
    try { localStorage.setItem(SEEN_KEY, "true"); } catch { /* optional preference */ }
    setStep(null);
    const returnTargets = [previousFocus.current,
      document.querySelector<HTMLElement>('[data-tour="mobile-navigation"] button[aria-controls="design-sidebar"]'),
      document.querySelector<HTMLElement>('[data-tour="settings"] button[aria-haspopup="menu"]'),
      document.getElementById("workspace-content")];
    for (const target of returnTargets) {
      if (!visible(target) || target === document.body || target.matches(":disabled")) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) break;
    }
  };
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === "true"; } catch { seen = true; }
    if (seen && replay === 0) return;
    const timer = window.setTimeout(() => {
      previousFocus.current = document.activeElement as HTMLElement;
      setSteps(STEPS.filter((item) => visible(targetFor(item))));
      setStep(0);
    }, replay ? 0 : 900);
    return () => window.clearTimeout(timer);
  }, [replay]);
  useEffect(() => {
    if (step === null) return;
    const target = targetFor(steps[step - 1]);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const bounds = target?.getBoundingClientRect();
    const clip = clippingBounds(target);
    if (bounds && (bounds.top < clip.top || bounds.bottom > clip.bottom || bounds.left < clip.left || bounds.right > clip.right)) {
      target?.scrollIntoView?.({ behavior: reducedMotion ? "instant" : "smooth", block: "center", inline: "nearest" });
    }
    dialog.current?.focus({ preventScroll: true });
    let frame = 0;
    const measure = () => {
      const shell = document.querySelector(".design-shell");
      const scale = shell ? Number.parseFloat(getComputedStyle(shell).zoom) || 1 : 1;
      const width = window.innerWidth, height = window.innerHeight;
      const rect = visible(target) ? target.getBoundingClientRect() : null;
      const padding = 8 * scale;
      const clip = clippingBounds(target);
      const left = Math.max(4 * scale, clip.left, (rect?.left ?? 0) - padding);
      const top = Math.max(4 * scale, clip.top, (rect?.top ?? 0) - padding);
      const hole = rect && rect.width > 0 && rect.height > 0 ? {
        left, top, width: Math.max(0, Math.min(width - 4 * scale, clip.right, rect.right + padding) - left),
        height: Math.max(0, Math.min(height - 4 * scale, clip.bottom, rect.bottom + padding) - top),
      } : null;
      const cardBounds = card.current?.getBoundingClientRect();
      const next = { width, height, scale, hole, cardWidth: cardBounds?.width || 372 * scale, cardHeight: cardBounds?.height || 240 * scale };
      setGeometry((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = () => {
      const available = STEPS.filter((item) => visible(targetFor(item)));
      if (available.map((item) => item.target).join() !== steps.map((item) => item.target).join()) {
        const kept = available.findIndex((item) => item.target === steps[step - 1]?.target);
        setSteps(available);
        setStep(step === 0 ? 0 : kept >= 0 ? kept + 1 : Math.min(step, available.length));
      }
      schedule();
    };
    measure();
    // Account for shell entry and smooth scrolling, then use observations.
    const settles = [100, 400, 850].map((delay) => window.setTimeout(schedule, delay));
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (card.current) observer?.observe(card.current);
    if (target) observer?.observe(target);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", schedule, true);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame); settles.forEach(window.clearTimeout); observer?.disconnect();
      window.removeEventListener("resize", resize); window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [step, steps]);

  if (step === null) return null;
  const current = steps[step - 1];
  const { scale, width, height, hole } = geometry;
  const placement = layoutWorkspaceTour({ viewportWidth: width, viewportHeight: height, scale, target: hole, cardWidth: geometry.cardWidth, cardHeight: geometry.cardHeight, preferred: current?.preferred });
  const firstName = name?.trim().split(/\s+/)[0];
  return createPortal(<div ref={dialog} className="design-tour" role="dialog" aria-modal="true" aria-labelledby="workspace-tour-title" aria-describedby="workspace-tour-description" tabIndex={-1}
    style={{ zoom: scale, width: width / scale, height: height / scale }}>
    <div className="design-tour-shade" style={{ clipPath: spotlightPath(width, height, hole, scale) }} />
    <div className="design-tour-ring" aria-hidden="true" style={{ opacity: hole ? 1 : 0, transform: `translate(${(hole?.left ?? width / 2) / scale}px, ${(hole?.top ?? height / 2) / scale}px)`, width: (hole?.width ?? 0) / scale, height: (hole?.height ?? 0) / scale }} />
    <button type="button" className="design-tour-skip" onClick={close} aria-label="Skip tour">Skip <kbd aria-hidden="true">Esc</kbd></button>
    <div className="design-tour-position" style={{ transform: `translate(${placement.left / scale}px, ${placement.top / scale}px)`, maxWidth: placement.availableMaxWidth / scale }}>
      {placement.caret && <span className="design-tour-caret" aria-hidden="true" style={{ left: (placement.caret.left - placement.left) / scale, top: (placement.caret.top - placement.top) / scale }} />}
      <div ref={card} className={`design-tour-card${current ? "" : " design-tour-intro"}`} style={{ maxHeight: placement.availableMaxHeight / scale }}>
        <div className="design-tour-copy" key={step}>
          {current ? <>
            <div className="design-tour-top"><span>{current.label}</span><span aria-label={`Step ${step} of ${steps.length}`}>{String(step).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</span></div>
            <h2 id="workspace-tour-title">{current.title}</h2><p id="workspace-tour-description">{current.text}</p>
          </> : <>
            <div className="design-tour-logo"><img src="/bodymaps-logo.svg" alt="" /></div>
            <span className="design-tour-greeting">{firstName ? `Welcome, ${firstName}` : "Welcome to BodyMaps"}</span>
            <h2 id="workspace-tour-title">A quick tour of BodyMaps</h2>
            <p id="workspace-tour-description">See how a CT scan becomes a full segmentation, from upload to results.</p>
          </>}
        </div>
      </div>
    </div>
    <div className="design-tour-bottom">
      <button type="button" className="design-tour-back" disabled={step === 0} onClick={() => setStep(step - 1)}><span aria-hidden="true">←</span> Back</button>
      <div className="design-tour-progress" aria-label="Tour steps">
        {["Welcome", ...steps.map((item) => item.label)].map((label, index) => <button type="button" key={index} className={`${index === step ? "current" : ""} ${index < step ? "complete" : ""}`}
          aria-label={`Go to ${label.toLowerCase()} step`} aria-current={index === step ? "step" : undefined} title={label} onClick={() => setStep(index)}><span /></button>)}
      </div>
      <button type="button" className="design-tour-next" onClick={() => step === steps.length ? close() : setStep(step + 1)}>{step === steps.length ? "Get started" : "Next"} <span aria-hidden="true">→</span></button>
    </div>
  </div>, document.body);
}
