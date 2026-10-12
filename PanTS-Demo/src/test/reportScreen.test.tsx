import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportScreen, { prefetchReportData } from '../components/ReportScreen/ReportScreen';
import SharePatientCard from '../routes/SharePatientCard';

const original = 'Synthetic preamble\nFINDINGS:\nPleural effusion. Inguinal nodes are enlarged.\nPancreas: No mass or lesion.\nIMPRESSION:\nSource findings require review.';
function fixture(id: string, sourceText = original) {
  return {
    case_id: id, report_schema_version: '3', patient: { age: 'Unknown', sex: 'Unknown' },
    organ_volumes: { pancreas: { volume: 240, mean_hu: 40, status: 'normal' } },
    comments: 'Pancreas: No mass or lesion.', impression: ['Source findings require review.'],
    source_report: { available: true, source: 'Synthetic report fixture', text: sourceText, findings: '', impression: [], reviewed_by_clinician: false },
    provenance: { report_source: 'Synthetic report fixture', measurements_source: 'Synthetic CT + segmentation', image_review_performed: false },
    coverage: { status: 'limited', measured_structures: 1, limitations: ['Pleura and lymph nodes are outside this segmentation summary.'] },
  };
}
const response = (payload: unknown) => ({ ok: true, json: async () => payload }) as Response;
const props = { onClose: vi.fn(), onViewChange: vi.fn() };
function NextShare() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/share/next-synthetic')}>Next shared case</button>;
}
async function expandSourceReference() {
  const toggle = await screen.findByText('Unverified source reference', { selector: 'summary' });
  expect(toggle.closest('details')).not.toHaveAttribute('open');
  expect(screen.queryByTestId('source-report-text')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  return screen.getByTestId('source-report-text');
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('report presentation', () => {
  it.each(['walkthrough', 'share'])('rejects arbitrary coverage claims and does not promise a missing source in %s', async surface => {
    const data = {
      case_id: `missing-${surface}`, patient: {}, organ_volumes: {}, masks_available: false,
      comments: '', impression: [],
      coverage: { status: 'healthy', measured_structures: 21, limitations: ['All organs healthy. No stomach cancer.'] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    if (surface === 'walkthrough') render(<ReportScreen id={`missing-${surface}`} {...props} />);
    else render(<MemoryRouter initialEntries={['/share/missing-synthetic']}><Routes><Route path="/share/:shareId" element={<SharePatientCard />} /></Routes></MemoryRouter>);
    await screen.findByText('Supported output: segmentation measurements');
    expect(screen.queryByText(/All organs healthy|No stomach cancer\./)).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified source reference', { selector: 'summary' })).not.toBeInTheDocument();
    expect(screen.getByText('Source reference text is unavailable. Its absence does not establish a negative disease result.')).toBeInTheDocument();
    expect(screen.queryByText(/can still be expanded|Stored source text is available/)).not.toBeInTheDocument();
    if (surface === 'walkthrough') {
      fireEvent.click(screen.getByRole('button', { name: /Start walkthrough/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Patient', exact: true }));
    }
    expect(screen.getByText('Segmentation measurements are unavailable. No source reference text is available for this case.')).toBeInTheDocument();
    expect(screen.queryByText(/can still be expanded/)).not.toBeInTheDocument();
  });

  it.each(['walkthrough', 'share'])('keeps unsupported stomach claims out of the default %s summary', async surface => {
    const sourceText = 'Stomach is healthy. No stomach cancer.\nPleural effusion. Enlarged inguinal nodes.\nIMPRESSION:\nStored claims, not validated by this feature.';
    const data = {
      ...fixture(`stomach-${surface}`, sourceText),
      organ_volumes: { stomach: { volume: 150, mean_hu: 30, status: 'normal' } },
      assessment_scope: { supported_outputs: ['cancer_detection'], disease_assessment: 'supported', explanation: 'All organs are healthy.' },
      source_report: { ...fixture('source').source_report, text: sourceText, reviewed_by_clinician: true },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    if (surface === 'walkthrough') render(<ReportScreen id={`stomach-${surface}`} {...props} />);
    else render(<MemoryRouter initialEntries={['/share/stomach-synthetic']}><Routes><Route path="/share/:shareId" element={<SharePatientCard />} /></Routes></MemoryRouter>);
    await screen.findByText('Supported output: segmentation measurements');
    await waitFor(() => expect(screen.getByText('Disease assessment: not supported. Disease status: not assessed.')).toBeVisible());
    expect(screen.getByText(/absence of an automated finding is not a negative disease result, including for stomach cancer/)).toBeVisible();
    expect(screen.queryByTestId('source-report-text')).not.toBeInTheDocument();
    expect(screen.queryByText(/Stomach is healthy|No stomach cancer|All organs are healthy|Pleural effusion\./i)).not.toBeInTheDocument();
    expect((await expandSourceReference()).textContent).toBe(sourceText);
    expect(screen.getByText(/Statements below are not findings or conclusions of this auto-report feature/)).toBeVisible();
    expect(screen.getByText('Disease assessment: not supported. Disease status: not assessed.')).toBeVisible();
    fireEvent.click(screen.getByText('Unverified source reference', { selector: 'summary' }));
    expect(screen.queryByTestId('source-report-text')).not.toBeInTheDocument();
  });

  it('leads with capability limits and preserves source text only on explicit expansion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('intro'))));
    render(<ReportScreen id="intro" {...props} />);
    expect((await expandSourceReference()).textContent).toBe(original);
    expect(screen.getByText('Source: Synthetic report fixture')).toBeInTheDocument();
    expect(screen.getByText('Disease assessment is not supported for segmented or unsegmented structures.')).toBeInTheDocument();
    expect(screen.queryByText(/looks? healthy|All clear|No findings to review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/The scan found/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start walkthrough/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Patient', exact: true }));
    expect(screen.getByText('Clinical status: not assessed')).toBeInTheDocument();
    expect(screen.getByText(/Segmented volume: 240 cc/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }));
    expect((await expandSourceReference()).textContent).toBe(original);
    expect(screen.queryByText(/All clear/i)).not.toBeInTheDocument();
  });

  it('retains source-only reports in the shared card when masks and organ labels are absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...fixture('shared'), organ_volumes: undefined, masks_available: false })));
    const view = render(<MemoryRouter initialEntries={['/share/synthetic']}><Routes><Route path="/share/:shareId" element={<SharePatientCard />} /></Routes></MemoryRouter>);
    expect((await expandSourceReference()).textContent).toBe(original);
    expect(screen.getByText(/Segmentation measurements are unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/All clear|looked healthy|RADIOLOGY IMPRESSION/i)).not.toBeInTheDocument();
    expect(view.container.querySelector('img[src*="qrserver"]')).toBeNull();
    expect([...view.container.querySelectorAll('img')].every(img => !img.src.includes('/share/'))).toBe(true);
  });

  it('preserves a report without masks in the walkthrough and does not invent missing demographics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...fixture('source-only'), patient: {}, organ_volumes: {}, masks_available: false })));
    render(<ReportScreen id="source-only" {...props} />);
    expect((await expandSourceReference()).textContent).toBe(original);
    expect(screen.getByText('Case source-only', { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start walkthrough/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Patient', exact: true }));
    expect(screen.getByText(/Segmentation measurements are unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/All clear|No findings to review/i)).not.toBeInTheDocument();
  });

  it('identifies stored RadGPT wording as unverified AI-generated text rather than clinician conclusions', async () => {
    const data = fixture('radgpt-fixture');
    data.source_report.source = 'RadGPT metadata workbook';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    render(<ReportScreen id="radgpt-fixture" {...props} />);
    await expandSourceReference();
    expect(screen.getByText(/Stored AI-generated report.*not independently verified/)).toBeInTheDocument();
  });

  it('does not retain source text from a previous shared case when the next link fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(fixture('first-shared'))).mockResolvedValueOnce({ ok: false }));
    render(<MemoryRouter initialEntries={['/share/first-synthetic']}><NextShare /><Routes><Route path="/share/:shareId" element={<SharePatientCard />} /></Routes></MemoryRouter>);
    await expandSourceReference();
    fireEvent.click(screen.getByRole('button', { name: 'Next shared case' }));
    await screen.findByText("This report link isn't available.");
    expect(screen.queryByTestId('source-report-text')).not.toBeInTheDocument();
  });

  it('does not promote legacy flags or source volume into a disease finding or lesion measurement', async () => {
    const data = fixture('flagged', 'Pancreas: Enlarged, volume: 999 cc. No lesion reported.');
    data.organ_volumes.pancreas.status = 'check';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    render(<ReportScreen id="flagged" {...props} />);
    expect((await expandSourceReference()).textContent).toContain('Enlarged, volume: 999 cc');
    fireEvent.click(screen.getByRole('button', { name: /Start walkthrough/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Doctor', exact: true }));
    expect(screen.getByText(/Segmented volume: 240 cc/)).toBeInTheDocument();
    expect(screen.getByText('Clinical status: not assessed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review flags', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/None detected|The scan found|sizable|999 cc/i)).not.toBeInTheDocument();
  });

  it('clears the previous case while loading and ignores a stale case response', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response(fixture('new-case', 'New synthetic report.')));
    vi.stubGlobal('fetch', fetch);
    const view = render(<ReportScreen id="old-pending-case" {...props} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<ReportScreen id="new-case" {...props} />);
    expect((await expandSourceReference()).textContent).toBe('New synthetic report.');
    await act(async () => { resolveFirst(response(fixture('old-pending-case', 'Old synthetic report.'))); await first; });
    expect(screen.getByTestId('source-report-text').textContent).toBe('New synthetic report.');
  });

  it('discards the displayed report and walkthrough step if the next case fails to load', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(fixture('shown-case'))).mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetch);
    const view = render(<ReportScreen id="shown-case" {...props} />);
    await expandSourceReference();
    fireEvent.click(screen.getByRole('button', { name: /Start walkthrough/ }));
    view.rerender(<ReportScreen id="failed-case" {...props} />);
    await screen.findByText('Report unavailable.');
    expect(screen.queryByTestId('source-report-text')).not.toBeInTheDocument();
    expect(screen.queryByText('Segmented structures')).not.toBeInTheDocument();
  });

  it('coalesces prefetches but revalidates source data after the cache expires', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const fetch = vi.fn().mockResolvedValueOnce(response(fixture('cache-case'))).mockResolvedValueOnce(response(fixture('cache-case', 'Updated synthetic source.')));
    vi.stubGlobal('fetch', fetch);
    const first = prefetchReportData('cache-case');
    expect(prefetchReportData('cache-case')).toBe(first);
    await first;
    await prefetchReportData('cache-case');
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(62000);
    const updated = await prefetchReportData('cache-case');
    expect(updated?.source_report?.text).toBe('Updated synthetic source.');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toEqual({ cache: 'no-store' });
  });
});
