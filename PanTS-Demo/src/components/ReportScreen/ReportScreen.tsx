import React, { useEffect, useState, useRef, useCallback } from 'react';
import { APP_CONSTANTS } from '../../helpers/constants';
import FindingsTimeline from './FindingsTimeline';
import SourceReportDetails from './SourceReportDetails';
import { formatMeasurement, getSourceReportText, labelize, normalizeReportData, splitOrgans } from '../../helpers/reportFindings';
import type { OrganData, ReportData } from '../../helpers/reportFindings';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  id: string;
  onClose: () => void;
  onViewChange: (view: 'axial' | 'sagittal' | 'coronal' | '3d') => void;
  onOrganHighlight?: (organName: string, centroidMm?: [number, number, number]) => void;
  onClearHighlight?: () => void;
  onHideOrgans?: (organNames: string[]) => void;
};


type Lang = 'patient' | 'clinical';
type Step = number;

const REPORT_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { data: ReportData; expiresAt: number }>();
const reportDataRequests = new Map<string, Promise<ReportData | null>>();

/** Short-lived memory cache; source changes are revalidated and failures can be retried. */
export function prefetchReportData(id: string): Promise<ReportData | null> {
  const key = `${APP_CONSTANTS.API_ORIGIN}:report-v3:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
  cache.delete(key);
  const inFlight = reportDataRequests.get(key);
  if (inFlight) return inFlight;
  const request = fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-report-data/${encodeURIComponent(id)}`, { cache: 'no-store' })
    .then(async response => response.ok ? normalizeReportData(await response.json()) : null)
    .then(report => {
      if (report) cache.set(key, { data: report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
      return report;
    })
    .catch(() => null)
    .finally(() => reportDataRequests.delete(key));
  reportDataRequests.set(key, request);
  return request;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
@keyframes spin { from{transform:rotate(0)}to{transform:rotate(360deg)} }
@keyframes slideR { from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)} }
@keyframes slideL { from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:translateX(0)} }
@keyframes riseIn { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)} }

.rs-scroll::-webkit-scrollbar { width: 6px; }
.rs-scroll::-webkit-scrollbar-track { background: transparent; }
.rs-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 999px; }

.rs-primary:hover { transform: translateY(-1px); background: rgba(255,255,255,0.16)!important; border-color: rgba(255,255,255,0.24)!important; }
.rs-primary-amber:hover { transform: translateY(-1px); background: rgba(251,191,36,0.18)!important; border-color: rgba(251,191,36,0.34)!important; }
.rs-secondary:hover { background: rgba(255,255,255,0.08)!important; color: rgba(255,255,255,0.9)!important; border-color: rgba(255,255,255,0.18)!important; }
.rs-exit:hover { background: rgba(239,68,68,0.10)!important; border-color: rgba(239,68,68,0.36)!important; color: rgba(248,113,113,0.95)!important; }
.rs-toggle:hover { background: rgba(255,255,255,0.08)!important; }
.rs-link:hover { color: rgba(255,255,255,0.9)!important; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const glass: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.024))',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 28,
  backdropFilter: 'blur(28px)',
  WebkitBackdropFilter: 'blur(28px)',
  boxShadow: '0 30px 90px rgba(0,0,0,0.36), inset 0 1px 0 rgba(255,255,255,0.07)',
};

