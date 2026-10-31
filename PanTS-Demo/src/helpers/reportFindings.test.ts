import { describe, expect, it } from 'vitest';
import { formatMeasurement, getCoverageLimitations, getSourceReportText, isLesionLabel, lesionFindings, normalizeReportData, REPORT_ASSESSMENT_SCOPE, splitOrgans } from './reportFindings';

describe('report evidence boundaries', () => {
  it('does not turn legacy normal, missing flags, or small segmentation labels into normal assessments', () => {
    const data = normalizeReportData({ organ_volumes: {
      liver: { volume: 1300, mean_hu: 45, status: 'normal' },
      pancreas: { volume: 240, mean_hu: 60 },
      kidney_left: { volume: 2, mean_hu: 30, status: 'check' },
      kidney_right: { volume: 3, mean_hu: 28, status: 'check' },
    } })!;
    expect(data.organ_volumes.liver.status).toBe('not_assessed');
    expect(data.organ_volumes.pancreas.status).toBe('not_assessed');
    const { all, flagged, unassessed } = splitOrgans(data);
    expect(all).toHaveLength(4);
    expect(flagged).toEqual([]);
    expect(unassessed).toHaveLength(4);
    expect(data.organ_volumes.kidney_left.status).toBe('not_assessed');
  });

  it('preserves complete source text, negation, and findings outside segmentation labels even without masks', () => {
    const original = 'Synthetic report preamble\nFINDINGS:\nPleural effusion. Inguinal nodes are enlarged.\nPancreas: No mass or lesion.\nIMPRESSION:\nSee documented findings.';
    const data = normalizeReportData({ masks_available: false, source_report: {
      available: true, source: 'Synthetic fixture', text: original,
      findings: 'Shorter parsed field', impression: [], reviewed_by_clinician: false,
    } })!;
    expect(getSourceReportText(data)).toBe(original);
    expect(splitOrgans(data).all).toEqual([]);
  });

  it('retains legacy source findings and impressions without synthesizing diagnoses', () => {
    const data = normalizeReportData({
      comments: 'Pancreas: No enlarged area. No mass. Volume: 500 cc.\nPleura: Effusion.',
      impression: ['Inguinal lymph nodes described in the source.'], organ_volumes: {},
    })!;
    expect(getSourceReportText(data)).toBe('FINDINGS:\nPancreas: No enlarged area. No mass. Volume: 500 cc.\nPleura: Effusion.\n\nIMPRESSION:\nInguinal lymph nodes described in the source.');
    expect(getSourceReportText(data)).not.toContain('The scan found');
    expect(data.comments).toBe('');
    expect(data.impression).toEqual([]);
    expect(data.source_report?.purpose).toBe('unverified_reference');
  });

  it('keeps absent, invalid, and zero measurements distinct', () => {
    const data = normalizeReportData({ organ_volumes: {
      liver: { volume: '1300', mean_hu: NaN }, pancreas: { volume: 0, mean_hu: 0 },
    } })!;
    expect(formatMeasurement(data.organ_volumes.liver.volume, 'cc')).toBe('Not available');
    expect(formatMeasurement(data.organ_volumes.liver.mean_hu, 'HU')).toBe('Not available');
    expect(formatMeasurement(data.organ_volumes.pancreas.volume, 'cc')).toBe('0 cc');
  });

  it.each([undefined, { supported_outputs: ['cancer_detection'], disease_assessment: 'supported', explanation: 'All organs are healthy.' }])(
    'never expands the measurement-only contract from missing or unrecognized scope metadata', scope => {
      const sourceText = 'Stomach is healthy. No stomach cancer. Pleural effusion and inguinal nodes are documented.';
      const data = normalizeReportData({
        assessment_scope: scope,
        organ_volumes: { stomach: { volume: 150, mean_hu: 30, status: 'normal' } },
        source_report: { available: true, text: sourceText, reviewed_by_clinician: true },
      })!;
      expect(data.assessment_scope).toEqual(REPORT_ASSESSMENT_SCOPE);
      expect(data.organ_volumes.stomach.status).toBe('not_assessed');
      expect(getSourceReportText(data)).toBe(sourceText);
      expect(splitOrgans(data).flagged).toEqual([]);
    },
  );

  it('does not represent unavailable report placeholders as source evidence', () => {
    const data = normalizeReportData({ comments: 'Clinical comments unavailable.', impression: ['No impression available for this case.'] })!;
    expect(getSourceReportText(data)).toBe('');
    expect(getSourceReportText(normalizeReportData({ comments: '  \n', impression: ['  '] })!)).toBe('');
    expect(normalizeReportData({ error: 'Unavailable' })).toBeNull();
    expect(normalizeReportData({ unrelated: true })).toBeNull();
  });

  it('rebuilds coverage from trusted messages and observed data instead of arbitrary payload conclusions', () => {
    const unsafe = 'All organs healthy. No stomach cancer.';
    const data = normalizeReportData({
      organ_volumes: {}, coverage: { status: 'healthy', measured_structures: 21, limitations: [unsafe] },
    })!;
    expect(data.coverage?.status).toBe('limited');
    expect(data.coverage?.measured_structures).toBe(0);
    expect(data.coverage?.limitations).not.toContain(unsafe);
    // The rendering helper also guards already-cached/legacy objects that did
    // not pass through the current normalizer.
    data.coverage!.limitations = [unsafe];
    expect(getCoverageLimitations(data)).not.toContain(unsafe);
    expect(getCoverageLimitations(data)).toContain('No measured structures are available in this response.');
    const failedSource = normalizeReportData({ organ_volumes: {}, source_report: { load_failed: true } })!;
    expect(getCoverageLimitations(failedSource)).toContain('The source reference could not be loaded.');
  });
});

describe('lesion findings', () => {
  it('turns only measured, non-empty lesion masks into findings, ordered pancreas, liver, kidney', () => {
    const data = normalizeReportData({ organ_volumes: {
      liver: { volume: 1300, mean_hu: 45 },
      kidney_left: { volume: 150, mean_hu: 30 },
      kidney_lesion: { volume: 2.5, mean_hu: 20, centroid_mm: [1, 2, 3] },
      pancreas: { volume: 80, mean_hu: 40 },
      pancreas_head: { volume: 30, mean_hu: 41 },
      pancreatic_lesion: { volume: 4.2, mean_hu: 25, dimensions: [2, 1.5, 1] },
      liver_lesion: { volume: 0, mean_hu: null },
    } })!;
    const findings = lesionFindings(data);
    expect(findings.map(f => f.mask)).toEqual(['pancreatic_lesion', 'kidney_lesion']);
    expect(findings[0].organ).toBe('pancreas');
    expect(findings[0].organLabels.map(([name]) => name)).toEqual(['pancreas', 'pancreas_head']);
    expect(findings[1].organLabels.map(([name]) => name)).toEqual(['kidney_left']);
    expect(findings[1].lesion.centroid_mm).toEqual([1, 2, 3]);
  });

  it('never derives a finding from flags, source text or organs without a lesion mask', () => {
    const data = normalizeReportData({
      organ_volumes: { pancreas: { volume: 240, mean_hu: 40, status: 'check' } },
      comments: 'Pancreas: 3 cm mass with lesion volume: 9 cc.',
    })!;
    expect(lesionFindings(data)).toEqual([]);
    expect(lesionFindings(null)).toEqual([]);
    expect(isLesionLabel('pancreatic_lesion')).toBe(true);
    expect(isLesionLabel('pancreas')).toBe(false);
  });
});
