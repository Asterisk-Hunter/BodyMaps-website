import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { APP_CONSTANTS } from '../helpers/constants';
import type { ReportData } from '../helpers/reportFindings';
import { formatMeasurement, getSourceReportText, isLesionLabel, labelize, lesionFindings, normalizeReportData, splitOrgans, tumorName } from '../helpers/reportFindings';
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

const CARD_MAX = 560;

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

  const all = useMemo(() => splitOrgans(data).all.filter(([name]) => !isLesionLabel(name)), [data]);
  const lesions = useMemo(() => lesionFindings(data), [data]);
  // A few familiar organs lead; the full list folds away.
  const keyStructures = useMemo(() => {
    const preferred = ['liver', 'spleen', 'pancreas', 'kidney_left', 'kidney_right', 'stomach'];
    const picked = preferred.flatMap(name => all.filter(([organ]) => organ === name));
    return (picked.length ? picked : all).slice(0, 4);
  }, [all]);
  const [imageState, setImageState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  // A branded picture for social media. It carries no findings, measurements or case id:
  // only how many structures were mapped and where to try BodyMaps.
  const handleSaveImage = async () => {
    setImageState('saving');
    try {
      const blob = await renderSocialImage(all.length);
      const file = new File([blob], 'my-bodymap.png', { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: 'I explored my CT scan in 3D with BodyMaps' });
          setImageState('saved');
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') { setImageState('idle'); return; }
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'my-bodymap.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setImageState('saved');
    } catch {
      setImageState('failed');
    }
  };

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
            {/* Hero: the shareable part. Neutral and promotional: how much was mapped, not what it means. */}
            <div style={hero}>
              <a href={bodyMapsUrl} target="_blank" rel="noreferrer" style={{ ...brandLockup, ...stagger(revealed, 1) }}>
                <div style={brandMark}><BrandGlyph /></div>
                <div>
                  <div style={brandName}>BodyMaps</div>
                  <div style={brandSub}>Johns Hopkins University</div>
                </div>
              </a>
              <div style={heroRow}>
                <div style={{ flex: 1, minWidth: 0, ...stagger(revealed, 2) }}>
                  <div style={eyebrow}>MY BODYMAP</div>
                  <h1 style={heroTitle}>
                    {all.length > 0 ? <>{all.length} structures<br />mapped in 3D</> : 'My CT scan in 3D'}
                  </h1>
                  <p style={heroSub}>Measured from a CT scan with BodyMaps.</p>
                </div>
                <BodySilhouette style={{ ...silhouette, ...stagger(revealed, 3) }} />
              </div>
            </div>

            <div style={cardBody}>
              {lesions.length > 0 && <section aria-label="Lesions marked for review" style={{ ...lesionPanel, ...stagger(revealed, 4) }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={sectionTitle}>Marked for a doctor to review</h2>
                  <span style={reviewBadge}>NEEDS REVIEW</span>
                </div>
                <p style={smallNote}>BodyMaps marked {lesions.length === 1 ? 'an area' : 'areas'} as high risk for a tumor. This is not a diagnosis.</p>
                <div style={measureGrid}>
                  {lesions.map(f => (
                    <div key={f.mask} style={{ ...measureCard, background: '#fff', borderColor: '#EAD2A6' }}>
                      <div style={measureLabel}>High risk: {tumorName(f.organ)}</div>
                      <div style={measureValue}>{formatMeasurement(f.lesion.volume, 'cc')}</div>
                      <div style={measureSub}>{formatMeasurement(f.lesion.mean_hu, 'HU')} mean attenuation</div>
                    </div>
                  ))}
                </div>
              </section>}

              <section aria-label="Segmentation measurements" style={{ marginTop: 18, ...stagger(revealed, 5) }}>
                <h2 style={sectionTitle}>Key measurements</h2>
                {!all.length && <p style={smallNote}>Segmentation measurements are unavailable. {getSourceReportText(data) ? 'The unverified source reference can still be expanded below.' : 'No source reference text is available for this case.'}</p>}
                {all.length > 0 && <>
                  <div style={measureGrid}>
                    {keyStructures.map(([organ, metrics]) => (
                      <div key={organ} style={measureCard}>
                        <div style={measureLabel}>{labelize(organ)}</div>
                        <div style={measureValue}>{formatMeasurement(metrics.volume, 'cc')}</div>
                        <div style={measureSub}>{formatMeasurement(metrics.mean_hu, 'HU')}</div>
                      </div>
                    ))}
                  </div>
                  <p style={smallNote}>Clinical status is not assessed by these measurements.</p>
                  {all.length > keyStructures.length && <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: 'pointer', color: NAVY, fontSize: 13.5, fontWeight: 650 }}>All {all.length} structures</summary>
                    <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                      {all.map(([organ, metrics]) => <div key={organ} style={listRow}>
                        <span>{labelize(organ)}</span>
                        <span style={{ color: MUTED }}>{formatMeasurement(metrics.volume, 'cc')} · {formatMeasurement(metrics.mean_hu, 'HU')}</span>
                      </div>)}
                    </div>
                  </details>}
                </>}
              </section>

              <div style={stagger(revealed, 6)}><SourceReportDetails data={data} /></div>

              <div style={{ ...actionsRow, ...stagger(revealed, 7) }}>
                <button type="button" className="spc-share" onClick={handleShare} style={shareInlineBtn}>
                  <span className="spc-share-icon" style={{ display: 'inline-flex' }} aria-hidden="true"><ShareIcon /></span>
                  {copied ? 'Link copied' : 'Share this BodyMap'}
                </button>
                <button type="button" onClick={() => { void handleSaveImage(); }} style={secondaryBtn}>
                  {imageState === 'saving' ? 'Making image…' : 'Save image'}
                </button>
              </div>
              <p role="status" className={copyFailed || imageState === 'failed' ? undefined : 'sr-only'} style={copyFailed || imageState === 'failed' ? copyFailedNote : undefined}>
                {copied ? 'Link copied to the clipboard.'
                  : copyFailed ? "Couldn't copy the link. Copy the address from your browser instead."
                  : imageState === 'failed' ? "Couldn't make the image. Try again."
                  : imageState === 'saved' ? 'Image saved.' : ''}
              </p>
            </div>

            <a href={bodyMapsUrl} target="_blank" rel="noreferrer" className="spc-ad" style={{ ...adBar, ...stagger(revealed, 8) }}>
              <div style={adLeft}>
                <img src={JHU_SHIELD_SRC} alt="Johns Hopkins University" style={adShield} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                <div style={adDivider} />
                <div>
                  <div style={adTitle}>BodyMaps</div>
                  <div style={adUrl}>bodymaps.wse.jhu.edu</div>
                </div>
              </div>
              <span style={adCta}>Map your own scan →</span>
            </a>
          </div>
        )}
      </main>
    </div>
  );
}

function BrandGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.4" stroke="#fff" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" fill="#fff" /></svg>;
}

// An abstract, original torso outline with a few organ shapes; decorative only.
const SILHOUETTE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 200" fill="none">
  <circle cx="60" cy="24" r="16" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.55)" stroke-width="2"/>
  <path d="M30 52 Q60 40 90 52 L96 120 Q92 168 80 196 L40 196 Q28 168 24 120 Z" stroke="rgba(255,255,255,0.55)" stroke-width="2" fill="rgba(255,255,255,0.04)"/>
  <path d="M40 78 Q56 66 80 76 Q84 92 66 96 Q48 98 40 90 Z" fill="#E8A87C" opacity="0.9"/>
  <ellipse cx="84" cy="96" rx="7" ry="11" fill="#9B8CE0" opacity="0.9"/>
  <path d="M46 104 Q62 98 78 106 Q70 112 54 110 Z" fill="#F2C94C" opacity="0.95"/>
  <ellipse cx="42" cy="118" rx="6" ry="10" fill="#6FCF97" opacity="0.9"/>
  <ellipse cx="78" cy="118" rx="6" ry="10" fill="#6FCF97" opacity="0.9"/>
  <path d="M60 60 L60 190" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-dasharray="3 4"/>
</svg>`;

function BodySilhouette({ style }: { style?: React.CSSProperties }) {
  return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SILHOUETTE_SVG)}`} alt="" aria-hidden="true" style={style} />;
}

