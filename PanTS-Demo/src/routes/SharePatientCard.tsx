import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { APP_CONSTANTS } from '../helpers/constants';
import type { ReportData } from '../helpers/reportFindings';
import { formatMeasurement, getSourceReportText, labelize, normalizeReportData, splitOrgans } from '../helpers/reportFindings';
import SourceReportDetails from '../components/ReportScreen/SourceReportDetails';
import { reportIfSessionEnded } from '../education/sessionEnded';

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

// A server error or outage (a 5xx, a request that never reached the server, or a
// broken answer) is worth another try; any other refusal means the link itself is dead.
class SummaryUnreachableError extends Error {}

export default function SharePatientCard() {
  const { shareId = '' } = useParams<{ shareId: string }>();
  const [requestState, setRequestState] = useState<{ shareId: string; data: ReportData | null; error: false | 'dead' | 'unreachable' } | null>(null);
  const data = requestState?.shareId === shareId ? requestState.data : null;
  const error = requestState?.shareId === shareId ? requestState.error : false;
  const [attempt, setAttempt] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    setRequestState(null);
    setRevealed(false);
    setCopied(false);
    setCopyFailed(false);
    fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${encodeURIComponent(shareId)}`, { cache: 'no-store' })
      .catch(() => { throw new SummaryUnreachableError('The request did not reach the server'); })
      .then(async r => {
        if (r.status >= 500) throw new SummaryUnreachableError(`Server error ${r.status}`);
        // An ended sign-in says nothing about the link: it is reported (the page is signed
        // out and asks for a sign-in), and the card offers a retry instead of a dead link.
        if (await reportIfSessionEnded(r)) throw new SummaryUnreachableError('The sign-in has ended');
        if (!r.ok) throw new Error('Report unavailable');
        return r.json().catch(() => { throw new SummaryUnreachableError('The answer could not be read'); });
      })
      .then(j => {
        if (cancelled) return;
        const report = normalizeReportData(j);
        setRequestState({ shareId, data: report, error: report ? false : 'dead' });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRequestState({ shareId, data: null, error: e instanceof SummaryUnreachableError ? 'unreachable' : 'dead' });
      });
    return () => { cancelled = true; };
  }, [shareId, attempt]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setRevealed(true), 30);
    return () => clearTimeout(t);
  }, [data]);

  const { all } = useMemo(() => splitOrgans(data), [data]);

  const handleShare = async () => {
    const url = window.location.href;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      return;
    } catch { /* clipboard unavailable, try the share sheet next */ }
    // In-app browsers and non-secure pages have no clipboard but often a share sheet.
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return; // the visitor closed the sheet
      }
    }
    setCopyFailed(true);
  };

  // Try again unmounts its own button while the summary reloads, so focus is moved
  // to the page's main landmark first instead of dropping to <body>.
  const retry = () => {
    mainRef.current?.focus({ preventScroll: true });
    setAttempt(n => n + 1);
  };

  const bodyMapsUrl = 'https://bodymaps.wse.jhu.edu';

  return (
    <div style={page}>
      <style>{STYLES}</style>

      <main ref={mainRef} tabIndex={-1} style={{ ...stage, outline: 'none' }}>
        {!data && !error && (
          <div style={loadingWrap} role="status">
            <div style={spinnerRing} aria-hidden="true" />
            <span className="sr-only">Loading the shared summary…</span>
          </div>
        )}

        {error === 'dead' && (
          <div style={emptyState} role="alert"><div style={emptyStateTitle}>This report link isn't available.</div></div>
        )}

        {error === 'unreachable' && (
          <div style={emptyState} role="alert">
            <div style={emptyStateTitle}>We couldn't load this summary. Try again in a moment.</div>
            <button type="button" onClick={retry} style={retryBtn}>Try again</button>
          </div>
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
                <button type="button" className="spc-share" onClick={handleShare} style={shareInlineBtn}>
                  <span className="spc-share-icon" style={{ display: 'inline-flex' }} aria-hidden="true"><ShareIcon /></span>
                  {copied ? 'Link copied' : 'Share this BodyMap'}
                </button>
              </div>
              <p role="status" className={copyFailed ? undefined : 'sr-only'} style={copyFailed ? copyFailedNote : undefined}>
                {copied ? 'Link copied to the clipboard.' : copyFailed ? "Couldn't copy the link. Copy the address from your browser instead." : ''}
              </p>
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
      </main>
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
const retryBtn: React.CSSProperties = {
  marginTop: 14, padding: '9px 20px', borderRadius: 999, border: `1px solid ${HAIRLINE}`, background: '#fff',
  color: NAVY, fontSize: 13.5, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit',
};
const copyFailedNote: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: MUTED, textAlign: 'center', margin: '-6px 0 16px' };

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
