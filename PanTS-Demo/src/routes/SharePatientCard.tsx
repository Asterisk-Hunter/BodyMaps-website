import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { APP_CONSTANTS } from '../helpers/constants';
import type { ReportData } from '../helpers/reportFindings';
import { formatMeasurement, getSourceReportText, labelize, normalizeReportData, splitOrgans } from '../helpers/reportFindings';
import SourceReportDetails from '../components/ReportScreen/SourceReportDetails';

const NAVY = '#14265C';
const NAVY_DEEP = '#0D1B47';
const SPIRIT_TEXT = '#3E6FB5';
const MUTED = '#5A6B85';
const HAIRLINE = '#E7EAF0';

// Save the JHU shield you provided into your repo at this exact path
// (e.g. PanTS-Demo/public/jhu-shield-white.png) — Vite serves anything in
// public/ from the site root, so this path resolves automatically once
// the file's there. If it's missing, the <img> just quietly hides itself.
const JHU_SHIELD_SRC = '/jhu-shield-white.png';

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Poppins:wght@600;700;800&display=swap');
@keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
@keyframes shareGlow { 0%,100% { box-shadow: 0 6px 20px rgba(20,38,92,0.28); } 50% { box-shadow: 0 8px 26px rgba(20,38,92,0.4); } }

.spc-share {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #14265C 0%, #1E3573 60%, #2A4590 100%);
  animation: shareGlow 2.8s ease-in-out infinite;
  transition: transform 0.28s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.28s ease;
}
.spc-share::before {
  content: '';
  position: absolute;
  top: 0; left: -60%;
  width: 40%; height: 100%;
  background: linear-gradient(120deg, transparent, rgba(255,255,255,0.4), transparent);
  transform: skewX(-20deg);
  transition: left 0.65s cubic-bezier(0.16,1,0.3,1);
}
.spc-share:hover {
  transform: translateY(-2px) scale(1.035);
  animation-play-state: paused;
  box-shadow: 0 12px 28px rgba(20,38,92,0.42);
}
.spc-share:hover::before { left: 140%; }
.spc-share:active { transform: translateY(0) scale(0.97); }
.spc-share .spc-share-icon { transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1); }
.spc-share:hover .spc-share-icon { transform: translateY(-2px) rotate(-8deg); }

