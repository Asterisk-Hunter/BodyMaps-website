import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { createBatchArchive, DOWNLOAD_URL_LIFETIME_MS, MAX_BATCH_RESULT_BYTES, startBlobDownload } from "../helpers/batchDownload";
import type { RecentUpload } from "../helpers/recentUploads";

const upload = (sessionId: string, status: RecentUpload["status"] = "Completed", label = "scan"): RecentUpload => ({
  sessionId, status, label, model: "ePAI", timestamp: 1,
});
const statusResponse = (status = "completed") => new Response(JSON.stringify({ status }), { headers: { "content-type": "application/json" } });
const resultResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Response(bytes, { headers: { "content-type": "application/zip", ...headers } });
const options = { apiBase: "https://example.test/" };
const smallZip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

const blobBytes = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.onerror = reject;
  reader.readAsArrayBuffer(blob);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("completed batch result downloads", () => {
  it("builds one real archive with separate intact ZIPs and authenticated requests only for completed unique scans", async () => {
    const inner = new JSZip();
    inner.file("output.csv", "synthetic,test\n");
    const bytes = await inner.generateAsync({ type: "uint8array" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(resultResponse(bytes))
      .mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(resultResponse(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const result = await createBatchArchive([
      upload("a", "Completed", "../../scan:name"), upload("waiting", "Processing"),
      upload("a", "Completed", "../../scan:name"), upload("b", "Completed", "scan"), upload("failed", "Failed"),
    ], { ...options, onProgress: progress });
    expect(result.count).toBe(2);
    const archive = await JSZip.loadAsync(await blobBytes(result.blob));
    const names = Object.keys(archive.files);
    expect(names).toEqual(["001__.._scan_name.zip", "002_scan.zip"]);
    for (const name of names) {
      const nested = await JSZip.loadAsync(await archive.file(name)!.async("uint8array"));
      expect(await nested.file("output.csv")!.async("string")).toBe("synthetic,test\n");
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/inference-status/a", "https://example.test/api/get_result/a",
      "https://example.test/api/inference-status/b", "https://example.test/api/get_result/b",
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init.credentials === "include" && init.cache === "no-store")).toBe(true);
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });

  it("rejects an empty completed selection without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createBatchArchive([upload("a", "Processing")], options)).rejects.toThrow("No completed scans");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return a partial archive when a later scan is not completed on the server", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(resultResponse(smallZip)).mockResolvedValueOnce(statusResponse("processing"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createBatchArchive([upload("a"), upload("b")], options)).rejects.toThrow("not completed on the server");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([202, 404, 403, 401])("rejects HTTP %s result responses rather than archiving their error body", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(new Response("{}", { status })));
    await expect(createBatchArchive([upload("a")], options)).rejects.toThrow();
  });

  it("rejects a revoked account before attempting to fetch result bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createBatchArchive([upload("a")], options)).rejects.toThrow("sign in again");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an oversized response from Content-Length before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(MAX_BATCH_RESULT_BYTES + 1) } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(response));
    await expect(createBatchArchive([upload("a")], options)).rejects.toThrow("Download each completed scan individually");
    expect(cancel).toHaveBeenCalled();
  });

  it.each([{}, { "content-length": "1" }])("enforces a cumulative streamed cap even with missing or inaccurate headers %j", async (headers) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(smallZip); },
      cancel,
    }), { headers });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(resultResponse(smallZip))
      .mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(response));
    await expect(createBatchArchive([upload("a"), upload("b")], { ...options, maxBytes: smallZip.length * 2 - 1 })).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects an HTTP 200 HTML response masquerading as a result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(statusResponse()).mockResolvedValueOnce(new Response("<!DOCTYPE html>Sign in")));
    await expect(createBatchArchive([upload("a")], options)).rejects.toThrow("did not return a result ZIP");
  });

  it("aborts before making requests when the account/page has changed", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createBatchArchive([upload("a")], { ...options, signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("starts a real browser download and releases its URL only after the browser can consume it", () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn(() => "blob:download-test");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href).toBe("blob:download-test");
    expect(this.download).toBe("results.zip");
    expect(document.body.contains(this)).toBe(true);
  });
  startBlobDownload(new Blob([smallZip]), "results.zip");
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector('a[download="results.zip"]')).toBeNull();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(DOWNLOAD_URL_LIFETIME_MS);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:download-test");
});
