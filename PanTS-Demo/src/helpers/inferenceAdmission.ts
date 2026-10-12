const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 1000;

function waitForAdmissionRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, RETRY_DELAY_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Retry only the server's explicit, owned admission race. Other conflicts are
 * real errors. Never invent an accepted job while its validation is pending. */
export async function requestInferenceAdmission<T extends { code?: string }>(
  request: () => Promise<{ response: Response; data: T }>,
  signal: AbortSignal,
): Promise<{ response: Response; data: T; pending: boolean }> {
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const reply = await request();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const admitting = reply.response.status === 409 && reply.data?.code === "inference_admitting";
    if (!admitting || attempt === MAX_ATTEMPTS) return { ...reply, pending: admitting };
    await waitForAdmissionRetry(signal);
  }
}