.spc-chip { transition: background 0.2s, color 0.2s; cursor: pointer; }
.spc-ad:hover { background: ${NAVY_DEEP} !important; }
.spc-qr-wrap:hover { transform: scale(1.05); }
`;

const CARD_MAX = 640;

// Staggered entrance delay helper — each major section fades/rises in a
// beat after the previous one instead of everything appearing at once.
function stagger(revealed: boolean, index: number): React.CSSProperties {
  return revealed ? { animation: `fadeUp 0.45s cubic-bezier(0.16,1,0.3,1) ${index * 0.08}s both` } : { opacity: 0 };
}

export default function SharePatientCard() {
  const { shareId = '' } = useParams<{ shareId: string }>();
  const [requestState, setRequestState] = useState<{ shareId: string; data: ReportData | null; error: boolean } | null>(null);
  const data = requestState?.shareId === shareId ? requestState.data : null;
  const error = requestState?.shareId === shareId && requestState.error;
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRequestState(null);
    setRevealed(false);
    setCopied(false);
    fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${encodeURIComponent(shareId)}`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('Report unavailable'); return r.json(); })
      .then(j => {
        if (cancelled) return;
        const report = normalizeReportData(j);
        setRequestState({ shareId, data: report, error: !report });
      })
      .catch(() => { if (!cancelled) setRequestState({ shareId, data: null, error: true }); });
    return () => { cancelled = true; };
  }, [shareId]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setRevealed(true), 30);
    return () => clearTimeout(t);
  }, [data]);

  const { all } = useMemo(() => splitOrgans(data), [data]);

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const bodyMapsUrl = 'https://bodymaps.wse.jhu.edu';

  return (
    <div style={page}>
      <style>{STYLES}</style>

      <div style={stage}>
        {!data && !error && (
          <div style={loadingWrap}><div style={spinnerRing} /></div>
        )}

        {error && (
          <div style={emptyState}><div style={emptyStateTitle}>This report link isn't available.</div></div>
        )}

        {data && (
          <div style={{ ...card, ...stagger(revealed, 0) }}>
            <div style={cardBody}>
              {/* Identity */}
              <a href={bodyMapsUrl} target="_blank" rel="noreferrer" style={{ ...brandLockup, ...stagger(revealed, 1) }}>
                <div style={brandMark}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="8.4" stroke="#fff" strokeWidth="1.6" />
                    <circle cx="12" cy="12" r="3" fill="#fff" />
                  </svg>
                </div>
                <div>
                  <div style={brandName}>BodyMaps</div>
                  <div style={brandSub}>Johns Hopkins University</div>
                </div>
              </a>

              <div style={stagger(revealed, 2)}>
                <div style={eyebrow}>REPORT AND SEGMENTATION</div>
                <h1 style={{ fontSize: 28, color: NAVY }}>Segmentation measurement summary</h1>
                <SourceReportDetails data={data} />
              </div>
              <section aria-label="Segmentation measurements" style={{ marginTop: 22 }}>
                <h2 style={{ fontSize: 20, color: NAVY }}>Segmented structures</h2>
                <p style={{ color: MUTED, fontSize: 14 }}>Clinical status is not assessed by these measurements.</p>
                {!all.length && <p style={{ color: MUTED }}>Segmentation measurements are unavailable. {getSourceReportText(data) ? 'The unverified source reference can still be expanded above.' : 'No source reference text is available for this case.'}</p>}
                {all.length > 0 && <details>
                  <summary style={{ cursor: 'pointer', color: NAVY }}>{all.length} structure{all.length === 1 ? '' : 's'} with segmentation data</summary>
                  <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
                    {all.map(([organ, metrics]) => <div key={organ} style={{ padding: 12, border: `1px solid ${HAIRLINE}`, borderRadius: 10 }}>
                      <strong>{labelize(organ)}</strong>
                      <div style={{ fontSize: 13, color: MUTED, marginTop: 6 }}>Segmented volume: {formatMeasurement(metrics.volume, 'cc')}</div>
                      <div style={{ fontSize: 13, color: MUTED }}>Mean attenuation: {formatMeasurement(metrics.mean_hu, 'HU')}</div>
                    </div>)}
                  </div>
                </details>}
              </section>

              <div style={hairline} />

              <div style={{ ...actionsRow, ...stagger(revealed, 7) }}>
                <button className="spc-share" onClick={handleShare} style={shareInlineBtn}>
                  <span className="spc-share-icon" style={{ display: 'inline-flex' }}><ShareIcon /></span>
                  {copied ? 'Link copied' : 'Share this BodyMap'}
                </button>
              </div>
            </div>

            {/* Local branding; sharing the current URL uses the clipboard above. */}
            <a
              href={bodyMapsUrl}
              target="_blank"
              rel="noreferrer"
              className="spc-ad"
              style={{ ...adBar, ...stagger(revealed, 8) }}
            >
              <div style={adLeft}>
                <img
                  src={JHU_SHIELD_SRC}
                  alt="Johns Hopkins University"
                  style={adShield}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div style={adDivider} />
                <div>
                  <div style={adTitle}>BodyMaps</div>
                  <div style={adUrl}>bodymaps.wse.jhu.edu</div>
                </div>
              </div>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function ShareIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7 }}><path d="M12 3v13M8 7l4-4 4 4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 13v6a1 1 0 001 1h12a1 1 0 001-1v-6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ─── Style tokens ───────────────────────────────────────────────────────────

const page: React.CSSProperties = {
  minHeight: '100vh', width: '100%', background: '#FBFCFE',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '36px 20px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
};

const stage: React.CSSProperties = { width: '100%', maxWidth: CARD_MAX };

const loadingWrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: '80px 0' };
const spinnerRing: React.CSSProperties = { width: 22, height: 22, borderRadius: '50%', border: `2px solid ${HAIRLINE}`, borderTopColor: NAVY, animation: 'spin 0.8s linear infinite' };

const emptyState: React.CSSProperties = { textAlign: 'center', padding: '44px 24px', border: `1px solid ${HAIRLINE}`, borderRadius: 16, background: '#fff' };
const emptyStateTitle: React.CSSProperties = { fontSize: 14.5, fontWeight: 600, color: MUTED };

const card: React.CSSProperties = {
  background: '#ffffff', borderRadius: 18, border: `1px solid ${HAIRLINE}`,
  boxShadow: '0 12px 32px rgba(20,38,92,0.08)', overflow: 'hidden',
};
const cardBody: React.CSSProperties = { padding: '24px 26px 6px' };

const brandLockup: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 14 };
const brandMark: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, background: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const brandName: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 19, color: NAVY, lineHeight: 1.15 };
const brandSub: React.CSSProperties = { fontSize: 11, color: MUTED, fontWeight: 500 };

const eyebrow: React.CSSProperties = { fontSize: 10.5, fontWeight: 750, letterSpacing: '0.1em', color: SPIRIT_TEXT };
const hairline: React.CSSProperties = { height: 1, background: HAIRLINE, margin: '16px 0 12px' };

const actionsRow: React.CSSProperties = { display: 'flex', justifyContent: 'center', marginBottom: 16 };
const shareInlineBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '13px 28px', borderRadius: 999, border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 700, letterSpacing: '0.01em', cursor: 'pointer', fontFamily: 'inherit',
};

// Bigger, single "advertising" footer — replaces both the old small
// de-identified text block and the thin bottom bar with one prominent band.
const adBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '22px 28px', background: NAVY, textDecoration: 'none', transition: 'background 0.2s',
};
const adLeft: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16 };
const adShield: React.CSSProperties = { height: 40, width: 'auto' };
const adDivider: React.CSSProperties = { width: 1, height: 34, background: 'rgba(255,255,255,0.22)' };
const adTitle: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 700, color: '#fff' };
const adUrl: React.CSSProperties = { fontSize: 12, color: '#AFC2E8', marginTop: 2, fontWeight: 600 };
