import { API_BASE } from "./constants";
import { assertUploadAccount } from "./uploadAccount";

/** An owned server copy, never a placeholder browser File. */
export type StagedSample = {
  sessionId: string;
  ownerId: string;
  uploadedFilename: string;
  filename: string;
  size: number;
  caseId: string;
  bdmapId: string;
};

function waitForSample(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function stageSample(
  sessionId: string,
  ownerId: string,
  signal: AbortSignal,
  transportSignal: AbortSignal = signal,
): Promise<StagedSample> {
  for (let attempt = 0; attempt < 10; attempt++) {
    assertUploadAccount(ownerId, signal);
    const response = await fetch(`${API_BASE}/api/stage-sample`, {
      method: "POST", credentials: "include", signal: transportSignal,
      headers: { "Content-Type": "application/json", "X-Upload-Owner": ownerId },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = await response.json().catch(() => null);
    assertUploadAccount(ownerId, signal);
    if (response.status === 409 && data?.code === "sample_preparing") {
      if (attempt === 9) throw new Error("Sample preparation is taking longer than expected. Please try again.");
      await waitForSample(signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? "Sign in again to prepare a sample case."
        : response.status === 429 && data?.code === "sample_staging_limit"
        ? "Remove an unused sample from the workspace before preparing another one."
        : response.status === 429 && data?.code === "sample_rate_limit"
        ? "Too many sample requests. Please wait before preparing another sample."
        : "The sample is temporarily unavailable. Please try again or select a local CT scan.");
    }
    // Only accept the specific owned staging contract. Never follow a returned
    // arbitrary URL or pass an unexpected filename into inference.
    if (data?.status !== "combined" || data.session_id !== sessionId
      || data.uploaded_filename !== "BDMAP_SAMPLE/ct.nii.gz" || data.bdmap_id !== "BDMAP_SAMPLE"
      || typeof data.case_id !== "string" || !/^(PanTS_\d+|CV_[A-Za-z0-9_-]+)$/.test(data.case_id)
      || data.file_name !== `${data.case_id}.nii.gz`
      || !Number.isSafeInteger(data.size) || data.size <= 0) {
      throw new Error("The server returned an invalid sample reference. Please try again.");
    }
    return { sessionId, ownerId, uploadedFilename: data.uploaded_filename,
      filename: data.file_name, size: data.size, caseId: data.case_id, bdmapId: data.bdmap_id };
  }
  throw new Error("The sample could not be prepared.");
}

/** Best-effort release; the server refuses deletion after inference claims it. */
export async function releaseStagedSample(sessionId: string, ownerId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/stage-sample/${encodeURIComponent(sessionId)}`, {
      method: "DELETE", credentials: "include", keepalive: true,
      headers: { "X-Upload-Owner": ownerId },
    });
  } catch { /* Bounded server expiry also cleans abandoned browser selections. */ }
}

/** Only explicit Preview downloads CT bytes. Selection and Run exchange metadata. */
export async function previewStagedSample(sample: StagedSample, signal: AbortSignal): Promise<File> {
  assertUploadAccount(sample.ownerId, signal);
  const response = await fetch(`${API_BASE}/api/session-ct/${encodeURIComponent(sample.sessionId)}`, {
    credentials: "include", signal, headers: { "X-Upload-Owner": sample.ownerId },
  });
  if (!response.ok || /json|text\//i.test(response.headers.get("content-type") || "")) {
    throw new Error("The sample preview could not be loaded. You can retry or run inference without a preview.");
  }
  const bytes = await response.arrayBuffer();
  assertUploadAccount(sample.ownerId, signal);
  if (!bytes.byteLength) throw new Error("The sample preview is empty. Please try again.");
  // session-ct can use Content-Encoding:gzip, which fetch transparently
  // decompresses. Give the viewer a name that matches the actual bytes.
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const compressed = header[0] === 0x1f && header[1] === 0x8b;
  return new File([bytes], compressed ? sample.filename : sample.filename.replace(/\.gz$/, ""),
    { type: compressed ? "application/gzip" : "application/octet-stream" });
}
