import { afterEach, describe, expect, it, vi } from "vitest";
import { requestInferenceAdmission } from "../helpers/inferenceAdmission";

const reply = (status: number, code?: string) => ({ response: { status } as Response, data: { code } });
afterEach(() => vi.useRealTimers());

describe("owned inference admission retry", () => {
  it("retries the explicit admission race at one-second intervals and returns the real acknowledgement", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(reply(409, "inference_admitting")).mockResolvedValue(reply(200));
    const result = requestInferenceAdmission(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ ...reply(200), pending: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds pending admission at ten attempts without claiming success or failure", async () => {
    vi.useFakeTimers(); const request = vi.fn().mockResolvedValue(reply(409, "inference_admitting"));
    const result = requestInferenceAdmission(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await result).toMatchObject({ pending: true, response: { status: 409 } });
    expect(request).toHaveBeenCalledTimes(10);
  });

  it.each([403, 409, 500])("does not retry a different HTTP %s failure", async (status) => {
    const request = vi.fn().mockResolvedValue(reply(status, "different_error"));
    expect(await requestInferenceAdmission(request, new AbortController().signal)).toMatchObject({ pending: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops a pending retry immediately when its account or run is cancelled", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(reply(409, "inference_admitting"));
    const result = requestInferenceAdmission(request, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500); controller.abort();
    await rejected; await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
