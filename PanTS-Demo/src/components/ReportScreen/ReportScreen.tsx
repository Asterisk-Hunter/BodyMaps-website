import { IconShare } from '@tabler/icons-react';
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { APP_CONSTANTS } from '../../helpers/constants';
import { prefersReducedMotion } from '../../helpers/motion';
import { reportIfSessionEnded } from '../../education/sessionEnded';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { appRootRelativeUrl } from '../../liveRooms/protocol';
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
  /** A reading session is recording; its REC pill sits outside this dialog. */
  recording?: boolean;
};


type Lang = 'patient' | 'clinical';
type Step = number;

const REPORT_CACHE_TTL_MS = 60_000;
// A request that hangs (a stalled proxy, or dataset storage that has not been declared
// down yet) ends here as "Report unavailable." with Try again instead of an endless spinner.
const REPORT_DATA_TIMEOUT_MS = 30_000;
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
  const loaded = fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-report-data/${encodeURIComponent(id)}`, { cache: 'no-store' })
    .then(async response => {
      if (response.ok) return normalizeReportData(await response.json());
      // An ended sign-in is not a missing report: the account context signs the page out
      // and asks for a sign-in. The request still settles as unavailable.
      await reportIfSessionEnded(response);
      return null;
    })
    .then(report => {
      if (report) cache.set(key, { data: report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
      return report;
    })
    .catch(() => null);
  // The deadline settles the request as unavailable; an answer that still arrives later
  // fills the cache, so Try again can use it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), REPORT_DATA_TIMEOUT_MS); });
  const request = Promise.race([loaded, deadline])
    .finally(() => {
      clearTimeout(timer);
      reportDataRequests.delete(key);
    });
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

.rs-link { display: inline-flex; align-items: center; min-height: 32px; }
/* Hover only where a pointer can hover, so a tap on a touch screen does not
   leave the button lit. The toggle's chosen half keeps its inline fill: only
   the unpressed half takes the hover fill, or the dark label would sit on it. */
@media (hover: hover) {
  .rs-primary:hover { transform: translateY(-1px); background: rgba(255,255,255,0.16)!important; border-color: rgba(255,255,255,0.24)!important; }
  .rs-primary-amber:hover { transform: translateY(-1px); background: rgba(251,191,36,0.18)!important; border-color: rgba(251,191,36,0.34)!important; }
  .rs-secondary:hover { background: rgba(255,255,255,0.08)!important; color: rgba(255,255,255,0.9)!important; border-color: rgba(255,255,255,0.18)!important; }
  .rs-exit:hover { background: rgba(255,255,255,0.08)!important; border-color: rgba(255,255,255,0.28)!important; color: rgba(255,255,255,0.95)!important; }
  .rs-toggle[aria-pressed="false"]:hover { background: rgba(255,255,255,0.08)!important; }
  .rs-link:hover { color: rgba(255,255,255,0.9)!important; }
}
.rs-root button:focus-visible { outline: 2px solid rgba(255,255,255,0.92); outline-offset: 2px; }
.rs-root h1:focus { outline: none; }

/* Layout lives in classes, not inline styles, so the narrow-screen block
   below can override it. Desktop values match the old inline ones. */
/* --rs-head-h is the bar itself. --rs-bar-h is everything the panels and the
   stage must stay clear of: the bar plus, while a reading session records, the
   strip under it that holds the REC pill (--rs-rec-h, set on the page; the pill
   is placed there in ReadingSession.css). */
.rs-root { --rs-head-h: 76px; --rs-bar-h: calc(var(--rs-head-h) + var(--rs-rec-h, 0px)); }
.rs-topbar { position: fixed; top: 0; left: 0; right: 0; height: var(--rs-head-h); display: flex; align-items: center; padding: 0 28px; }
.rs-topbar-brand { display: flex; align-items: center; gap: 8px; min-width: 270px; }
.rs-topbar-title { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 9px; }
.rs-topbar-spacer { display: none; }
.rs-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; min-height: 44px; }
.rs-icon-btn { padding: 9px 13px; }
.rs-share-pop { position: absolute; top: calc(100% + 10px); right: 0; width: 340px; }
.rs-stage, .rs-story-slot { display: contents; }
.rs-story { position: fixed; left: 64px; top: calc(50% + var(--rs-bar-h) / 2); transform: translateY(-50%); width: 360px; max-height: calc(100vh - var(--rs-bar-h) - 74px); overflow-y: auto; }
.rs-evidence { position: fixed; right: 72px; top: calc(50% + var(--rs-bar-h) / 2); transform: translateY(-50%); }
/* --rs-coach-top and --rs-coach-right are measured off the top bar (see
   useCoachAnchor), so the card sits under the Patient/Doctor toggle. */
.rs-coach { position: fixed; right: var(--rs-coach-right, 112px); top: var(--rs-coach-top, calc(var(--rs-bar-h) + 18px)); flex-direction: column; }
.rs-coach-arrow { position: relative; height: 30px; pointer-events: none; }
.rs-coach-arrow svg { position: absolute; top: 0; left: var(--rs-coach-arrow-x, 40px); transform: translateX(-50%); display: block; }
.rs-coach-card { width: 330px; }
.rs-final { padding: 34px; }
/* The cover and final cards sit in a box that follows the visible viewport, so
   their cap uses dvh (100vh stays as the fallback). 100vh alone is taller than the
   screen while a phone browser bar shows and pushes the pinned buttons off it. The
   cover keeps its own, slightly taller cap. */
.rs-card-cap { max-height: calc(100vh - var(--rs-bar-h) - 74px); max-height: calc(100dvh - var(--rs-bar-h) - 74px); }
.rs-cover-cap { max-height: calc(100vh - var(--rs-bar-h) - 48px); max-height: calc(100dvh - var(--rs-bar-h) - 48px); }

/* Wide bar: the step pips hang under the centred title line instead of
   sitting in its column, so the title text is on the same line on the cover
   and on every step and does not jump when the pips arrive. */
@media (min-width: 980px) {
  .rs-topbar-pips { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 9px; }
}

/* The top bar's centred title collides with the Patient/Doctor toggle and
   the actions below about 980px, so from there down the bar wraps to two
   rows with the title on its own row. */
@media (max-width: 979px) {
  .rs-root { --rs-head-h: 104px; }
  .rs-topbar { flex-wrap: wrap; align-content: center; row-gap: 6px; padding: 8px 12px; }
  .rs-topbar-brand { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .rs-topbar-brand > span { white-space: nowrap; }
  .rs-case { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rs-topbar-actions { flex-shrink: 0; gap: 8px; }
  .rs-topbar-title { position: static; transform: none; order: 3; flex: 1 0 100%; }
  .rs-topbar-spacer { display: block; }
}

/* Below 900px the story (360px, 64px in) and evidence (up to 350px, 72px in)
   panels no longer fit side by side, and Share and Exit were pushed off the
   right edge, where a touch user had no other way out. Share and Exit keep
   only their icons, at one width so the link and the cross line up, and the
   panels stack in one scrolling column that ends with the findings timeline,
   so the timeline never covers the story's buttons. The story card is capped
   so the scan shows below it; its action row stays pinned to the card's
   bottom edge while the text scrolls (a sticky box measures from the card's
   content edge, so its bottom offset is the card's 24px padding, and its top
   fades so rows slide under it instead of being cut off by a hard edge). The
   card sits in a slot that is flex: none because a scrolling flex item may
   shrink to nothing, and with the evidence panel and timeline stacked under it
   the card would give up all the height and the column would never scroll.
   The slot is also a screen tall on every step that has a card, so anything
   stacked under it starts below the fold and the strip under the card stays
   free for the scan (see REPORT_STACKED_POSE); changing step scrolls back up.
   The empty part of the slot lets touches through to the scan. The column
   clips sideways so a panel's 24px slide-in can't open a horizontal scroll
   while it plays. The final card is a centred panel capped to the screen, and
   its action row reuses the story's pinned row, which keeps both buttons in
   view while the text scrolls. */
@media (max-width: 899px) {
  .rs-icon-btn { box-sizing: border-box; width: 38px; padding: 9px 0; justify-content: center; }
  .rs-btn-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .rs-share-pop { position: fixed; top: calc(var(--rs-bar-h) + 8px); left: 12px; right: 12px; width: auto; }
  .rs-stage { position: fixed; top: var(--rs-bar-h); left: 0; right: 0; bottom: 0; z-index: 10001; display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 24px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; pointer-events: none; }
  .rs-story-slot { display: block; flex: none; min-height: calc(100vh - var(--rs-bar-h) - 24px); }
  .rs-story, .rs-evidence { position: static; transform: none; width: auto; max-height: none; overflow: visible; }
  .rs-evidence > * { width: auto !important; }
  .rs-timeline, .rs-timeline > * { position: static !important; transform: none !important; }
  .rs-timeline { align-self: center; max-width: 100%; }
  .rs-timeline > * { max-width: 100% !important; }
  .rs-coach { left: 12px; right: 12px; top: calc(var(--rs-bar-h) + 12px); flex-direction: row; }
  .rs-coach-arrow { display: none; }
  .rs-coach-card { flex: 1 1 auto; width: auto; min-width: 0; }
  .rs-story { flex: none; max-height: 46vh; overflow-y: auto; background: rgba(12,14,18,0.92) !important; }
  .rs-story-actions { position: sticky; bottom: -24px; margin: 0 -24px -24px; padding: 24px; background: linear-gradient(to bottom, rgba(12,14,18,0), #0c0e12 24px); }
  .rs-final { padding: 24px; }
}

/* On a phone the actions take about 260px of the bar, so the brand would
   squeeze to a single letter; the title row below already says what this is.
   The cover has no Patient/Doctor toggle, so the actions are about 100px and
   the brand fits, which keeps the first row from sitting empty. */
@media (max-width: 479px) {
  .rs-topbar-brand { display: none; }
  .rs-topbar--cover .rs-topbar-brand { display: flex; }
}
`;