function PrimaryButton({ children, onClick, amber = false }: { children: React.ReactNode; onClick: () => void; amber?: boolean }) {
  return (
    <button
      className={amber ? 'rs-primary-amber' : 'rs-primary'}
      onClick={onClick}
      style={{
        padding: '13px 22px',
        borderRadius: 999,
        border: amber ? '1px solid rgba(251,191,36,0.30)' : '1px solid rgba(255,255,255,0.16)',
        background: amber ? 'rgba(251,191,36,0.14)' : 'rgba(255,255,255,0.11)',
        color: amber ? '#fbbf24' : 'rgba(255,255,255,0.94)',
        fontSize: 15,
        fontWeight: 750,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.22s cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className="rs-secondary"
      onClick={onClick}
      style={{
        padding: '12px 18px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'transparent',
        color: 'rgba(255,255,255,0.62)',
        fontSize: 14,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.2s',
      }}
    >
      {children}
    </button>
  );
}

function OrganList({ organs, max = 5 }: { organs: [string, OrganData][]; max?: number }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? organs : organs.slice(0, max);
  return <>
    <div style={{ display: 'grid', gap: 8 }}>
      {visible.map(([organ, metrics]) => (
        <div key={organ} style={{ padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)' }}>
          <div style={{ color: '#fff', fontWeight: 650 }}>{labelize(organ)}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 5 }}>
            Segmented volume: {formatMeasurement(metrics.volume, 'cc')} | Mean attenuation: {formatMeasurement(metrics.mean_hu, 'HU')}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 5 }}>Clinical status: not assessed</div>
        </div>
      ))}
    </div>
    {organs.length > max && <button className="rs-link" onClick={() => setShowAll(value => !value)} style={{ marginTop: 12, color: '#bacfec', background: 'transparent', border: 0, cursor: 'pointer' }}>
      {showAll ? 'Show less' : `Show all ${organs.length} segmented structures`}
    </button>}
  </>;
}

function EvidencePanel({ curOrgan, curData, data, anim, lang }: {
  curOrgan: string | null; curData: OrganData | null; data: ReportData; anim: string; lang: Lang;
}) {
  if (!curOrgan || !curData) return null;
  return <div style={{ ...glass, width: 330, padding: 24, color: '#fff', animation: `${anim} 0.36s ease both` }}>
    <h2 style={{ fontSize: 21, marginTop: 0 }}>{labelize(curOrgan)} measurements</h2>
    <p>Segmented volume: {formatMeasurement(curData.volume, 'cc')}</p>
    <p>Mean attenuation: {formatMeasurement(curData.mean_hu, 'HU')}</p>
    {lang === 'clinical' && curData.dimensions && <p>Segmented bounding box: {curData.dimensions.join(' x ')} cm</p>}
    <p style={{ fontSize: 13, lineHeight: 1.5 }}>Source: {data.provenance?.measurements_source || 'Not recorded'}. These values describe this segmentation label; they do not determine a diagnosis or lesion size.</p>
    <p style={{ fontSize: 13 }}>Lesion assessment: not provided by these measurements.</p>
  </div>;
}

