import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";
import { loadPendingUploads } from '../helpers/pendingUploads';
import { mergeServerHistory } from '../helpers/serverHistory';
import {
  RECENT_UPLOADS_KEY, RECENT_UPLOADS_MIGRATED, setRecentUploadsAccount, loadRecentUploads,
} from "../helpers/recentUploads";

vi.mock("../helpers/pendingUploads", () => ({
  loadPendingUploads: vi.fn(async () => []),
  deletePendingUpload: vi.fn(), savePendingUpload: vi.fn(),
  setPendingNextChunk: vi.fn(), setPendingUploaded: vi.fn(),
  chunkSizeOf: vi.fn(),
}));

beforeEach(() => { localStorage.clear(); setRecentUploadsAccount(null); vi.mocked(loadPendingUploads).mockResolvedValue([]); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reconnects a newer server retry after the original session poller completed', async () => {
  const job = { session_id: 'retry-owned', model: 'ePAI', status: 'running', created_at: '2026-10-23T12:00:00', updated_at: '2026-10-23T12:00:01' };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  let polls = 0;
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') posts.push(url);
    if (url.includes('/api/auth/me')) return json({ user: { id: 'a', email: 'a@example.com', plan: 'pro' } });
    if (url.includes('/api/me/jobs')) return json({ user_id: 'a', jobs: [job] });
    if (url.includes('/api/inference-status/')) {
      polls += 1;
      return json({ status: polls === 1 ? 'completed' : 'running', updated_at: polls === 1 ? '2026-10-23T12:00:02' : '2026-10-23T12:00:03' });
    }
    return json({ items: [], total: 0, ids: [] });
  }));
  const view = render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
  await waitFor(() => expect(loadRecentUploads()[0]?.status).toBe('Completed'), { timeout: 5000 });
  await act(async () => { mergeServerHistory('a', [{ ...job, updated_at: '2026-10-23T12:00:03' }]); });
  await waitFor(() => expect(polls).toBe(2));
  await act(async () => { mergeServerHistory('a', [{ ...job, updated_at: '2026-10-23T12:00:03' }]); });
  expect(polls).toBe(2);
  expect(posts.filter(url => /inference|upload/.test(url))).toEqual([]);
  view.unmount();
});

it('does not let an older terminal response stop polling a newer server attempt', async () => {
  const job = { session_id: 'delayed-owned', model: 'ePAI', status: 'running', created_at: '2026-10-23T12:00:00', updated_at: '2026-10-23T12:00:01' };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  let polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/me')) return json({ user: { id: 'a', email: 'a@example.com', plan: 'pro' } });
    if (url.includes('/api/me/jobs')) return json({ user_id: 'a', jobs: [job] });
    if (url.includes('/api/inference-status/')) {
      polls += 1;
      return polls === 1 ? old : json({ status: 'running', updated_at: '2026-10-23T12:00:03' });
    }
    return json({ items: [], total: 0, ids: [] });
  }));
  const view = render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
  await waitFor(() => expect(polls).toBe(1), { timeout: 5000 });
  await act(async () => {
    mergeServerHistory('a', [{ ...job, updated_at: '2026-10-23T12:00:03' }]);
    finishOld(json({ status: 'completed', updated_at: '2026-10-23T12:00:02' }));
  });
  expect(loadRecentUploads()[0].status).toBe('Processing');
  await waitFor(() => expect(polls).toBe(2), { timeout: 5000 });
  view.unmount();
});

it("resumes an owned legacy run when verification finishes after the workspace mounts", async () => {
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(["owned", "someone-else"].map((sessionId) => ({
    sessionId, label: sessionId, model: "ePAI", status: "Processing", timestamp: Date.now(),
  }))));
  let finishOwnership!: (value: Response) => void;
  const ownership = new Promise<Response>((resolve) => { finishOwnership = resolve; });
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.includes("/api/auth/me")) return json({ user: { id: "a", email: "a@example.com", plan: "pro" } });
    if (url.includes("/api/me/jobs")) return ownership;
    if (url.includes("/api/inference-status/")) return json({ status: "complete" });
    return json({ items: [], total: 0, ids: [] });
  }));
  const view = render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
  // Auth restoration and the plan-aware default both settle asynchronously.
  // Keep the ownership assertions below strict without depending on host load.
  await screen.findByRole("button", { name: /^ePAI$/ }, { timeout: 5000 });
  await waitFor(() => expect(requests.some((url) => url.endsWith("/api/me/jobs"))).toBe(true));
  expect(requests.some((url) => url.includes("/api/inference-status/"))).toBe(false);

  await act(async () => { finishOwnership(json({ user_id: "a", jobs: [{ session_id: "owned" }] })); });
  await waitFor(() => expect(requests.some((url) => url.endsWith("/api/inference-status/owned"))).toBe(true));
  expect(requests.some((url) => url.includes("inference-status/someone-else"))).toBe(false);
  // A repeated or foreign migration notification must not start another poller.
  await act(async () => {
    window.dispatchEvent(new CustomEvent(RECENT_UPLOADS_MIGRATED, { detail: { ownerId: "b", sessionIds: ["someone-else"] } }));
    window.dispatchEvent(new CustomEvent(RECENT_UPLOADS_MIGRATED, { detail: { ownerId: "a", sessionIds: ["owned"] } }));
  });
  expect(requests.filter((url) => url.endsWith("/api/inference-status/owned"))).toHaveLength(1);
  view.unmount();
});

it('only polls a server-confirmed run even if a stale uploaded cursor remains locally', async () => {
  vi.mocked(loadPendingUploads).mockResolvedValue([{
    sessionId: 'owned', file: new Blob(), filename: 'ct.nii.gz', model: 'ePAI',
    bdmapId: '', totalChunks: 1, nextChunk: 1, uploadedFilename: 'ct.nii.gz',
  }]);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const requests: {url: string; method?: string}[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push({url, method: init?.method});
    if (url.includes('/api/auth/me')) return json({ user: { id: 'a', email: 'a@example.com', plan: 'pro' } });
    if (url.includes('/api/me/jobs')) return json({ user_id: 'a', jobs: [{ session_id: 'owned', model: 'ePAI', status: 'running', created_at: '2026-10-23T12:00:00' }] });
    if (url.includes('/api/inference-status/')) return json({ status: 'complete' });
    return json({items: [], total: 0, ids: []});
  }));
  const view = render(<AuthProvider><MemoryRouter><UploadPage /></MemoryRouter></AuthProvider>);
  await waitFor(() => expect(requests.some(request => request.url.endsWith('/api/inference-status/owned'))).toBe(true), { timeout: 5000 });
  expect(requests.some(request => request.method === 'POST' && /inference|upload/.test(request.url))).toBe(false);
  view.unmount();
});
