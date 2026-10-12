import { assertUploadAccount, createAccountUploadController } from "./uploadAccount";

type InferenceResponse = { session_id?: string; error?: string };

/** Use the captured account for this continuation even if another tab changes
 * the cookie while its request or response parsing is still in flight. */
export async function requestReconstructionInference(options: {
  apiBase: string;
  ownerId: string | null;
  sessionId: string;
  sourceSessionId: string;
  parseResponse: (response: Response) => Promise<InferenceResponse>;
}): Promise<InferenceResponse> {
  const controller = createAccountUploadController(options.ownerId);
  try {
    assertUploadAccount(options.ownerId, controller.signal);
    const body = new FormData();
    body.append("session_id", options.sessionId);
    body.append("model_name", "ePAI");
    body.append("source_reconstruction_session_id", options.sourceSessionId);
    const response = await fetch(`${options.apiBase}/api/run-epai-inference`, {
      method: "POST", body, credentials: "include",
      headers: { "X-Upload-Owner": options.ownerId! }, signal: controller.signal,
    });
    const data = await options.parseResponse(response);
    assertUploadAccount(options.ownerId, controller.signal);
    if (!response.ok) throw new Error(data.error || "Failed to start ePAI inference on reconstruction");
    return data;
  } finally {
    controller.abort();
  }
}
