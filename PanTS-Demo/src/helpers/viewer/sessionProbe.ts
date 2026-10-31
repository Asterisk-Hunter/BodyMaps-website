/** Admission check only. Never download a volume or bypass a refusal. */
export async function probeSessionVolume(url: string, signal: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  const controller = new AbortController();
  let rejectWait: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectWait = reject; });
  const abort = () => {
    controller.abort();
    rejectWait(new DOMException('Scan opening cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectWait(new Error('The scan service did not respond in time. Please try again.'));
  }, timeoutMs);
  try {
    if (signal.aborted) abort();
    const response = await Promise.race([
      fetch(url, { method: 'HEAD', credentials: 'include', signal: controller.signal }), interrupted,
    ]);
    if ([401, 403, 404].includes(response.status)) return false;
    if (!response.ok) throw new Error('The scan service is temporarily unavailable. Please try again.');
    return true;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
