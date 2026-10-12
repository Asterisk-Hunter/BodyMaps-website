import type { RecentUpload } from "./recentUploads";

// The input ZIPs are already compressed. STORE avoids inflating or recompressing
// them. A 64 MiB aggregate limit leaves room for JSZip's output copies and the
// final download Blob, instead of retaining several full CT result sets.
export const MAX_BATCH_RESULT_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;
const TOO_LARGE = "This batch is too large to bundle in your browser. Download each completed scan individually.";

type BatchOptions = {
  apiBase: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** A lower limit can be supplied by constrained clients. Never raises the cap. */
  maxBytes?: number;
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) return new Error("Please sign in again before downloading results.");
  if (response.status === 403) return new Error("You do not have access to one of these results.");
  if (response.status === 404) return new Error("One of these results is no longer available. Open batch details to check each scan.");
  return new Error(fallback);
}

async function readLimitedResult(response: Response, remaining: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > remaining) {
    await response.body?.cancel();
    throw new Error(TOO_LARGE);
  }
  // Do not use blob()/arrayBuffer() as an unbounded fallback: a missing or
  // inaccurate Content-Length must not bypass the aggregate memory budget.
  if (!response.body) throw new Error("Your browser cannot bundle these results. Download each scan individually.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > remaining) throw new Error(TOO_LARGE);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // HTTP 202/JSON and proxy HTML must never become a pretend result archive.
  const zipHeader = result[0] === 0x50 && result[1] === 0x4b && (
    (result[2] === 0x03 && result[3] === 0x04) || (result[2] === 0x05 && result[3] === 0x06)
  );
  if (!zipHeader) throw new Error("The server did not return a result ZIP. Download each scan individually or retry.");
  return result;
}

function entryName(label: string, index: number): string {
  const safe = label.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 100) || "scan";
  return `${String(index + 1).padStart(3, "0")}_${safe}.zip`;
}

/** All-or-nothing bundle of the completed, authenticated upload results only. */
export async function createBatchArchive(uploads: RecentUpload[], options: BatchOptions): Promise<{ blob: Blob; count: number }> {
  const completed = [...new Map(uploads.filter((upload) => upload.status === "Completed").map((upload) => [upload.sessionId, upload])).values()];
  if (!completed.length) throw new Error("No completed scans to download yet.");
  const maxBytes = Math.min(options.maxBytes ?? MAX_BATCH_RESULT_BYTES, MAX_BATCH_RESULT_BYTES);
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error(TOO_LARGE);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  let totalBytes = 0;
  const base = options.apiBase.replace(/\/$/, "");
  for (const [index, upload] of completed.entries()) {
    options.signal?.throwIfAborted();
    if (!upload.sessionId) throw new Error("A scan is missing its result identifier. Open batch details and retry individually.");
    const id = encodeURIComponent(upload.sessionId);
    const requestOptions: RequestInit = { credentials: "include", cache: "no-store", signal: options.signal };
    const status = await fetch(`${base}/api/inference-status/${id}`, requestOptions);
    if (!status.ok) throw await responseError(status, "Could not check one of these results. Please retry.");
    const statusData = await status.json();
    if (statusData.status !== "completed") throw new Error("One of these scans is not completed on the server. Open batch details to check its status.");
    const response = await fetch(`${base}/api/get_result/${id}`, requestOptions);
    if (response.status !== 200) throw await responseError(response, "One of these result archives is not ready. Please retry shortly.");
    const bytes = await readLimitedResult(response, maxBytes - totalBytes);
    totalBytes += bytes.byteLength;
    zip.file(entryName(upload.label, index), bytes, { compression: "STORE" });
    options.onProgress?.(index + 1, completed.length);
  }
  options.signal?.throwIfAborted();
  const content = await zip.generateAsync(
    { type: "uint8array", compression: "STORE", streamFiles: true },
    () => options.signal?.throwIfAborted(),
  );
  options.signal?.throwIfAborted();
  return { blob: new Blob([content], { type: "application/zip" }), count: completed.length };
}

/** Keep the URL alive long enough for the browser to begin consuming the file. */
export function startBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
}