// The 3D pane is the report's backdrop, and each step moves it: blurred and
// pulled back on the cover, slid right beside the story panel, dimmed behind
// the final card, and eased back to rest on Exit. The viewer keeps its panes
// from ever animating with `.visualization-container .vp-pane { transition:
// none !important }` (0,2,0), which used to beat the report's plain `.render`
// rule (0,1,0) so every step snapped. This selector outranks it (0,4,0) and
// only matches while the report is open, so ordinary viewing still snaps.
export const REPORT_PANE_SELECTOR = '.VisualizationPage.report-open .visualization-container .render';
/** The widest viewport that stacks the story panel over the stage. */
const REPORT_NARROW_PX = 899;
/**
 * Where the scan goes once the story card is stacked over the stage: the pane
 * is centred in the whole viewport, so it moves down by half the card's
 * footprint (the 104px bar, the stage's 12px padding and the card's 46vh cap,
 * matching STYLES) and shrinks to sit in the strip that is left below it.
 * While a reading session records, the bar grows by the REC strip
 * (--rs-rec-h, set on the page), so the pane moves down by half of that too.
 */
const REPORT_STACKED_POSE = 'translateY(calc(58px + var(--rs-rec-h, 0px) / 2 + 23vh)) scale(0.75)';
/** How long the pane takes to ease between steps, and back to rest on Exit. */
export const REPORT_PANE_MS = 450;
const PANE_EASE = 'cubic-bezier(0.22,1,0.36,1)';

