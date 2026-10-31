import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { MemoryRouter as DomMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportScreen from '../components/ReportScreen/ReportScreen';
import SharePatientCard from '../routes/SharePatientCard';
import LegalPage from '../routes/LegalPage';

function fixture(id: string) {
  return {
    case_id: id, report_schema_version: '3', patient: { age: 61, sex: 'F' },
    organ_volumes: { liver: { volume: 1500, mean_hu: 60, status: 'not_assessed' } },
    comments: '', impression: [],
    source_report: { available: false, source: 'Synthetic report fixture', text: '', findings: '', impression: [], reviewed_by_clinician: false },
    provenance: { report_source: 'Synthetic report fixture', measurements_source: 'Synthetic CT + segmentation', image_review_performed: false },
    coverage: { status: 'limited', measured_structures: 1, limitations: [] },
  };
}
const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload }) as Response;
const failed = (status: number) => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as Response;
const props = { onClose: vi.fn(), onViewChange: vi.fn() };

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(writeText) }, configurable: true });
}

function renderShare(path = '/share/synthetic-token') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/share/:shareId" element={<SharePatientCard />} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(navigator, 'share');
});

describe('report data recovery', () => {
  it('ends a hung report request as unavailable after 30 s, and Try again asks once more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>(() => {})).mockResolvedValueOnce(ok(fixture('hung-case')));
    vi.stubGlobal('fetch', fetch);
    render(<ReportScreen id="hung-case" {...props} />);
    expect(screen.getByText('Preparing your report…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.queryByText('Report unavailable.')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('Report unavailable.')).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Understanding your CT scan' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('offers Try again beside Close when the report fails to load', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(failed(503)).mockResolvedValueOnce(ok(fixture('retry-case')));
    vi.stubGlobal('fetch', fetch);
    render(<ReportScreen id="retry-case" {...props} />);
    await screen.findByText('Report unavailable.');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Understanding your CT scan' })).toBeInTheDocument();
  });
});

describe('share report popover', () => {
  // The report also has a status line of its own that names the step.
  const popover = () => document.getElementById('rs-share-popover')!;
  function stubReportAndToken(id: string, ...tokenAnswers: Response[]) {
    const tokens = [...tokenAnswers];
    const fetch = vi.fn((url: string) => {
      if (url.includes('/api/get-report-data/')) return Promise.resolve(ok(fixture(id)));
      if (url.includes('/token')) return Promise.resolve(tokens.shift() ?? failed(500));
      return Promise.reject(new TypeError('unexpected request'));
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('says when no link could be made, and a retry that works moves focus to Copy', async () => {
    stubReportAndToken('share-retry', failed(500), ok({ url: '/share/tok123' }));
    render(<ReportScreen id="share-retry" {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Share report/ }));
    expect(await screen.findByText("Couldn't create a link.")).toBeInTheDocument();
    expect(within(popover()).getByRole('status')).toHaveTextContent("Couldn't create a link. Try again.");
    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    const link = screen.getByRole('textbox', { name: 'Share link' });
    await waitFor(() => expect(link).toHaveValue(`${window.location.origin}/share/tok123`));
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus();
    expect(screen.queryByText("Couldn't create a link.")).not.toBeInTheDocument();
  });

  it('selects the link and says so when the clipboard is refused', async () => {
    stubReportAndToken('share-copy', ok({ url: '/share/tok456' }));
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<ReportScreen id="share-copy" {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Share report/ }));
    const link = screen.getByRole('textbox', { name: 'Share link' });
    await waitFor(() => expect(link).toHaveValue(`${window.location.origin}/share/tok456`));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(link).toHaveFocus());
    expect(within(popover()).getByRole('status')).toHaveTextContent("Couldn't copy the link. Select it and copy it yourself.");
  });

  it('returns focus to Share report when Escape closes the popover from inside', async () => {
    stubReportAndToken('share-escape', ok({ url: '/share/tok789' }));
    render(<ReportScreen id="share-escape" {...props} />);
    const shareButton = await screen.findByRole('button', { name: /Share report/ });
    fireEvent.click(shareButton);
    const link = screen.getByRole('textbox', { name: 'Share link' });
    await waitFor(() => expect(link).toHaveValue(`${window.location.origin}/share/tok789`));
    link.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Share link' })).not.toBeInTheDocument();
    expect(shareButton).toHaveFocus();
  });
});

describe('shared summary card', () => {
  it('tells an unreachable server apart from a dead link and retries it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(failed(503)).mockResolvedValueOnce(ok(fixture('shared-retry')));
    vi.stubGlobal('fetch', fetch);
    renderShare();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the shared summary…');
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this summary. Try again in a moment.");
    expect(screen.queryByText("This report link isn't available.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('main')).toHaveFocus();
    expect(await screen.findByRole('heading', { level: 1, name: /mapped in 3D|My CT scan in 3D/ })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a request that never reached the server as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderShare();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this summary.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps a refused link as not available, with no retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed(404)));
    renderShare();
    expect(await screen.findByRole('alert')).toHaveTextContent("This report link isn't available.");
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('falls back to the share sheet, then to a note, when the clipboard is refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(fixture('shared-copy'))));
    stubClipboard(() => Promise.reject(new Error('denied')));
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    renderShare();
    const button = await screen.findByRole('button', { name: 'Share this BodyMap' });
    fireEvent.click(button);
    await waitFor(() => expect(share).toHaveBeenCalledWith({ url: window.location.href }));
    expect(screen.queryByText(/Couldn't copy the link/)).not.toBeInTheDocument();

    Reflect.deleteProperty(navigator, 'share');
    fireEvent.click(button);
    expect(await screen.findByText("Couldn't copy the link. Copy the address from your browser instead.")).toBeInTheDocument();
  });
});

// Every /api route needs a signed-in session, and the server answers 401 with this code
// once it has ended. That is not a missing report or a dead link: the account context is
// told, signs the page out and brings up the sign-in prompt, as the quiz and live rooms do.
describe('an ended sign-in', () => {
  const ended = () => ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required', code: 'authentication_required' }) }) as Response;
  const expired = vi.fn();
  beforeEach(() => {
    expired.mockClear();
    window.addEventListener('bodymaps:session-expired', expired);
  });
  afterEach(() => window.removeEventListener('bodymaps:session-expired', expired));

  it('is reported when the report data is asked for', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ended()));
    render(<ReportScreen id="ended-report" {...props} />);
    await screen.findByText('Report unavailable.');
    expect(expired).toHaveBeenCalledOnce();
  });

  it('is reported when a share link is made', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      Promise.resolve(url.includes('/api/get-report-data/') ? ok(fixture('ended-share')) : ended())));
    render(<ReportScreen id="ended-share" {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Share report/ }));
    await waitFor(() => expect(expired).toHaveBeenCalledOnce());
  });

  it('is reported by a shared summary card instead of calling the link dead', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ended()));
    renderShare();
    await waitFor(() => expect(expired).toHaveBeenCalledOnce());
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this summary.");
    expect(screen.queryByText("This report link isn't available.")).not.toBeInTheDocument();
  });

  it('is not reported for any other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed(401)));
    renderShare();
    expect(await screen.findByRole('alert')).toHaveTextContent("This report link isn't available.");
    render(<ReportScreen id="other-refusal" {...props} />);
    await screen.findByText('Report unavailable.');
    expect(expired).not.toHaveBeenCalled();
  });
});

describe('privacy notice', () => {
  it('no longer names a QR code service', () => {
    render(<DomMemoryRouter><LegalPage kind="privacy" /></DomMemoryRouter>);
    expect(document.body.textContent ?? '').not.toMatch(/qrserver|QR code/i);
    expect(document.body.textContent ?? '').toMatch(/Anyone who has a share link or live room link can open its content\./);
  });
});