export default function ReportScreen({ id, onClose, onViewChange, onOrganHighlight, onClearHighlight, onHideOrgans }: Props) {
  void onViewChange;
  const [requestState, setRequestState] = useState<{ id: string; data: ReportData | null; loading: boolean }>({ id, data: null, loading: true });
  const data = requestState.id === id ? requestState.data : null;
  const loading = requestState.id !== id || requestState.loading;
  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState<'r' | 'l'>('r');
  const [lang, setLang] = useState<Lang>('patient');
  const [modePromptOpen, setModePromptOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Opaque share link, minted on demand (see mintShareLink below) —
  // this used to be a raw `${API_ORIGIN}/api/report/${id}` string built
  // straight from the real case id. That exposed the real id in the URL and
  // skipped the token system the rest of the app now uses for sharing.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const currentCaseRef = useRef(id);
  currentCaseRef.current = id;

  useEffect(() => {
    let active = true;
    setRequestState({ id, data: null, loading: true });
    setStep(0);
    setModePromptOpen(false);
    setShareOpen(false);
    setShareLoading(false);
    setCopied(false);
    void prefetchReportData(id).then((report) => {
      if (!active) return;
      setRequestState({ id, data: report, loading: false });
    });
    return () => { active = false; };
  }, [id]);

  // Reset any previously-minted link when the case changes, so a stale
  // token for a different case can never be shown/copied.
  useEffect(() => {
    setShareUrl(null);
  }, [id]);

  // Mints (or re-derives — the backend token is deterministic per case id)
  // an opaque share token and builds the link to the source-report
  // /share/:token card. Safe to call repeatedly; no-ops if already minted
  // or in flight.
  const mintShareLink = useCallback(async () => {
    if (shareUrl || shareLoading) return;
    setShareLoading(true);
    try {
      const r = await fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${id}/token`, { method: 'POST' });
      const j = await r.json();
      const token = typeof j.url === 'string' ? j.url.split('/').pop() : null;
      if (currentCaseRef.current !== id) return;
      if (token) setShareUrl(`${window.location.origin}/share/${token}`);
    } catch (e) {
      console.error('Failed to create share link:', e);
    } finally {
      if (currentCaseRef.current === id) setShareLoading(false);
    }
  }, [id, shareUrl, shareLoading]);

  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShareOpen(false); };
    const onClick = () => setShareOpen(false);
    document.addEventListener('keydown', onKey);
    // Deferred so the same click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      clearTimeout(t);
    };
  }, [shareOpen]);

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };

  const go = useCallback((s: Step) => {
    setDir(s > step ? 'r' : 'l');
    setStep(s);
  }, [step]);

  const { all, flagged } = React.useMemo(() => splitOrgans(data), [data]);
  const demographics = data ? [data.patient.sex, data.patient.age === '' ? '' : `${data.patient.age}y`]
    .filter(value => value && !/^(unknown|n\/a)y?$/i.test(value)).join(' · ') : '';
  const totalSteps = 2 + flagged.length + 1;

  const curOrganName = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
  const curOrganData = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
  const anim = dir === 'r' ? 'slideR' : 'slideL';

  useEffect(() => {
    if (!data) return;
    onClearHighlight?.();
    if (step === 1) {
      onHideOrgans?.([]);
    } else if (step >= 2 && step < 2 + flagged.length) {
      const highlightName = curOrganName === 'pancreas' ? 'pancreas_body' : curOrganName;
      if (highlightName && curOrganData) onOrganHighlight?.(highlightName, curOrganData.centroid_mm);
    }
  }, [step, data]);

  const leftContent = React.useMemo(() => {
    if (!data) return null;
    const curOrganLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    const curDataLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
    if (step === 1) return (
      <div style={{ animation: `${anim} 0.38s ease both` }}>
        <h1 style={{ color: '#fff', fontSize: 30 }}>Segmented structures</h1>
        <p style={{ color: 'rgba(255,255,255,0.76)', lineHeight: 1.5 }}>
          {all.length} structure{all.length === 1 ? '' : 's'} {all.length === 1 ? 'has' : 'have'} segmentation data. Clinical status is not assessed by these measurements.
        </p>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 1.5 }}>
          {lang === 'patient'
            ? 'Volume describes the segmented region. HU is the CT attenuation scale. Your clinician interprets these numbers alongside the images and source report.'
            : `Measurement source: ${data.provenance?.measurements_source || 'Not recorded'}. Values describe individual segmentation labels; a subregion is not a whole-organ measurement.`}
        </p>
        {!all.length && <p style={{ color: '#fff' }}>Segmentation measurements are unavailable. {getSourceReportText(data) ? 'The unverified source reference can still be expanded in the report overview.' : 'No source reference text is available for this case.'}</p>}
        <OrganList organs={all} />
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <SecondaryButton onClick={() => go(0)}>Report scope</SecondaryButton>
          <PrimaryButton onClick={() => go(flagged.length > 0 ? 2 : totalSteps - 1)}>{flagged.length > 0 ? 'Review flags' : 'Continue'}</PrimaryButton>
        </div>
      </div>
    );
    if (step >= 2 && step < 2 + flagged.length && curOrganLocal && curDataLocal) return (
      <div style={{ animation: `${anim} 0.38s ease both` }}>
        <h1 style={{ color: '#fff', fontSize: 30 }}>{labelize(curOrganLocal)}</h1>
        <p style={{ color: 'rgba(255,255,255,0.76)', lineHeight: 1.5 }}>Recorded review flag {step - 1} of {flagged.length}. A flag is not a diagnosis. {getSourceReportText(data) ? 'The unverified source reference can be expanded below.' : 'No source reference text is available for this case.'}</p>
        <SourceReportDetails data={data} dark />
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <SecondaryButton onClick={() => go(step - 1)}>Back</SecondaryButton>
          <PrimaryButton onClick={() => go(step + 1)}>{step < 1 + flagged.length ? 'Next flag' : 'Continue'}</PrimaryButton>
        </div>
      </div>
    );
    return <div style={{ animation: `${anim} 0.38s ease both` }}>
      <h1 style={{ color: '#fff', fontSize: 32 }}>Measurement summary</h1>
      <SourceReportDetails data={data} dark />
      <p style={{ color: 'rgba(255,255,255,0.72)', lineHeight: 1.5 }}>A clinician must assess disease using the images and clinical context. This auto-report provides measurements only.</p>
      <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
        <SecondaryButton onClick={() => go(step - 1)}>Back</SecondaryButton>
        <PrimaryButton onClick={() => go(0)}>Start over</PrimaryButton>
      </div>
    </div>;
  }, [step, data, anim, all, flagged, totalSteps, go, lang]);

  if (!loading && !data) return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
      <style>{STYLES}</style>
      <style>{step === 0
        ? `.render { filter: blur(12px) brightness(0.40) !important; transform: scale(0.96) !important; transition: filter 0.55s cubic-bezier(0.22,1,0.36,1), transform 0.55s cubic-bezier(0.22,1,0.36,1) !important; }`
        : step === 1
          ? `.render { filter: none !important; transform: translateX(180px) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
          : step === totalSteps - 1
            ? `.render { filter: blur(1.5px) brightness(0.55) !important; transform: scale(1.02) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
            : `.render { filter: none !important; transform: translateX(0) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`}</style>
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, margin: 0 }}>Report unavailable.</p>
        <button onClick={onClose} style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)', borderRadius: 8, padding: '7px 20px', cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
      <style>{STYLES}</style>
      <style>{step === 0
        ? `.render { filter: blur(12px) brightness(0.40) !important; transform: scale(0.96) !important; transition: filter 0.55s cubic-bezier(0.22,1,0.36,1), transform 0.55s cubic-bezier(0.22,1,0.36,1) !important; }`
        : step === 1
          ? `.render { filter: none !important; transform: translateX(180px) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
          : step === totalSteps - 1
            ? `.render { filter: blur(1.5px) brightness(0.55) !important; transform: scale(1.02) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
            : `.render { filter: none !important; transform: translateX(0) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`}</style>

      {loading && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            <div style={{ position: 'relative', width: 48, height: 48 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.06)' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid transparent', borderTop: '1.5px solid rgba(255,255,255,0.55)', animation: 'spin 1s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 8, borderRadius: '50%', border: '1px solid transparent', borderTop: '1px solid rgba(255,255,255,0.2)', animation: 'spin 1.6s linear infinite reverse' }} />
            </div>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em' }}>Preparing your report…</span>
          </div>
        </div>
      )}

      {!loading && data && (
        <>
          {/* soft stage lighting behind the scan */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none', background: 'radial-gradient(circle at 52% 50%, rgba(255,255,255,0.055), transparent 34%)' }} />

          {/* Top bar */}
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 76, zIndex: modePromptOpen ? 10006 : 10001, pointerEvents: 'auto', background: 'rgba(6,8,12,0.88)', backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)', borderBottom: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', padding: '0 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 270 }}>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.36)', letterSpacing: '0.12em', fontWeight: 760 }}>BODYMAPS</span>
              <span style={{ color: 'rgba(255,255,255,0.16)', fontSize: 11 }}>·</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.52)' }}>Case {id}{demographics ? ` · ${demographics}` : ''}</span>
            </div>

            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 15, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.025em', fontWeight: 720 }}>
                {step === 0 ? 'Automated measurements' : 'Report and segmentation'}
              </span>
              {step > 0 && (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {Array.from({ length: totalSteps - 1 }).map((_, i) => {
                    const progressIndex = i + 1;
                    return (
                      <button key={i} onClick={() => go(progressIndex)} style={{ height: 3, width: progressIndex === step ? 30 : 9, border: 'none', cursor: 'pointer', padding: 0, borderRadius: 999, transition: 'all 0.35s cubic-bezier(0.22,1,0.36,1)', background: progressIndex === step ? '#fbbf24' : progressIndex < step ? 'rgba(251,191,36,0.42)' : 'rgba(255,255,255,0.18)' }} />
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              {step > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', padding: 3, borderRadius: 999, background: modePromptOpen ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.055)', border: modePromptOpen ? '1px solid rgba(255,255,255,0.32)' : '1px solid rgba(255,255,255,0.10)', boxShadow: modePromptOpen ? '0 0 0 6px rgba(255,255,255,0.06), 0 18px 60px rgba(0,0,0,0.42)' : 'none', transition: 'all 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
                  <button className="rs-toggle" onClick={() => { setLang('patient'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'patient' ? '#08090b' : 'rgba(255,255,255,0.58)', background: lang === 'patient' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'all 0.2s' }}>Patient</button>
                  <button className="rs-toggle" onClick={() => { setLang('clinical'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'clinical' ? '#08090b' : 'rgba(255,255,255,0.58)', background: lang === 'clinical' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'all 0.2s' }}>Doctor</button>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => { setShareOpen((v) => !v); mintShareLink(); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: shareOpen ? 'rgba(255,255,255,0.10)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 12,
                    padding: '9px 13px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: 'rgba(255,255,255,0.78)',
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1 }}>&#128279;</span>
                  <span style={{ fontSize: 11, letterSpacing: '0.04em' }}>Share report</span>
                </button>

                {shareOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                    position: 'absolute', top: 'calc(100% + 10px)', right: 0, zIndex: 20000,
                    width: 340, background: '#141518', border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 14, padding: 16, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.86)', lineHeight: 1.5, marginBottom: 12 }}>
                      This link opens the segmentation summary.
                      {getSourceReportText(data) && ' Anyone with the link can expand and read its unverified source reference.'}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{
                        flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 10, padding: '8px 10px', fontSize: 12, color: 'rgba(255,255,255,0.65)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {shareLoading ? 'Generating link…' : (shareUrl || 'Link unavailable')}
                      </div>
                      <button
                        onClick={handleCopyShareLink}
                        disabled={!shareUrl}
                        style={{
                          flexShrink: 0,
                          background: copied ? 'rgba(52,199,89,0.18)' : 'rgba(255,255,255,0.10)',
                          border: `1px solid ${copied ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.16)'}`,
                          borderRadius: 10, padding: '8px 12px', cursor: shareUrl ? 'pointer' : 'not-allowed',
                          opacity: shareUrl ? 1 : 0.5,
                          fontFamily: 'inherit',
                          fontSize: 12, fontWeight: 700, color: copied ? '#34c759' : 'rgba(255,255,255,0.86)',
                          transition: 'all 0.2s',
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button className="rs-exit" onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid rgba(239,68,68,0.24)', borderRadius: 12, padding: '9px 13px', cursor: 'pointer', fontFamily: 'inherit', color: 'rgba(239,68,68,0.78)', transition: 'all 0.2s' }}>
                <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>✕</span>
                <span style={{ fontSize: 11, letterSpacing: '0.04em' }}>Exit</span>
              </button>
            </div>
          </div>

          {/* Intro: cinematic centered card */}
          {step === 0 && (
            <div style={{
              position: 'fixed',
              inset: '76px 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}>
              <div style={{
                ...glass,
                pointerEvents: 'auto',
                width: 560,
                maxWidth: 'calc(100vw - 48px)',
                padding: '28px 32px',
                maxHeight: 'calc(100vh - 124px)',
                overflowY: 'auto',
                textAlign: 'center',
                animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`,
              }}>
                <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.42)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>Report overview</div>
                <h1 style={{ fontSize: 48, lineHeight: 1.02, letterSpacing: '-0.065em', color: '#fff', margin: '0 0 18px', fontWeight: 860 }}>
                  Segmentation measurements
                </h1>
                <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.70)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430 }}>
                  Review the supported measurements and their limits. {getSourceReportText(data) ? 'Stored source text is available separately as an unverified reference.' : 'No source reference text is available for this case.'}
                </p>
                <SourceReportDetails data={data} dark />
                <button
                  className="rs-primary"
                  onClick={() => { setModePromptOpen(true); go(1); }}
                  style={{
                    padding: '14px 26px',
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.16)',
                    background: 'rgba(255,255,255,0.11)',
                    color: 'rgba(255,255,255,0.94)',
                    fontSize: 15,
                    fontWeight: 760,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'all 0.22s cubic-bezier(0.22,1,0.36,1)',
                  }}
                >
                  Start walkthrough →
                </button>
              </div>
            </div>
          )}


          {/* Coachmark: after Start walkthrough, point users to the existing Patient / Doctor toggle */}
          {modePromptOpen && step > 0 && (
            <>
              <div style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10004,
                pointerEvents: 'none',
                background: 'rgba(0,0,0,0.48)',
                backdropFilter: 'blur(18px)',
                WebkitBackdropFilter: 'blur(18px)',
                animation: 'riseIn 0.24s ease both',
              }} />

              <div style={{
                position: 'fixed',
                right: 112,
                top: 94,
                zIndex: 10007,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                animation: 'riseIn 0.26s ease both',
              }}>
                <div style={{
                  width: 92,
                  height: 54,
                  borderTop: '2px solid rgba(255,255,255,0.78)',
                  borderRight: '2px solid rgba(255,255,255,0.78)',
                  borderTopRightRadius: 28,
                  transform: 'translateY(4px) rotate(-8deg)',
                  position: 'relative',
                }}>
                  <span style={{
                    position: 'absolute',
                    right: -6,
                    top: -7,
                    width: 12,
                    height: 12,
                    borderTop: '2px solid rgba(255,255,255,0.78)',
                    borderRight: '2px solid rgba(255,255,255,0.78)',
                    transform: 'rotate(45deg)',
                  }} />
                </div>

                <div style={{
                  ...glass,
                  width: 330,
                  padding: '22px 24px',
                  boxShadow: '0 26px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}>
                  <div style={{
                    fontSize: 12,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.44)',
                    fontWeight: 820,
                    marginBottom: 10,
                  }}>
                    Choose your view
                  </div>
                  <div style={{
                    fontSize: 27,
                    lineHeight: 1.06,
                    letterSpacing: '-0.045em',
                    color: '#fff',
                    fontWeight: 850,
                    marginBottom: 10,
                  }}>
                    Are you a patient or a doctor?
                  </div>
                  <p style={{
                    fontSize: 15,
                    lineHeight: 1.48,
                    color: 'rgba(255,255,255,0.64)',
                    margin: 0,
                  }}>
                    Select the role that fits you best. You can switch views anytime.
                  </p>
                </div>
              </div>
            </>
          )}


          {/* LEFT story panel */}
          {step > 0 && step < totalSteps - 1 && (
            <div className="rs-scroll" style={{ ...glass, position: 'fixed', left: 64, top: 'calc(50% + 38px)', transform: 'translateY(-50%)', zIndex: 10001, pointerEvents: 'auto', width: 360, maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 24 }}>
              {leftContent}
            </div>
          )}

          {/* FINAL centered impression panel */}
          {step === totalSteps - 1 && (
            <div style={{
              position: 'fixed',
              inset: '76px 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}>
              <div className="rs-scroll" style={{ ...glass, pointerEvents: 'auto', width: 560, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 34 }}>
                {leftContent}
              </div>
            </div>
          )}

          {/* RIGHT evidence panel */}
          {step > 1 && step < totalSteps - 1 && (
            <div style={{ position: 'fixed', right: 72, top: 'calc(50% + 38px)', transform: 'translateY(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
              <EvidencePanel
                curOrgan={curOrganName}
                curData={curOrganData}
                data={data}
                anim={anim}
                lang={lang}
              />
            </div>
          )}

          {step > 0 && step < totalSteps - 1 && (
            <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
              <FindingsTimeline
              organStatuses={flagged.map(([o]) => ({ organ: o, status: 'check' as const }))}
              comments={data.comments}
              focusedOrgan={curOrganName}
              onNodeTap={organ => {
                const fi = flagged.findIndex(([o]) => o === organ);
                go(fi >= 0 ? 2 + fi : 1);
              }}
            />
            </div>
          )}
        </>
      )}
    </div>
  );
}
