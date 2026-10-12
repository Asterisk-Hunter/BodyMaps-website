// Report text and segmentation measurements are separate evidence sources.
// Neither absent flags nor an in-range measurement establishes clinical normality.
export interface OrganData {
  volume: number | null;
  mean_hu: number | null;
  status?: 'not_assessed' | 'normal' | 'check';
  centroid_mm?: [number, number, number];
  dimensions?: [number, number, number];
}

export interface AssessmentScope {
  supported_outputs: ['segmentation_measurements'];
  disease_assessment: 'not_supported';
  explanation: string;
}

// This renderer supports measurements only. Source wording, legacy flags, and
// unrecognized server scope values must never expand its clinical capabilities.
export const REPORT_ASSESSMENT_SCOPE: AssessmentScope = {
  supported_outputs: ['segmentation_measurements'],
  disease_assessment: 'not_supported',
  explanation: 'This auto-report feature provides segmentation measurements only. It does not provide a validated disease assessment or screen for cancer. Measurements cannot establish health or exclude disease in the stomach or any other organ.',
};

export interface ReportData {
  case_id: string;
  report_schema_version?: string;
  assessment_scope?: AssessmentScope;
  patient: { age: number | string; sex: string };
  imaging?: { study_type: string; contrast: string; spacing: number[]; shape: number[] };
  organ_volumes: Record<string, OrganData>;
  lesions?: Record<string, { voxels: number; volume: number }>;
  masks_available?: boolean;
  comments: string;
  impression: string[];
  source_report?: {
    purpose?: 'unverified_reference';
    load_failed?: boolean;
    available: boolean;
    source: string;
    text: string;
    findings: string;
    impression: string[];
    reviewed_by_clinician: boolean;
  };
  provenance?: {
    report_source: string;
    measurements_source: string;
    image_review_performed: boolean;
  };
  coverage?: { status: string; measured_structures: number; limitations: string[] };
}

const DEFAULT_LIMITATIONS = [
  'Segmentation measurements do not establish whether a structure is normal or abnormal.',
  'Disease assessment is not supported for segmented or unsegmented structures.',
];

function trustedCoverageLimitations(measuredStructures: number, sourceLoadFailed = false): string[] {
  return [
    ...DEFAULT_LIMITATIONS,
    ...(measuredStructures === 0 ? ['No measured structures are available in this response.'] : []),
    ...(sourceLoadFailed ? ['The source reference could not be loaded.'] : []),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function triplet(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(v => finite(v) !== null)
    ? value as [number, number, number] : undefined;
}

/** Accept source-only reports, and never upgrade missing or legacy status to a clinical assessment. */
export function normalizeReportData(value: unknown): ReportData | null {
  if (!isRecord(value) || 'error' in value) return null;
  if (!('organ_volumes' in value || 'source_report' in value || 'comments' in value || 'impression' in value)) return null;
  const organ_volumes: Record<string, OrganData> = {};
  if (isRecord(value.organ_volumes)) {
    for (const [organ, metrics] of Object.entries(value.organ_volumes)) {
      if (!isRecord(metrics)) continue;
      organ_volumes[organ] = {
        volume: finite(metrics.volume), mean_hu: finite(metrics.mean_hu),
        status: 'not_assessed',
        centroid_mm: triplet(metrics.centroid_mm), dimensions: triplet(metrics.dimensions),
      };
    }
  }
  // Legacy narrative fields are preserved as reference evidence, never exposed
  // as this feature's generated clinical findings or impressions.
  const legacyFindings = text(value.comments);
  const legacyImpression = strings(value.impression);
  const source = isRecord(value.source_report) ? value.source_report : {
    available: Boolean(legacyFindings || legacyImpression.length),
    source: '', text: '', findings: legacyFindings,
    impression: legacyImpression, reviewed_by_clinician: false, load_failed: false,
  };
  const provenance = isRecord(value.provenance) ? value.provenance : null;
  const patient = isRecord(value.patient) ? value.patient : {};
  return {
    case_id: text(value.case_id), report_schema_version: text(value.report_schema_version),
    assessment_scope: { ...REPORT_ASSESSMENT_SCOPE, supported_outputs: ['segmentation_measurements'] },
    patient: { age: typeof patient.age === 'number' ? patient.age : text(patient.age), sex: text(patient.sex) },
    organ_volumes, masks_available: value.masks_available !== false,
    comments: '', impression: [],
    source_report: source ? {
      purpose: 'unverified_reference',
      load_failed: source.load_failed === true,
      available: source.available === true, source: text(source.source), text: text(source.text),
      findings: text(source.findings) || legacyFindings,
      impression: strings(source.impression).length ? strings(source.impression) : legacyImpression,
      reviewed_by_clinician: source.reviewed_by_clinician === true,
    } : undefined,
    provenance: provenance ? {
      report_source: text(provenance.report_source), measurements_source: text(provenance.measurements_source),
      image_review_performed: provenance.image_review_performed === true,
    } : undefined,
    coverage: {
      status: 'limited', measured_structures: Object.keys(organ_volumes).length,
      limitations: trustedCoverageLimitations(Object.keys(organ_volumes).length, source.load_failed === true),
    },
  };
}

export function labelize(organ: string): string {
  return organ.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Preserve original wording, including negation, unrecognized headings, and report preamble. */
export function getSourceReportText(data: ReportData): string {
  if (data.source_report?.text.trim()) return data.source_report.text;
  const findings = data.source_report?.findings || data.comments;
  const impressions = (data.source_report?.impression.length ? data.source_report.impression : data.impression)
    .filter(item => item.trim() && item.trim() !== 'No impression available for this case.');
  return [
    findings.trim() && findings.trim() !== 'Clinical comments unavailable.' ? `FINDINGS:\n${findings}` : '',
    impressions.length ? `IMPRESSION:\n${impressions.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function getCoverageLimitations(data: ReportData): string[] {
  // Coverage prose in legacy/cached payloads may contain clinical conclusions.
  // Only these trusted messages and observed measurement availability are rendered.
  return trustedCoverageLimitations(Object.keys(data.organ_volumes).length, data.source_report?.load_failed === true);
}

export function splitOrgans(data: ReportData | null): {
  all: [string, OrganData][]; flagged: [string, OrganData][]; unassessed: [string, OrganData][];
} {
  const all = Object.entries(data?.organ_volumes ?? {});
  // Legacy review flags were derived from thresholds/keywords, not a supported
  // disease assessment. They cannot become generated clinical findings.
  return { all, flagged: [], unassessed: all };
}

export function formatMeasurement(value: number | null | undefined, unit: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(1))} ${unit}` : 'Not available';
}