/**
 * The injected rule that poses the 3D pane for a step. Only filter and
 * transform move, the pose that makes room for the story panel beside the scan
 * gives way below 900px to one that moves the scan under the stacked card, and
 * visitors who ask for reduced motion get the pose without the travel (the
 * global rule in index.css loses to this selector's !important, so the
 * override lives here).
 */
export function reportPaneCss(step: number, totalSteps: number, closing: boolean): string {
  let filter = 'none';
  let transform = 'translateX(0)';
  let ms = REPORT_PANE_MS;
  if (closing) {
    transform = 'none';
  } else if (step === 0) {
    filter = 'blur(12px) brightness(0.40)';
    transform = 'scale(0.96)';
    ms = 550;
  } else if (step === 1) {
    transform = 'translateX(180px)';
  } else if (step === totalSteps - 1) {
    filter = 'blur(1.5px) brightness(0.55)';
    transform = 'scale(1.02)';
  }
  return (
    `${REPORT_PANE_SELECTOR} { filter: ${filter} !important; transform: ${transform} !important; ` +
    `transition: filter ${ms}ms ${PANE_EASE}, transform ${ms}ms ${PANE_EASE} !important; }\n` +
    // Below 900px the story panel stacks over the stage instead of sitting
    // beside it (see STYLES), so there is no room beside it to slide the scan
    // into and it would sit hidden behind the card. The last step has no
    // stacked card (its summary panel is centred), so it keeps its blur, dim
    // and scale as they are.
    (!closing && step > 0 && step < totalSteps - 1 ? `@media (max-width: ${REPORT_NARROW_PX}px) { ${REPORT_PANE_SELECTOR} { transform: ${REPORT_STACKED_POSE} !important; } }\n` : '') +
    `@media (prefers-reduced-motion: reduce) { ${REPORT_PANE_SELECTOR} { transition: none !important; } }`
  );
}

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
      type="button"
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
        transition: 'transform 0.22s cubic-bezier(0.22,1,0.36,1), background-color 0.22s ease, border-color 0.22s ease',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
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
        transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
      }}
    >
      {children}
    </button>
  );
}

// The stacked story card is capped at 46vh above a pinned action row, so how
// many rows fit depends on the phone's height; the toggle sits above the list
// there so it never ends up behind that row.
function useReportNarrow() {
  const query = `(max-width: ${REPORT_NARROW_PX}px)`;
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return narrow;
}

