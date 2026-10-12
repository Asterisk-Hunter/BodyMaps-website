import { useState } from 'react';
import { getCoverageLimitations, getSourceReportText, REPORT_ASSESSMENT_SCOPE } from '../../helpers/reportFindings';
import type { ReportData } from '../../helpers/reportFindings';

export default function SourceReportDetails({ data, dark = false }: { data: ReportData; dark?: boolean }) {
  const sourceText = getSourceReportText(data);
  const source = data.source_report?.source || data.provenance?.report_source || 'Source not recorded';
  const [expandedReference, setExpandedReference] = useState<ReportData | null>(null);
  const referenceOpen = expandedReference === data;
  return (
    <section aria-label="Auto-report capability scope and source reference" style={{ textAlign: 'left', fontSize: 14, lineHeight: 1.6, color: dark ? 'rgba(255,255,255,0.84)' : '#26344d' }}>
      <h2 style={{ fontSize: 21, margin: '20px 0 8px' }}>What this auto-report can assess</h2>
      <p style={{ margin: '0 0 8px', fontWeight: 700 }}>Supported output: segmentation measurements</p>
      <p style={{ margin: '0 0 8px' }}>Disease assessment: not supported. Disease status: not assessed.</p>
      <p style={{ margin: '0 0 12px' }}>{REPORT_ASSESSMENT_SCOPE.explanation}</p>
      <p style={{ margin: '0 0 14px', fontWeight: 650 }}>The absence of an automated finding is not a negative disease result, including for stomach cancer.</p>
      <h3 style={{ margin: '18px 0 6px', fontSize: 15 }}>Measurement coverage</h3>
      <p style={{ margin: '0 0 8px' }}>
        Measurement source: {data.provenance?.measurements_source || 'Not recorded'}.
        {data.provenance?.image_review_performed !== true && ' This summary has not performed a diagnostic image review.'}
      </p>
      <ul style={{ paddingLeft: 20, margin: '8px 0 18px' }}>
        {getCoverageLimitations(data).map(limitation => <li key={limitation}>{limitation}</li>)}
      </ul>
      {sourceText ? (
        <details open={referenceOpen} style={{ borderTop: `1px solid ${dark ? 'rgba(255,255,255,0.16)' : '#d9e0eb'}`, paddingTop: 14, marginBottom: 18 }}>
          <summary onClick={event => { event.preventDefault(); setExpandedReference(referenceOpen ? null : data); }} style={{ cursor: 'pointer', fontSize: 16, fontWeight: 700 }}>
            Unverified source reference
          </summary>
          {referenceOpen && <div style={{ marginTop: 12 }}>
            <p style={{ margin: '0 0 8px' }}>Stored reference text only. Statements below are not findings or conclusions of this auto-report feature and do not expand its supported capabilities.</p>
            <p style={{ margin: '0 0 8px' }}>Source: {source}</p>
            <p style={{ margin: '0 0 14px' }}>
              {/radgpt/i.test(source) ? 'Stored AI-generated report. ' : ''}
              This auto-report feature has not independently verified this reference.
              {data.source_report?.reviewed_by_clinician === true
                ? ' Source metadata records clinician review.'
                : ' Clinician review of the reference is not documented.'}
            </p>
            <div data-testid="source-report-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 16, borderRadius: 12, border: `1px solid ${dark ? 'rgba(255,255,255,0.16)' : '#d9e0eb'}`, background: dark ? 'rgba(255,255,255,0.04)' : '#f5f7fb' }}>{sourceText}</div>
          </div>}
        </details>
      ) : <p>Source reference text is unavailable. Its absence does not establish a negative disease result.</p>}
    </section>
  );
}
