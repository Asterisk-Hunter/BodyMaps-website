export type PipelineSelection = {
  preprocessing: "OpenVAE" | null;
  postprocessing: "ShapeKit" | null;
};

export type InferenceSelection = PipelineSelection & {
  lesionTarget?: "pancreatic" | "liver" | "kidney" | "colon";
};

/** Presentation metadata only; never submitted as an executed server stage. */
export type PipelinePreviewSelection = {
  preprocessingPreview?: "OpenVAE";
  postprocessingPreview?: "ShapeKit";
};

export const EMPTY_PIPELINE: PipelineSelection = { preprocessing: null, postprocessing: null };

export type PipelineOption = { id: string; label: string; available: boolean; reason: string | null; supported_models: string[] };
export type PipelineOptions = { version: 1; preprocessing: PipelineOption[]; postprocessing: PipelineOption[] };
export type PipelineStage = {
  id: "preprocessing" | "segmentation" | "postprocessing" | "packaging";
  model: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

export function readPipelineOptions(value: unknown): PipelineOptions | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return null;
  const payload = value as Record<string, unknown>;
  const read = (key: string, id: string): PipelineOption[] => Array.isArray(payload[key])
    ? payload[key].filter((option): option is PipelineOption => option !== null && typeof option === "object"
      && option.id === id && typeof option.label === "string" && typeof option.available === "boolean"
      && (option.reason === null || typeof option.reason === "string")
      && Array.isArray(option.supported_models) && option.supported_models.every((model: unknown) => typeof model === "string")) : [];
  return { version: 1, preprocessing: read("preprocessing", "OpenVAE"), postprocessing: read("postprocessing", "ShapeKit") };
}

export function readPipelineStages(value: unknown): PipelineStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((stage): stage is PipelineStage => stage !== null && typeof stage === "object"
    && ["preprocessing", "segmentation", "postprocessing", "packaging"].includes(stage.id)
    && ["queued", "running", "completed", "failed", "cancelled"].includes(stage.status)
    && (stage.model === null || typeof stage.model === "string")
    && (stage.error === null || typeof stage.error === "string"));
}

/** Add only explicit selections. Older saved runs keep their original model-only request. */
export function appendPipelineFields(body: FormData, selection?: InferenceSelection): void {
  if (selection?.preprocessing) body.append("preprocessing", selection.preprocessing);
  if (selection?.postprocessing) body.append("postprocessing", selection.postprocessing);
  if (selection?.lesionTarget) body.append("lesion_target", selection.lesionTarget);
}

/** A previous backend must never silently ignore an optional-stage request. */
export function pipelineAcknowledged(value: unknown, model: string, selection?: InferenceSelection): boolean {
  if (!selection?.preprocessing && !selection?.postprocessing) return true;
  if (!value || typeof value !== "object") return false;
  const pipeline = value as Record<string, unknown>;
  return pipeline.version === 1 && pipeline.model === model
    && pipeline.preprocessing === (selection?.preprocessing ?? null)
    && pipeline.postprocessing === (selection?.postprocessing ?? null);
}