function socialImageSvg(structures: number): string {
  const headline = structures > 0 ? [`${structures} structures`, 'mapped in 3D'] : ['My CT scan', 'in 3D'];
  const inner = SILHOUETTE_SVG.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const font = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY_DEEP}"/><stop offset="1" stop-color="#2A4590"/></linearGradient></defs>
  <rect width="1080" height="1350" fill="url(#g)"/>
  <circle cx="900" cy="260" r="360" fill="rgba(255,255,255,0.04)"/>
  <g transform="translate(96 110)"><rect width="64" height="64" rx="16" fill="rgba(255,255,255,0.14)"/><circle cx="32" cy="32" r="22" stroke="#fff" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="8" fill="#fff"/></g>
  <text x="184" y="150" fill="#fff" font-family="${font}" font-size="44" font-weight="700">BodyMaps</text>
  <text x="184" y="190" fill="#AFC2E8" font-family="${font}" font-size="26">Johns Hopkins University</text>
  <text x="96" y="380" fill="#AFC2E8" font-family="${font}" font-size="30" font-weight="700" letter-spacing="6">MY BODYMAP</text>
  <text x="96" y="480" fill="#fff" font-family="${font}" font-size="92" font-weight="800">${headline[0]}</text>
  <text x="96" y="584" fill="#fff" font-family="${font}" font-size="92" font-weight="800">${headline[1]}</text>
  <g transform="translate(560 640) scale(3.1)" fill="none">${inner}</g>
  <text x="96" y="720" fill="#DCE6F7" font-family="${font}" font-size="36">I explored my CT scan</text>
  <text x="96" y="768" fill="#DCE6F7" font-family="${font}" font-size="36">in 3D with BodyMaps.</text>
  <rect x="96" y="1150" width="560" height="96" rx="48" fill="#fff"/>
  <text x="376" y="1211" fill="${NAVY}" font-family="${font}" font-size="34" font-weight="700" text-anchor="middle">bodymaps.wse.jhu.edu</text>
</svg>`;
}

function renderSocialImage(structures: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 1350;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('No canvas')); return; }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('No image'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Image failed'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(socialImageSvg(structures))}`;
  });
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
const cardBody: React.CSSProperties = { padding: '20px 26px 6px' };
const hero: React.CSSProperties = { padding: '22px 26px 24px', background: `linear-gradient(135deg, ${NAVY_DEEP} 0%, ${NAVY} 55%, #2A4590 100%)`, color: '#fff' };
const heroRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 };
const heroTitle: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 'clamp(25px, 7vw, 32px)', lineHeight: 1.12, fontWeight: 800, margin: '8px 0 8px', color: '#fff' };
const heroSub: React.CSSProperties = { fontSize: 13.5, color: '#C9D6EE', margin: 0 };
const silhouette: React.CSSProperties = { width: 'clamp(76px, 20vw, 104px)', height: 'auto', flexShrink: 0 };
const sectionTitle: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 17, fontWeight: 700, color: NAVY, margin: 0 };
const smallNote: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.5, color: MUTED, margin: '6px 0 0' };
const lesionPanel: React.CSSProperties = { padding: '16px 16px 14px', borderRadius: 14, background: '#FBF1E1', border: '1px solid #EAD2A6' };
const reviewBadge: React.CSSProperties = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: '#8A5507', background: '#fff', border: '1px solid #EAD2A6', borderRadius: 999, padding: '4px 10px' };
const measureGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8, marginTop: 10 };
const measureCard: React.CSSProperties = { padding: '12px 13px', borderRadius: 12, background: '#F7F9FC', border: `1px solid ${HAIRLINE}` };
const measureLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 750, color: SPIRIT_TEXT, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 };
const measureValue: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, color: '#141A26' };
const measureSub: React.CSSProperties = { fontSize: 11.5, color: MUTED, marginTop: 2 };
const listRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '6px 0', borderBottom: `1px solid ${HAIRLINE}` };
const secondaryBtn: React.CSSProperties = { padding: '12px 22px', borderRadius: 999, border: `1px solid ${HAIRLINE}`, background: '#fff', color: NAVY, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const adCta: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' };

const brandLockup: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 14 };
const brandMark: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const brandName: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 19, color: '#fff', lineHeight: 1.15 };
const brandSub: React.CSSProperties = { fontSize: 11, color: '#AFC2E8', fontWeight: 500 };

const eyebrow: React.CSSProperties = { fontSize: 11, fontWeight: 750, letterSpacing: '0.14em', color: '#AFC2E8' };

const actionsRow: React.CSSProperties = { display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 10, margin: '6px 0 16px' };
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
