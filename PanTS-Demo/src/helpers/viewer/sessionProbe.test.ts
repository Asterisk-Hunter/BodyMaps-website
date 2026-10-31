import { afterEach, expect, it, vi } from 'vitest';
import { probeSessionVolume } from './sessionProbe';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([401, 403, 404])('does not bypass a %s refusal', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: false })));
  expect(await probeSessionVolume('/api/session-ct/owned', new AbortController().signal)).toBe(false);
});

it('uses HEAD with credentials and admits an available scan', async () => {
  const fetch = vi.fn(async () => ({ status: 200, ok: true }));
  vi.stubGlobal('fetch', fetch);
  expect(await probeSessionVolume('/api/session-ct/owned', new AbortController().signal)).toBe(true);
  expect(fetch).toHaveBeenCalledWith('/api/session-ct/owned', expect.objectContaining({ method: 'HEAD', credentials: 'include' }));
});

it('ends a hung preliminary request even if the transport ignores abort', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const pending = probeSessionVolume('/api/session-ct/owned', new AbortController().signal);
  const checked = expect(pending).rejects.toThrow('did not respond in time');
  await vi.advanceTimersByTimeAsync(15_000);
  await checked;
});

it('cancels on navigation and rejects service errors', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const controller = new AbortController();
  const pending = probeSessionVolume('/api/session-ct/owned', controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  vi.stubGlobal('fetch', vi.fn(async () => ({status: 503, ok: false})));
  await expect(probeSessionVolume('/api/session-ct/owned', new AbortController().signal)).rejects.toThrow('temporarily unavailable');
});
