import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReconstructionInference } from "./reconstructionInference";
import { setRecentUploadsAccount } from "./recentUploads";

const options = () => ({ apiBase: "", ownerId: "u1", sessionId: "new-session", sourceSessionId: "source-reconstruction", parseResponse: (response: Response) => response.json() });
beforeEach(() => {
  setRecentUploadsAccount("u1");
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ session_id: "new-session" }), { status: 200 }));
});
afterEach(() => { setRecentUploadsAccount(null); vi.restoreAllMocks(); });

describe("account-bound reconstruction continuation", () => {
  it("sends the real source and new session with credentials and captured owner", async () => {
    expect(await requestReconstructionInference(options())).toEqual({ session_id: "new-session" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/run-epai-inference");
    expect(request).toMatchObject({ method: "POST", credentials: "include", headers: { "X-Upload-Owner": "u1" } });
    const body = request!.body as FormData;
    expect(Object.fromEntries(body.entries())).toEqual({ session_id: "new-session", model_name: "ePAI", source_reconstruction_session_id: "source-reconstruction" });
  });

  it.each([null, "u2"])("never dispatches the old account's continuation after scope becomes %s", async (owner) => {
    setRecentUploadsAccount(owner);
    await expect(requestReconstructionInference(options())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request when another account becomes active", async () => {
    let signal!: AbortSignal;
    global.fetch = vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    const promise = requestReconstructionInference(options());
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    setRecentUploadsAccount("u2");
    await rejected;
    expect(signal.aborted).toBe(true);
  });

  it("rejects a stale success that finishes parsing after logout", async () => {
    let finish!: (value: { session_id: string }) => void;
    const parseResponse = vi.fn(() => new Promise<{ session_id: string }>((resolve) => { finish = resolve; }));
    const promise = requestReconstructionInference({ ...options(), parseResponse });
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(parseResponse).toHaveBeenCalled());
    setRecentUploadsAccount(null);
    finish({ session_id: "new-session" });
    await rejected;
  });

  it("surfaces an explicit backend account-mismatch rejection", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ code: "account_changed", error: "Your signed-in account changed." }), { status: 409 }));
    await expect(requestReconstructionInference(options())).rejects.toThrow("Your signed-in account changed.");
  });
});
