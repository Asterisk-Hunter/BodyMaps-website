import { expect, it, vi } from 'vitest';
import { parallelPair } from './parallelVolumes';

it('starts both full-resolution reads before either resolves, retaining exact buffers', async () => {
  let finish!: (value: Int16Array) => void;
  const ct = new Int16Array([-1024, 40, 400]);
  const mask = new Uint8Array([0, 1, 39]);
  const right = vi.fn(async () => mask);
  const loading = parallelPair(() => new Promise<Int16Array>(resolve => { finish = resolve; }), right);
  await Promise.resolve();
  expect(right).toHaveBeenCalledOnce();
  finish(ct);
  const result = await loading;
  expect(result[0]).toBe(ct);
  expect(result[1]).toBe(mask);
});

it('propagates a load failure without substituting or inventing an image', async () => {
  await expect(parallelPair(async () => { throw new Error('CT failed'); }, async () => null)).rejects.toThrow('CT failed');
});
