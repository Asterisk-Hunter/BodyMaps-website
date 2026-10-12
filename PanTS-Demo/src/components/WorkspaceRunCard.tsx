import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatRelativeTime, type RecentUpload } from "../helpers/recentUploads";
import type { PipelineStage } from "../helpers/inferencePipeline";
import "./WorkspaceRunCard.css";

type Props = {
  upload: RecentUpload;
  phase?: string;
  queuePosition?: number;
  estimate?: string;
  closeNote?: string;
  actions?: ReactNode;
};

type PreviewAnimation = { percent: number; state: "idle" | "animating" | "finished" | "stopped" };
type RunStep = {
  id: "upload" | PipelineStage["id"];
  label: string;
  detail: string;
  state: "done" | "active" | "queued" | "pending" | "stopped" | "skipped" | "preview";
  status?: string;
};

/** A labelled UI animation only. It never changes a job, stage, result or request. */
function usePreviewAnimation(enabled: boolean, stage: "preprocessing" | "postprocessing", status: RecentUpload["status"], sessionId: string) {
  const identity = useRef(sessionId);
  const observedActive = useRef(status === "Processing");
  const finished = useRef(status === "Completed");
  const [animation, setAnimation] = useState<PreviewAnimation>({ percent: status === "Completed" ? 100 : 0, state: status === "Completed" ? "finished" : "idle" });
  useEffect(() => {
    if (identity.current !== sessionId) {
      identity.current = sessionId;
      observedActive.current = status === "Processing";
      finished.current = status === "Completed";
      setAnimation({ percent: status === "Completed" ? 100 : 0, state: status === "Completed" ? "finished" : "idle" });
    }
    if (!enabled) return;
    if (status === "Processing") observedActive.current = true;
    if (status === "Failed" || status === "Cancelled") {
      setAnimation((previous) => previous.state === "finished" ? previous : { ...previous, state: "stopped" });
      return;
    }
    // Reloaded completed history gets a still frame, never a replay. If real
    // inference finishes early, finish the pre-demo before starting the post-demo.
    if (status === "Completed" && (stage === "preprocessing" || !observedActive.current)) {
      finished.current = true;
      setAnimation({ percent: 100, state: "finished" });
      return;
    }
    const shouldAnimate = stage === "preprocessing" ? status === "Processing" : status === "Completed";
    if (!shouldAnimate || finished.current) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (timer !== undefined) clearInterval(timer);
      finished.current = true;
      setAnimation({ percent: 100, state: "finished" });
    };
    if (motion?.matches) { finish(); return; }
    const started = Date.now();
    setAnimation({ percent: 0, state: "animating" });
    timer = setInterval(() => {
      const percent = Math.min(100, Math.round((Date.now() - started) / 2000 * 100));
      if (percent === 100) finish();
      else setAnimation({ percent, state: "animating" });
    }, 50);
    const motionChanged = () => { if (motion?.matches) finish(); };
    motion?.addEventListener?.("change", motionChanged);
    return () => { if (timer !== undefined) clearInterval(timer); motion?.removeEventListener?.("change", motionChanged); };
  }, [enabled, stage, status, sessionId]);
  return animation;
}

