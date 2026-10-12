import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatRelativeTime, type RecentUpload } from "../helpers/recentUploads";
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
    : phase === "running" ? "Processing your scan" : "Checking run status";
  const processingSteps = observedStages ? observedStages.map((stage) => ({
      label: stage.id === "preprocessing" ? `Reconstruct CT · ${stage.model}` : stage.id === "segmentation" ? `Segment scan · ${stage.model}`
        : stage.id === "postprocessing" ? `Refine organ masks · ${stage.model}` : "Prepare results",
      detail: stage.status === "completed" ? "Step completed" : stage.status === "failed" ? "Step failed"
        : stage.status === "cancelled" ? "Step cancelled" : stage.status === "running" && !stopped ? "Running on the server" : "Waiting for this step",
      state: stage.status === "completed" ? "done" : stage.status === "failed" || stage.status === "cancelled" ? "stopped"
        : stage.status === "running" && !stopped ? "active" : "pending",
    })) : [{ label: "Process pipeline", detail: complete ? "Processing complete" : phase === "queued" ? "Waiting for an available GPU" : phase === "running" ? "Running the selected pipeline" : "",
      state: complete ? "done" : (phase === "queued" || phase === "running") && !stopped ? "active" : "pending" }];
  if (preprocessingPreview) processingSteps.unshift({ label: "Preprocessing preview · OpenVAE", detail: "Preview only. No reconstruction is run.", state: "preview" });
  if (postprocessingPreview) {
    const packagingIndex = processingSteps.findIndex((step) => step.label === "Prepare results");
    processingSteps.splice(packagingIndex < 0 ? processingSteps.length : packagingIndex, 0,
      { label: "Postprocessing preview · ShapeKit", detail: "Preview only. No ShapeKit refinement is run.", state: "preview" });
  }
  const steps = [
    { label: "Upload scan", detail: admitted ? "Scan received" : phase === "waiting" ? "Waiting for the current transfer" : phase === "uploading" ? "Transferring scan data" : "",
      state: admitted ? "done" : transferring && !stopped ? "active" : "pending" },
    ...processingSteps,
    { label: "Results", detail: complete ? "Ready to open in the viewer" : stopped ? "No completed result" : "Available when processing finishes",
      state: complete ? "done" : stopped ? "stopped" : "pending" },
  ];
  return <article className={`workspace-run-card status-${upload.status.toLowerCase()}`} aria-label={`Run: ${upload.label}`}>
    <div className="workspace-run-request">
      <span className="workspace-run-file-icon" aria-hidden="true">↥</span>
      <div className="workspace-run-file"><strong title={upload.sourceName || upload.label}>{upload.sourceName || upload.label}</strong>
        <span>{upload.label} · {formatRelativeTime(upload.timestamp)}</span></div>
      <div className="workspace-run-chips">
        {preprocessingPreview && <span><small>Preview only (not run)</small>OpenVAE</span>}
        {upload.pipeline?.preprocessing && <span><small>Preprocessing</small>{upload.pipeline.preprocessing}</span>}
        <span><small>Model</small>{upload.model}</span>
        {upload.pipeline?.postprocessing && <span><small>Postprocessing</small>{upload.pipeline.postprocessing}</span>}
        {postprocessingPreview && <span><small>Preview only (not run)</small>ShapeKit</span>}
      </div>
    </div>
    <div className="workspace-run-response">
      <img src="/bodymaps-logo.svg" alt="" />
      <div className="workspace-run-body">
        <h3 aria-live="polite">{headline}</h3>
        <ol className="workspace-run-steps" aria-label="Pipeline progress">
          {steps.map((step) => <li key={step.label} className={`is-${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
            <span className="workspace-run-step-icon" aria-hidden="true">{step.state === "done" ? "✓" : step.state === "stopped" ? "!" : "○"}</span>
            <div><strong>{step.label}</strong>{step.detail && <p>{step.detail}</p>}
              {step.state === "preview" && (() => {
                const preprocessing = step.label === "Preprocessing preview · OpenVAE";
                const animation = preprocessing ? preAnimation : postAnimation;
                const model = preprocessing ? "OpenVAE" : "ShapeKit";
                return <div className="workspace-preview-animation">
                  <p>{animation.state === "animating" ? "Preview animation" : animation.state === "finished" ? "Preview animation finished"
                    : animation.state === "stopped" ? "Preview animation stopped" : "Preview waits for the real result"}. No processing applied.</p>
                  <div className="workspace-preview-track" role="progressbar" aria-label={`${model} preview animation`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={animation.percent}
                    aria-valuetext={`${animation.percent}% of UI preview animation. No ${model} processing applied.`}>
                    <div className="workspace-preview-fill" style={{ width: `${animation.percent}%` }} />
                  </div>
                  <span aria-hidden="true">{animation.percent}% preview</span>
                </div>;
              })()}
            </div>
            <small>{step.state === "done" ? "Complete" : step.state === "active" ? "In progress" : step.state === "stopped" ? upload.status : step.state === "preview" ? "Not run" : "Pending"}</small>
          </li>)}
        </ol>
        {phase === "running" && !stopped && !complete && estimate && <p className="workspace-run-note">Estimated timing: {estimate}</p>}
        {preprocessingPreview && <p className="workspace-run-note">OpenVAE was previewed only and did not run. Segmentation uses the original CT.</p>}
        {postprocessingPreview && <p className="workspace-run-note">ShapeKit was previewed only and did not run. No ShapeKit refinement was applied.</p>}
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
