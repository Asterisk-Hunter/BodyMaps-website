import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../../helpers/constants";
import type { AIModelInfo } from "./types";

const MODEL_STORAGE_KEY = "bodymaps-ai-model-v2";
const REASONING_MODEL = /qwen3(?!-vl)|deepseek-r1|-r1\b|:think|marco-o1|qwq/i;
const RETRY_MS = 15_000;

/** Recover an open sidebar when the server's model service restarts. */
export function useAIModels(open: boolean) {
  const [models, setModels] = useState<AIModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [visionAvailable, setVisionAvailable] = useState(true);
  const [modelState, setModelState] = useState<"loading" | "ollama" | "fallback">("loading");
  const [modelIssue, setModelIssue] = useState<"unavailable" | "empty" | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const refreshModels = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshingModels(true);
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${API_BASE}/api/ai-models`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (requestRef.current !== controller) return;
      const nextModels: AIModelInfo[] = Array.isArray(data.models) ? data.models : [];
      setVisionModel(String(data.vision_model || ""));
      setVisionAvailable(data.available !== false && data.vision_available !== false);
      if (!data.available || nextModels.length === 0) {
        setModels([]);
        setSelectedModel("");
        setModelState("fallback");
        setModelIssue(data.available ? "empty" : "unavailable");
        return;
      }
      setModels(nextModels);
      const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
      const backendDefault = String(data.default_model || "");
      const cleanModel = nextModels.find((model) => !REASONING_MODEL.test(model.name));
      const nextSelection = nextModels.some((model) => model.name === storedModel)
        ? storedModel
        : !REASONING_MODEL.test(backendDefault) &&
            nextModels.some((model) => model.name === backendDefault)
          ? backendDefault
          : cleanModel?.name ?? nextModels[0].name;
      setSelectedModel(nextSelection);
      setModelIssue(null);
      setModelState("ollama");
    } catch {
      if (requestRef.current !== controller) return;
      setModels([]);
      setSelectedModel("");
      setVisionAvailable(false);
      setModelIssue("unavailable");
      setModelState("fallback");
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setRefreshingModels(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshModels();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshModels();
    };
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      const controller = requestRef.current;
      requestRef.current = null;
      controller?.abort();
    };
  }, [open, refreshModels]);

  useEffect(() => {
    if (!open || modelState !== "fallback") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshModels();
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [open, modelState, refreshModels]);

  const selectModel = (name: string) => {
    setSelectedModel(name);
    window.localStorage.setItem(MODEL_STORAGE_KEY, name);
  };

  return {
    models, selectedModel, visionModel, visionAvailable, modelState, modelIssue,
    refreshingModels, refreshModels, selectModel,
  };
}