/** Real run state stays separate from clearly labelled, optional UI animations. */
export default function WorkspaceRunCard({ upload, phase, queuePosition, estimate, closeNote, actions }: Props) {
  const complete = upload.status === "Completed";
  const stopped = upload.status === "Failed" || upload.status === "Cancelled";
  const observedStages = upload.pipelineStages?.length ? upload.pipelineStages : undefined;
  // Actual server evidence takes precedence over stale presentation metadata.
  const preprocessingPreview = upload.preprocessingPreview === "OpenVAE" && !upload.pipeline?.preprocessing
    && !observedStages?.some((stage) => stage.id === "preprocessing");
  const postprocessingPreview = upload.postprocessingPreview === "ShapeKit" && !upload.pipeline?.postprocessing
    && !observedStages?.some((stage) => stage.id === "postprocessing");
  const preAnimation = usePreviewAnimation(preprocessingPreview, "preprocessing", upload.status, upload.sessionId);
  const postAnimation = usePreviewAnimation(postprocessingPreview, "postprocessing", upload.status, upload.sessionId);
  // A terminal response supersedes the previous queue/running observation.
  if (stopped) phase = undefined;
  const transferring = phase === "uploading" || phase === "waiting";
  const admitted = phase === "queued" || phase === "running" || complete || !!observedStages;
  const headline = complete ? "Your results are ready" : stopped ? `Run ${upload.status.toLowerCase()}`
    : phase === "waiting" ? "Waiting to upload" : phase === "uploading" ? "Uploading your scan"
    : phase === "queued" ? (queuePosition ? `Number ${queuePosition} in the GPU queue` : "Queued for GPU")
    : phase === "admitting" ? "Starting your run" : phase === "admission-pending" ? "Waiting for server confirmation"
    : phase === "running" ? (upload.isReconstruction ? `Reconstructing your scan with ${upload.model}.` : `Running ${upload.model} on your scan.`) : "Checking run status";
  const observedStage = (id: PipelineStage["id"]) => observedStages?.find((stage) => stage.id === id);
  const preModel = observedStage("preprocessing")?.model || upload.pipeline?.preprocessing;
  const postModel = observedStage("postprocessing")?.model || upload.pipeline?.postprocessing;
  const model = observedStage("segmentation")?.model || upload.model;
  const serverStep = (id: PipelineStage["id"], label: string, fallback: Omit<RunStep, "id" | "label">): RunStep => {
    const stage = observedStage(id);
    if (!stage) return { id, label, ...fallback };
    // A completed job may arrive before refreshed per-stage telemetry. Do not
    // leave a running animation on its earlier queued/running observation.
    const stageDone = stage.status === "completed" || (complete && (stage.status === "queued" || stage.status === "running"));
    return {
      id, label,
      detail: stageDone ? "Step completed" : stage.status === "failed" ? "Step failed"
        : stage.status === "cancelled" ? "Step cancelled" : stage.status === "running" ? (stopped ? "Run stopped" : "Running on the server") : "Waiting for this step",
      state: stageDone ? "done" : stage.status === "failed" || stage.status === "cancelled" || (stage.status === "running" && stopped) ? "stopped"
        : stage.status === "running" ? "active" : "pending",
      status: stage.status === "failed" ? "Failed" : stage.status === "cancelled" ? "Cancelled" : undefined,
    };
  };
  const optionalStep = (id: "preprocessing" | "postprocessing", preview: boolean, selectedModel: string | null | undefined): RunStep => {
    const name = id === "preprocessing" ? "Preprocessing" : "Postprocessing";
    if (preview) return { id, label: `${name} preview · ${id === "preprocessing" ? "OpenVAE" : "ShapeKit"}`,
      detail: id === "preprocessing" ? "OpenVAE was previewed only and did not run. Segmentation uses the original CT."
        : "ShapeKit was previewed only and did not run. No ShapeKit refinement was applied.", state: "preview" };
    if (!selectedModel && !observedStage(id)) return { id, label: name, detail: "Not selected", state: "skipped" };
    return serverStep(id, `${name} with ${selectedModel || "selected model"}`, {
      detail: complete ? "Step completed" : "Waiting for this step", state: complete ? "done" : "pending",
    });
  };
  // Keep the reference's five rows. A legacy model-only job can report its
  // model as running, but a pipeline without stage telemetry cannot identify
  // which selected stage is currently running.
  const modelOnlyRunning = !observedStages && !preModel && !postModel && phase === "running" && !stopped;
  const steps: RunStep[] = [
    { id: "upload", label: "Uploading scan", detail: admitted ? "Scan received" : phase === "waiting" ? "Waiting for the current transfer" : phase === "uploading" ? "Transferring scan data" : "Waiting for scan transfer",
      state: admitted ? "done" : phase === "uploading" && !stopped ? "active" : transferring && !stopped ? "queued" : "pending" },
    optionalStep("preprocessing", preprocessingPreview, preModel),
    serverStep("segmentation", `${upload.isReconstruction ? "Reconstructing" : "Segmenting"} with ${model}`, {
      detail: complete ? "Processing complete" : phase === "queued" ? "Waiting for an available GPU" : modelOnlyRunning ? "Running on the server" : "Waiting for model status",
      state: complete ? "done" : modelOnlyRunning ? "active" : phase === "queued" && !stopped ? "queued" : "pending",
    }),
    optionalStep("postprocessing", postprocessingPreview, postModel),
    serverStep("packaging", "Preparing results", {
      detail: complete ? "Ready to open in the viewer" : stopped ? "No completed result" : upload.isReconstruction ? "Reconstructed CT for the viewer" : "Masks for the 2D and 3D viewer",
      state: complete ? "done" : "pending",
    }),
  ];
  return <article className={`workspace-run-card status-${upload.status.toLowerCase()}`} aria-label={`Run: ${upload.label}`}>
    <div className="workspace-run-request">
      <span className="workspace-run-file-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg></span>
      <div className="workspace-run-file"><strong title={upload.sourceName || upload.label}>{upload.sourceName || upload.label}</strong>
        <span>{upload.label} · {formatRelativeTime(upload.timestamp)}</span></div>
      <div className="workspace-run-chips">
        <span><small>Pre</small>{preprocessingPreview ? "OpenVAE (preview only)" : preModel || "None"}</span>
        <span className="workspace-run-model-chip"><small>Model</small>{upload.model}</span>
        <span><small>Post</small>{postprocessingPreview ? "ShapeKit (preview only)" : postModel || "None"}</span>
      </div>
    </div>
    <div className="workspace-run-response">
      <img src="/bodymaps-logo.svg" alt="" />
      <div className="workspace-run-body">
        <h3 aria-live="polite">{headline}</h3>
        <ol className="workspace-run-steps" aria-label="Pipeline progress">
          {steps.map((step) => <li key={step.id} className={`is-${step.state}`} aria-current={step.state === "active" || step.state === "queued" ? "step" : undefined}>
            <div className="workspace-run-step-row">
              <span className="workspace-run-step-icon" aria-hidden="true"><span className="workspace-run-step-mark">
                {step.state === "done" ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  : step.state === "stopped" ? "!" : null}
              </span></span>
              <div className="workspace-run-step-copy"><strong>{step.label}</strong>{step.detail && <p>{step.detail}</p>}</div>
              <small>{step.status || (step.state === "done" ? "Done" : step.state === "active" ? "Processing" : step.state === "queued" ? "Queued" : step.state === "stopped" ? upload.status : step.state === "preview" ? "Not run" : step.state === "skipped" ? "Skipped" : "Pending")}</small>
            </div>
              <div className="workspace-run-stage-track" role={step.state === "active" ? "progressbar" : undefined}
                aria-label={step.state === "active" ? `${step.label}: processing` : undefined} aria-hidden={step.state !== "active"}>
                <div className="workspace-run-stage-fill" />
              </div>
              {step.state === "preview" && (() => {
                const preprocessing = step.id === "preprocessing";
                const animation = preprocessing ? preAnimation : postAnimation;
                const model = preprocessing ? "OpenVAE" : "ShapeKit";
                return <div className="workspace-preview-animation">
                  <div className="workspace-preview-track" role="progressbar" aria-label={`${model} preview animation`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={animation.percent}
                    aria-valuetext={`${animation.percent}% of UI preview animation. No ${model} processing applied.`}>
                    <div className="workspace-preview-fill" style={{ width: `${animation.percent}%` }} />
                  </div>
                  <div className="workspace-preview-caption"><p>{animation.state === "animating" ? "Preview animation" : animation.state === "finished" ? "Preview animation finished"
                    : animation.state === "stopped" ? "Preview animation stopped" : "Preview waits for the real result"}. No processing applied.</p>
                    <span aria-hidden="true">{animation.percent}% preview</span></div>
                </div>;
              })()}
          </li>)}
        </ol>
        {phase === "running" && !stopped && !complete && estimate && <p className="workspace-run-note">Estimated timing: {estimate}</p>}
        {upload.pipeline?.preprocessing === "OpenVAE" && observedStages?.some((stage) => stage.id === "segmentation" && stage.status === "completed")
          && <p className="workspace-run-note">Segmentation used the reconstructed CT; the viewer retains the original CT.</p>}
        {closeNote && !stopped && !complete && <p className="workspace-run-note">{closeNote}</p>}
        {stopped && <p className="workspace-run-note">{upload.status === "Cancelled" ? "This run was cancelled." : "This run did not complete. Select your scan again to start another run."}</p>}
        {actions && <div className={`workspace-run-actions${complete ? " is-result" : ""}`}>
          {complete && <div className="workspace-result-summary"><strong>{upload.isReconstruction ? "Reconstruction ready" : "Segmentation ready"}</strong>
            <p>{upload.isReconstruction ? "Reconstructed CT is ready to open in the viewer." : "Masks are ready to open in the viewer."}</p></div>}
          {actions}</div>}
      </div>
    </div>
  </article>;
}