function OrganList({ organs, max = 5 }: { organs: [string, OrganData][]; max?: number }) {
  const [showAll, setShowAll] = useState(false);
  const narrow = useReportNarrow();
  const visible = showAll ? organs : organs.slice(0, max);
  const toggle = organs.length > max && (
    <button type="button" className="rs-link" onClick={() => setShowAll(value => !value)} aria-expanded={showAll} style={{ ...(narrow ? { marginBottom: 12 } : { marginTop: 12 }), color: '#bacfec', background: 'transparent', border: 0, cursor: 'pointer' }}>
      {showAll ? 'Show less' : `Show all ${organs.length} segmented structures`}
    </button>
  );
  return <>
    {narrow && toggle}
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
    {!narrow && toggle}
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

const COACH_CARD_W = 330;

/**
 * Where the Patient/Doctor coachmark sits: its card right-aligned to the
 * top bar's actions, just under the toggle, with the arrow's tip centred on
 * the toggle. The bar wraps and reflows across widths, so the toggle is
 * measured instead of guessed. Returns CSS variables for `.rs-coach`.
 */
function useCoachAnchor(
  open: boolean,
  toggleRef: React.RefObject<HTMLElement | null>,
  actionsRef: React.RefObject<HTMLElement | null>,
): React.CSSProperties {
  const [vars, setVars] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const toggle = toggleRef.current?.getBoundingClientRect();
      const actions = actionsRef.current?.getBoundingClientRect();
      if (!toggle || !actions || !toggle.width) return;
      const cardLeft = actions.right - COACH_CARD_W;
      const arrowX = Math.min(COACH_CARD_W - 24, Math.max(24, toggle.left + toggle.width / 2 - cardLeft));
      setVars({
        '--rs-coach-top': `${Math.round(toggle.bottom + 10)}px`,
        '--rs-coach-right': `${Math.round(window.innerWidth - actions.right)}px`,
        '--rs-coach-arrow-x': `${Math.round(arrowX)}px`,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, toggleRef, actionsRef]);
  return vars as React.CSSProperties;
}

const COPY_FAILED_NOTE = "Couldn't copy the link. Select it and copy it yourself.";
const SHARE_FAILED_NOTE = "Couldn't create a link. Try again.";

export default function ReportScreen({ id, onClose, onViewChange, onOrganHighlight, onClearHighlight, onHideOrgans, recording = false }: Props) {
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
  const [copyFailed, setCopyFailed] = useState(false);
  const shareLinkRef = useRef<HTMLInputElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const shareCopyBtnRef = useRef<HTMLButtonElement>(null);
  const shareRetryBtnRef = useRef<HTMLButtonElement>(null);
  // Set when a retry succeeds while Try again holds focus; see the effect below.
  const refocusCopyRef = useRef(false);
  const [shareFailed, setShareFailed] = useState(false);
  // Opaque share link, minted on demand (see mintShareLink below) —
  // this used to be a raw `${API_ORIGIN}/api/report/${id}` string built
  // straight from the real case id. That exposed the real id in the URL and
  // skipped the token system the rest of the app now uses for sharing.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const currentCaseRef = useRef(id);
  currentCaseRef.current = id;
  // Bumped by Try again on "Report unavailable." to ask for the report once more.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const failedCloseRef = useRef<HTMLButtonElement>(null);
  const loadingExitRef = useRef<HTMLButtonElement>(null);
  // Exit first eases the 3D pane back to rest, then unmounts. While closing,
  // only the pane rule stays mounted (the report chrome is already gone).
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const shownStepRef = useRef<Step>(0);
  const coachVars = useCoachAnchor(modePromptOpen && step > 0, toggleRef, actionsRef);

  // The report covers the viewer, so keyboard focus belongs inside it: it
  // moves in on open, Tab stays inside, and it returns to the Report button
  // on exit. Escape is handled below (it closes the innermost layer first).
  // Focus starts on the dialog itself: the loading overlay's Exit button is gone
  // by the time the report is ready, which would drop focus on <body>.
  // While a reading session records, its REC pill stays on screen above the
  // report (ReadingSession.css) but lives in the viewer toolbar, outside this
  // root. Its buttons join the Tab ring so Stop and the key image button are
  // reachable, and aria-modal is dropped below so the pill is not hidden from
  // assistive tech while the microphone is live.
  useDialogFocus(true, rootRef, {
    lockScroll: false,
    initialFocus: rootRef,
    extraRing: () => Array.from(document.querySelectorAll<HTMLElement>('.VisualizationPage.report-open .vp-rec button')),
  });

  const requestClose = useCallback(() => {
    if (closeTimerRef.current !== null) return;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, REPORT_PANE_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

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
  }, [id, loadAttempt]);

  // The loading screen's Exit button unmounts when the request fails, which
  // would leave focus on the dialog root with nothing announced. Move it to
  // the way out (its message is a role="alert").
  useEffect(() => {
    if (!closing && !loading && !data) failedCloseRef.current?.focus({ preventScroll: true });
  }, [closing, loading, data]);

  // Try again unmounts the focused button for the loading overlay: hand focus
  // to its Exit button so a keyboard reader keeps their place.
  useEffect(() => {
    if (loadAttempt > 0 && loading && !closing) loadingExitRef.current?.focus({ preventScroll: true });
  }, [loadAttempt, loading, closing]);

  // Reset any previously-minted link when the case changes, so a stale
  // token for a different case can never be shown/copied.
  useEffect(() => {
    setShareUrl(null);
    setShareFailed(false);
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
      if (!r.ok) {
        await reportIfSessionEnded(r);
        throw new Error(`Share token request failed with status ${r.status}`);
      }
      const j = await r.json();
      const token = typeof j.url === 'string' ? j.url.split('/').pop() : null;
      if (currentCaseRef.current !== id) return;
      if (!token) throw new Error('Share token response had no link');
      refocusCopyRef.current = !!shareRetryBtnRef.current && document.activeElement === shareRetryBtnRef.current;
      // Under the app's base path, so a deployment on a sub-path shares a link that opens.
      setShareUrl(`${window.location.origin}${appRootRelativeUrl(`/share/${token}`)}`);
      setShareFailed(false);
    } catch (e) {
      console.error('Failed to create share link:', e);
      if (currentCaseRef.current === id) setShareFailed(true);
    } finally {
      if (currentCaseRef.current === id) setShareLoading(false);
    }
  }, [id, shareUrl, shareLoading]);

  // A successful retry unmounts the focused Try again button, which would drop
  // focus to <body>. Hand it to the Copy button, which is now enabled.
  useEffect(() => {
    if (!shareUrl || !refocusCopyRef.current) return;
    refocusCopyRef.current = false;
    shareCopyBtnRef.current?.focus({ preventScroll: true });
  }, [shareUrl]);

  // A failed copy note belongs to one opening of the popover, so it is cleared on close.
  useEffect(() => {
    if (!shareOpen) setCopyFailed(false);
  }, [shareOpen]);

  // Closing the popover unmounts whatever inside it had focus, which drops focus
  // to <body>. When focus was inside, hand it back to the Share button.
  const closeShare = useCallback(() => {
    const inside = !!document.getElementById('rs-share-popover')?.contains(document.activeElement);
    setShareOpen(false);
    if (inside) shareBtnRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeShare(); };
    const onClick = () => closeShare();
    document.addEventListener('keydown', onKey);
    // Deferred so the same click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      clearTimeout(t);
    };
  }, [shareOpen, closeShare]);

  // Escape closes the topmost layer first: the Patient/Doctor coachmark if
  // open, else the share popover, else it exits the report. Registered on the
  // capture phase so it wins over the viewer's global shortcut listeners while
  // the report overlay is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (modePromptOpen) { setModePromptOpen(false); return; }
      if (shareOpen) { closeShare(); return; }
      requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modePromptOpen, shareOpen, requestClose, closeShare]);

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
      // No clipboard here (plain http, some in-app browsers): select the link so
      // the reader can copy it by hand.
      setCopyFailed(true);
      shareLinkRef.current?.focus();
      shareLinkRef.current?.select();
    }
  };

  const go = useCallback((s: Step) => {
    // Any step navigation dismisses the Patient/Doctor coachmark, so a reader
    // who moves on with a step button or a pip is never left under its veil.
    // Start walkthrough calls setModePromptOpen(true) AFTER go(1), so the
    // coachmark still opens there.
    setModePromptOpen(false);
    // Clicking the step already showing (its pip) changes nothing, so the
    // slide direction stays put too. Flipping it would replay the card's
    // entrance from the other side.
    if (s === step) return;
    setDir(s > step ? 'r' : 'l');
    setStep(s);
  }, [step]);

  const { all, flagged } = React.useMemo(() => splitOrgans(data), [data]);
  const demographics = data ? [data.patient.sex, data.patient.age === '' ? '' : `${data.patient.age}y`]
    .filter(value => value && !/^(unknown|n\/a)y?$/i.test(value)).join(' · ') : '';
  const totalSteps = 2 + flagged.length + 1;

  // The pips keep keyboard focus, so a step change from them is spoken here:
  // the heading a screen reader would otherwise only hear when a step button
  // moved focus to it.
  const [stepAnnouncement, setStepAnnouncement] = useState('');
  const announcedStepRef = useRef<Step>(0);
  useEffect(() => {
    if (announcedStepRef.current === step) return;
    announcedStepRef.current = step;
    const organ = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    setStepAnnouncement(
      step === 0 ? 'Report overview'
        : step === 1 ? 'Segmented structures'
        : organ ? `Review flag ${step - 1} of ${flagged.length}: ${labelize(organ)}`
        : 'Measurement summary',
    );
  }, [step, flagged]);

  const curOrganName = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
  const curOrganData = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
  const anim = dir === 'r' ? 'slideR' : 'slideL';

  // Below 900px the stage scrolls. A new step starts back at the top, so it
  // never opens with its story card and action row scrolled out of view. The
  // story card is its own scroller and survives across steps, so it is reset
  // the same way.
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
    if (storyRef.current) storyRef.current.scrollTop = 0;
  }, [step]);

  // Each step's card is a fresh node, so the button that was just pressed is
  // destroyed and focus drops to <body>. Put it on the new step's heading, so
  // the next Tab lands on that card's buttons and a screen reader reads the
  // new step. Focus that is somewhere else on purpose (a pip) stays where it is.
  useEffect(() => {
    if (shownStepRef.current === step) return;
    shownStepRef.current = step;
    // While the Patient / Doctor coachmark is up, focus goes to the toggle it points at (below).
    if (modePromptOpen) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    stepRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // The coachmark's question is read with the toggle button that takes focus
  // here, so a keyboard or screen-reader user lands on the control it describes.
  useEffect(() => {
    if (!modePromptOpen || step === 0) return;
    toggleRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [modePromptOpen, step]);

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

  // Each step's wrapper is keyed by step, so its slide-in replays on every
  // step change instead of the text swapping in place.
  const leftContent = React.useMemo(() => {
    if (!data) return null;
    const curOrganLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    const curDataLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
    if (step === 1) return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s ease both` }}>
        <h1 tabIndex={-1} style={{ color: '#fff', fontSize: 30 }}>Segmented structures</h1>
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
        <div className="rs-story-actions" style={{ display: 'flex', gap: 10, paddingTop: 24 }}>
          <SecondaryButton onClick={() => go(0)}>Report scope</SecondaryButton>
          <PrimaryButton onClick={() => go(flagged.length > 0 ? 2 : totalSteps - 1)}>{flagged.length > 0 ? 'Review flags' : 'Continue'}</PrimaryButton>
        </div>
      </div>
    );
    if (step >= 2 && step < 2 + flagged.length && curOrganLocal && curDataLocal) return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s ease both` }}>
        <h1 tabIndex={-1} style={{ color: '#fff', fontSize: 30 }}>{labelize(curOrganLocal)}</h1>
        <p style={{ color: 'rgba(255,255,255,0.76)', lineHeight: 1.5 }}>Recorded review flag {step - 1} of {flagged.length}. A flag is not a diagnosis. {getSourceReportText(data) ? 'The unverified source reference can be expanded below.' : 'No source reference text is available for this case.'}</p>
        <SourceReportDetails data={data} dark />
        <div className="rs-story-actions" style={{ display: 'flex', gap: 10, paddingTop: 24 }}>
          <SecondaryButton onClick={() => go(step - 1)}>Back</SecondaryButton>
          <PrimaryButton onClick={() => go(step + 1)}>{step < 1 + flagged.length ? 'Next flag' : 'Continue'}</PrimaryButton>
        </div>
      </div>
    );
    return <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s ease both` }}>
      <h1 tabIndex={-1} style={{ color: '#fff', fontSize: 32 }}>Measurement summary</h1>
      <SourceReportDetails data={data} dark />
      <p style={{ color: 'rgba(255,255,255,0.72)', lineHeight: 1.5 }}>A clinician must assess disease using the images and clinical context. This auto-report provides measurements only.</p>
      <div className="rs-story-actions" style={{ display: 'flex', gap: 10, paddingTop: 24 }}>
        <SecondaryButton onClick={() => go(step - 1)}>Back</SecondaryButton>
        <PrimaryButton onClick={() => go(0)}>Start over</PrimaryButton>
      </div>
    </div>;
  }, [step, data, anim, all, flagged, totalSteps, go, lang]);

  const paneCss = reportPaneCss(step, totalSteps, closing);

  return (
    <div
      ref={rootRef}
      className="rs-root"
      role="dialog"
      aria-modal={recording ? undefined : true}
      aria-label="CT scan report"
      style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none', outline: 'none' }}
    >
      <style>{STYLES}</style>
      <style>{paneCss}</style>
      <div role="status" aria-live="polite" className="sr-only">{stepAnnouncement}</div>

      {!closing && !loading && !data && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <p role="alert" style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14, margin: 0 }}>Report unavailable.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="rs-exit" onClick={() => setLoadAttempt(n => n + 1)} style={{ fontSize: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.78)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Try again</button>
            <button type="button" ref={failedCloseRef} className="rs-exit" onClick={requestClose} style={{ fontSize: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.24)', color: 'rgba(255,255,255,0.8)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Close</button>
          </div>
        </div>
      )}

      {!closing && loading && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            <div aria-hidden="true" style={{ position: 'relative', width: 48, height: 48 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.06)' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid transparent', borderTop: '1.5px solid rgba(255,255,255,0.55)', animation: 'spin 1s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 8, borderRadius: '50%', border: '1px solid transparent', borderTop: '1px solid rgba(255,255,255,0.2)', animation: 'spin 1.6s linear infinite reverse' }} />
            </div>
            <span role="status" style={{ fontSize: 12, color: 'rgba(255,255,255,0.62)', letterSpacing: '0.06em' }}>Preparing your report…</span>
            {/* The top bar only renders once the data is here, so a touch reader
                needs their own way out of a slow request. */}
            <button type="button" ref={loadingExitRef} className="rs-exit" onClick={requestClose} style={{ fontSize: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.78)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Exit</button>
          </div>
        </div>
      )}

      {!closing && !loading && data && (
        <>
          {/* soft stage lighting behind the scan */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none', background: 'radial-gradient(circle at 52% 50%, rgba(255,255,255,0.055), transparent 34%)' }} />

          {/* Top bar. It sits above the stage, which shares the panels' layer
              and below 900px covers the screen under the bar, so the share
              popover that drops out of the bar is never drawn under it. */}
          <div className={`rs-topbar${step === 0 ? ' rs-topbar--cover' : ''}`} style={{ zIndex: modePromptOpen ? 10006 : 10002, pointerEvents: 'auto', background: 'rgba(6,8,12,0.88)', backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)', borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
            <div className="rs-topbar-brand">
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 760 }}>BodyMaps</span>
              <span aria-hidden="true" style={{ color: 'rgba(255,255,255,0.16)', fontSize: 11 }}>·</span>
              <span className="rs-case" style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>Case {id}{demographics ? ` · ${demographics}` : ''}</span>
            </div>

            <div className="rs-topbar-title">
              <span style={{ fontSize: 15, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.025em', fontWeight: 720 }}>
                {step === 0 ? 'Automated measurements' : 'Report and segmentation'}
              </span>
              {step === 0 ? (
                // The cover has no steps, but the row is kept at the height the
                // pips take so the title and buttons stay put when step 1 arrives.
                // Only the wrapped bar below 980px needs it; the centred title
                // would sit off the buttons' midline with it.
                <div className="rs-topbar-spacer" aria-hidden="true" style={{ height: 14 }} />
              ) : (
                // Fixed-size pips: the bar inside scales with transform instead
                // of animating width, so moving between steps never relayouts.
                // The 32px-tall buttons are pulled back by their margin so the
                // row keeps the height of the 14px it used to be.
                <div role="group" aria-label="Report steps" className="rs-topbar-pips" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {Array.from({ length: totalSteps - 1 }).map((_, i) => {
                    const progressIndex = i + 1;
                    const current = progressIndex === step;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => go(progressIndex)}
                        aria-label={`Step ${progressIndex} of ${totalSteps - 1}`}
                        aria-current={current ? 'step' : undefined}
                        style={{ width: 24, height: 32, margin: '-9px 0', border: 'none', cursor: 'pointer', padding: 0, background: 'transparent', display: 'flex', alignItems: 'center' }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'block',
                            width: '100%',
                            height: 3,
                            borderRadius: 999,
                            background: progressIndex <= step ? '#fbbf24' : 'rgba(255,255,255,0.18)',
                            opacity: progressIndex < step ? 0.42 : 1,
                            transform: current ? 'scaleX(1)' : 'scaleX(0.45)',
                            transition: 'transform 0.35s cubic-bezier(0.22,1,0.36,1), opacity 0.35s ease',
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div ref={actionsRef} className="rs-topbar-actions">
              {step > 0 && (
                <div ref={toggleRef} role="group" aria-label="Explain the report for" style={{ display: 'flex', alignItems: 'center', padding: 3, borderRadius: 999, background: modePromptOpen ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.055)', border: modePromptOpen ? '1px solid rgba(255,255,255,0.32)' : '1px solid rgba(255,255,255,0.10)', boxShadow: modePromptOpen ? '0 0 0 6px rgba(255,255,255,0.06), 0 18px 60px rgba(0,0,0,0.42)' : 'none', transition: 'background-color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease' }}>
                  <button type="button" className="rs-toggle" aria-pressed={lang === 'patient'} aria-describedby={modePromptOpen ? 'rs-coach-text' : undefined} onClick={() => { setLang('patient'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'patient' ? '#08090b' : 'rgba(255,255,255,0.7)', background: lang === 'patient' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'background-color 0.2s ease, color 0.2s ease' }}>Patient</button>
                  <button type="button" className="rs-toggle" aria-pressed={lang === 'clinical'} aria-describedby={modePromptOpen ? 'rs-coach-text' : undefined} onClick={() => { setLang('clinical'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'clinical' ? '#08090b' : 'rgba(255,255,255,0.7)', background: lang === 'clinical' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'background-color 0.2s ease, color 0.2s ease' }}>Doctor</button>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <button
                  ref={shareBtnRef}
                  type="button"
                  className="rs-icon-btn"
                  onClick={() => { setModePromptOpen(false); setShareOpen((v) => !v); mintShareLink(); }}
                  aria-expanded={shareOpen}
                  aria-controls="rs-share-popover"
                  aria-label="Share report"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: shareOpen ? 'rgba(255,255,255,0.10)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: 'rgba(255,255,255,0.78)',
                    transition: 'background-color 0.2s ease',
                  }}
                >
                  <IconShare size={14} aria-hidden="true" />
                  <span className="rs-btn-label" style={{ fontSize: 11, letterSpacing: '0.04em' }}>Share report</span>
                </button>

                {shareOpen && (
                  <div
                    id="rs-share-popover"
                    className="rs-share-pop"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                    zIndex: 20000,
                    background: '#141518', border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 14, padding: 16, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.86)', lineHeight: 1.5, marginBottom: 12 }}>
                      This link opens the segmentation summary.
                      {getSourceReportText(data) && ' Anyone with the link can expand and read its unverified source reference.'}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {/* A read-only field, so the link can be selected and copied by hand
                          when the clipboard is refused. */}
                      <input
                        ref={shareLinkRef}
                        type="text"
                        readOnly
                        aria-label="Share link"
                        value={shareLoading ? 'Generating link…' : (shareUrl || 'Link unavailable')}
                        onFocus={(e) => e.currentTarget.select()}
                        style={{
                          flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: 10, padding: '8px 10px', fontSize: 12, fontFamily: 'inherit', color: 'rgba(255,255,255,0.65)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      />
                      <button
                        ref={shareCopyBtnRef}
                        type="button"
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
                          transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                      <span className="sr-only" role="status">{copied ? 'Link copied' : copyFailed ? COPY_FAILED_NOTE : shareFailed && !shareLoading ? SHARE_FAILED_NOTE : ''}</span>
                    </div>
                    {/* The retry row stays mounted while a retry runs, so the focused Try again button keeps focus. */}
                    {shareFailed && !shareUrl && (
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, lineHeight: 1.45, color: 'rgba(251,191,36,0.92)' }}>
                        <span aria-hidden="true">{shareLoading ? 'Generating link…' : "Couldn't create a link."}</span>
                        <button
                          ref={shareRetryBtnRef}
                          type="button"
                          onClick={mintShareLink}
                          aria-disabled={shareLoading || undefined}
                          style={{ flexShrink: 0, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 10, padding: '6px 10px', cursor: shareLoading ? 'progress' : 'pointer', opacity: shareLoading ? 0.6 : 1, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.86)' }}
                        >
                          Try again
                        </button>
                      </div>
                    )}
                    {copyFailed && (
                      <div aria-hidden="true" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45, color: 'rgba(251,191,36,0.92)' }}>
                        {COPY_FAILED_NOTE}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button type="button" className="rs-icon-btn rs-exit" aria-label="Exit" onClick={requestClose} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'rgba(255,255,255,0.78)', transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease' }}>
                <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>✕</span>
                <span className="rs-btn-label" style={{ fontSize: 11, letterSpacing: '0.04em' }}>Exit</span>
              </button>
            </div>
          </div>

          {/* Intro: cinematic centered card */}
          {step === 0 && (
            <div style={{
              position: 'fixed',
              inset: 'var(--rs-bar-h) 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}>
              <div ref={stepRef} className="rs-cover-cap" style={{
                ...glass,
                pointerEvents: 'auto',
                width: 560,
                maxWidth: 'calc(100vw - 48px)',
                padding: '28px 32px',
                overflowY: 'auto',
                textAlign: 'center',
                animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`,
              }}>
                <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.42)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>Report overview</div>
                <h1 tabIndex={-1} style={{ fontSize: 48, lineHeight: 1.02, letterSpacing: '-0.065em', color: '#fff', margin: '0 0 18px', fontWeight: 860 }}>
                  Segmentation measurements
                </h1>
                <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.70)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430 }}>
                  Review the supported measurements and their limits. {getSourceReportText(data) ? 'Stored source text is available separately as an unverified reference.' : 'No source reference text is available for this case.'}
                </p>
                <SourceReportDetails data={data} dark />
                <button
                  type="button"
                  className="rs-primary"
                  onClick={() => { go(1); setModePromptOpen(true); }}
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
                    transition: 'transform 0.22s cubic-bezier(0.22,1,0.36,1), background-color 0.22s ease, border-color 0.22s ease',
                  }}
                >
                  Start walkthrough <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          )}


          {/* Coachmark: after Start walkthrough, point users to the existing Patient / Doctor toggle */}
          {modePromptOpen && step > 0 && (
            <>
              {/* Clicking the veil dismisses the coachmark (the current view
                  stays as-is; the toggle in the top bar remains available). */}
              <div aria-hidden="true" onClick={() => setModePromptOpen(false)} style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10004,
                pointerEvents: 'auto',
                cursor: 'pointer',
                background: 'rgba(0,0,0,0.48)',
                backdropFilter: 'blur(18px)',
                WebkitBackdropFilter: 'blur(18px)',
                animation: 'riseIn 0.24s ease both',
              }} />

              <div className="rs-coach" style={{
                ...coachVars,
                zIndex: 10007,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'stretch',
                gap: 14,
                animation: 'riseIn 0.26s ease both',
              }}>
                {/* Ends just under the toggle: the card's placement is measured off it. */}
                <div className="rs-coach-arrow" aria-hidden="true">
                  <svg width="24" height="30" viewBox="0 0 24 30" fill="none" stroke="rgba(255,255,255,0.78)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 29V4M5 11l7-7 7 7" />
                  </svg>
                </div>

                <div id="rs-coach-text" className="rs-coach-card" style={{
                  ...glass,
                  padding: '22px 24px',
                  boxShadow: '0 26px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}>
                  <div style={{
                    fontSize: 12,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.62)',
                    fontWeight: 820,
                    marginBottom: 10,
                  }}>
                    Choose your view
                  </div>
                  <div style={{
                    fontSize: 27,
                    lineHeight: 1.06,
                    letterSpacing: '-0.02em',
                    color: '#fff',
                    fontWeight: 700,
                    textWrap: 'balance',
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


          {/* Story panel on the left, evidence panel on the right. On narrow
              screens the stage stacks them in one column (see STYLES). */}
          <div ref={stageRef} className="rs-stage">
            {step > 0 && step < totalSteps - 1 && (
              <div className="rs-story-slot">
                <div ref={storyRef} className="rs-scroll rs-story" style={{ ...glass, zIndex: 10001, pointerEvents: 'auto', padding: 24 }}>
                  {leftContent}
                </div>
              </div>
            )}

            {step > 1 && step < totalSteps - 1 && (
              <div className="rs-evidence" style={{ zIndex: 10001, pointerEvents: 'auto' }}>
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
              <div className="rs-timeline" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
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
          </div>

          {/* FINAL centered summary panel */}
          {step === totalSteps - 1 && (
            <div style={{
              position: 'fixed',
              inset: 'var(--rs-bar-h) 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}>
              <div className="rs-scroll rs-final rs-card-cap" style={{ ...glass, pointerEvents: 'auto', width: 560, maxWidth: 'calc(100vw - 48px)', overflowY: 'auto' }}>
                {leftContent}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
