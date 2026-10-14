import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportScreen, { REPORT_PANE_SELECTOR, reportPaneCss } from '../components/ReportScreen/ReportScreen';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('report dialog', () => {
  it('is a modal dialog, except while a reading session records', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(fixture('dialog-case'))));
    const view = render(<ReportScreen id="dialog-case" onClose={vi.fn()} onViewChange={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'CT scan report' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    view.rerender(<ReportScreen id="dialog-case" onClose={vi.fn()} onViewChange={vi.fn()} recording />);
    expect(dialog).not.toHaveAttribute('aria-modal');
  });

  it('closes the coachmark on the first Escape and the report on the next', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(fixture('escape-case'))));
    const onClose = vi.fn();
    render(<ReportScreen id="escape-case" onClose={onClose} onViewChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start walkthrough/ }));
    expect(screen.getByText('Are you a patient or a doctor?')).toBeInTheDocument();
    // The coachmark hands focus to the pressed half of the toggle it points at.
    expect(screen.getByRole('button', { name: 'Patient' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Are you a patient or a doctor?')).not.toBeInTheDocument();
    // Only the coachmark went: the walkthrough is still showing its step.
    expect(screen.getByRole('heading', { level: 1, name: 'Segmented structures' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    // The 3D pane eases back to rest before the report unmounts.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('names the steps and moves focus to the new heading when the pressed button goes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(fixture('steps-case'))));
    render(<ReportScreen id="steps-case" onClose={vi.fn()} onViewChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start walkthrough/ }));
    expect(screen.getByRole('button', { name: 'Step 1 of 2' })).toHaveAttribute('aria-current', 'step');
    fireEvent.keyDown(window, { key: 'Escape' });
    const next = screen.getByRole('button', { name: 'Continue' });
    next.focus();
    fireEvent.click(next);
    expect(screen.getByRole('heading', { level: 1, name: 'Measurement summary' })).toHaveFocus();
    expect(screen.getByText('Measurement summary', { selector: '[role="status"]' })).toBeInTheDocument();
  });

  it('moves focus to Close when the report cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response));
    render(<ReportScreen id="missing-case" onClose={vi.fn()} onViewChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Report unavailable.');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('offers a way out while the report is still loading', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    const onClose = vi.fn();
    render(<ReportScreen id="slow-case" onClose={onClose} onViewChange={vi.fn()} />);
    expect(screen.getByText('Preparing your report…')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
  });
});

describe('report pane poses', () => {
  it('outranks the viewer rule that stops its panes from animating, only while the report is open', () => {
    expect(REPORT_PANE_SELECTOR).toBe('.VisualizationPage.report-open .visualization-container .render');
    const css = reportPaneCss(1, 3, false);
    expect(css).toContain(`${REPORT_PANE_SELECTOR} { filter: none !important; transform: translateX(180px) !important; transition: filter 450ms`);
  });

  it('moves the scan under the stacked card on a phone, and never travels under reduced motion', () => {
    expect(reportPaneCss(1, 3, false)).toMatch(/@media \(max-width: 899px\) \{[^}]*scale\(0\.75\)/);
    expect(reportPaneCss(0, 3, false)).not.toContain('max-width: 899px');
    expect(reportPaneCss(2, 3, false)).not.toContain('max-width: 899px');
    for (const step of [0, 1, 2]) {
      expect(reportPaneCss(step, 3, false)).toContain(`@media (prefers-reduced-motion: reduce) { ${REPORT_PANE_SELECTOR} { transition: none !important; } }`);
    }
    expect(reportPaneCss(1, 3, true)).toContain('transform: none !important');
  });
});
