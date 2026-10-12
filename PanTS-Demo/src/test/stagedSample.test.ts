import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageSample } from "../helpers/stagedSample";
import { setRecentUploadsAccount } from "../helpers/recentUploads";
import { createAccountUploadController } from "../helpers/uploadAccount";

const sid = "4805d59b-731d-4d38-b070-b111f24f86a9";
const owner = "sample-helper-owner";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const ready = () => json({ status: "combined", session_id: sid, uploaded_filename: "BDMAP_SAMPLE/ct.nii.gz",
  file_name: "PanTS_00000002.nii.gz", case_id: "PanTS_00000002", size: 11169107, bdmap_id: "BDMAP_SAMPLE" });
beforeEach(() => { vi.useFakeTimers(); setRecentUploadsAccount(owner); });
afterEach(() => { setRecentUploadsAccount(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retries only an owned sample_preparing reply and reuses the same session", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: "sample_preparing" }, 409)).mockResolvedValueOnce(ready());
  vi.stubGlobal("fetch", fetchMock);
  const request = stageSample(sid, owner, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await request).toMatchObject({ sessionId: sid, ownerId: owner, size: 11169107 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, options] of fetchMock.mock.calls) expect(JSON.parse(options.body)).toEqual({ session_id: sid });
});

it("bounds an admission conflict without accepting a pretend completed copy", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "sample_preparing" }, 409)));
  const assertion = expect(stageSample(sid, owner, new AbortController().signal)).rejects.toThrow("taking longer than expected");
  await vi.advanceTimersByTimeAsync(10_000);
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(10);
});

it.each(["cancel", "account switch"])("stops queued staging retries after %s", async (action) => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "sample_preparing" }, 409)));
  const controller = createAccountUploadController(owner);
  const assertion = expect(stageSample(sid, owner, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  if (action === "cancel") controller.abort(); else setRecentUploadsAccount("other-owner");
  await vi.advanceTimersByTimeAsync(10_000);
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not retry another conflict or expose server internals in the error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "sample_in_use", error: "/private/server/path" }, 409)));
  await expect(stageSample(sid, owner, new AbortController().signal)).rejects.toThrow("temporarily unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("explains the account's pending-sample limit", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "sample_staging_limit" }, 429)));
  await expect(stageSample(sid, owner, new AbortController().signal)).rejects.toThrow("Remove an unused sample");
});
