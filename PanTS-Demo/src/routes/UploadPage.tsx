import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// LesionSegmenter's four lesions, offered as a macOS-style submenu off the model
// item.
const activateOption = (event: React.KeyboardEvent<HTMLElement>) => {
  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    event.currentTarget.click();
  }
};

// The LesionSegmenter row only opens its lesion submenu, so from the keyboard Enter,
// Space or ArrowRight moves into that submenu, on the checked lesion or the first one.
const focusLesionChoice = (event: React.KeyboardEvent<HTMLElement>) => {
  if (event.target !== event.currentTarget || !["Enter", " ", "ArrowRight"].includes(event.key)) return;
  const items = event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
  const choice = Array.from(items).find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
  if (!choice) return;
  event.preventDefault();
  choice.focus();
};

// True when keyboard focus fell to the page (or onto a control that left it or was
// disabled), so moving it somewhere useful takes nothing away from anyone.
const keyboardFocusLost = () => {
  const active = document.activeElement as HTMLElement | null;
  return !active || active === document.body || !active.isConnected || active.matches(":disabled");
};

const LESION_OPTIONS: {
  id: "pancreatic" | "liver" | "kidney" | "colon";
  label: string;
}[] = [
  { id: "pancreatic", label: "Pancreatic lesion" },
  { id: "liver", label: "Liver lesion" },
  { id: "kidney", label: "Kidney lesion" },
  { id: "colon", label: "Colon lesion" },
];

// SuPreM, MedFormer, and R-Super are deliberately not offered here - the
// models themselves are untouched (backend dispatch, existing runs of them
// in Completed Uploads, etc. all still work), this just hides them from the
// picker.
//
// `details` backs the always-visible model info card next to the picker -
// kept short and concrete (what it actually segments, what it's for) rather
// than marketing language, and left off where nothing more specific than
// `desc` is known.
const MODEL_OPTIONS: {
  id: string;
  label: string;
  desc: string;
  details?: string[];
  // Headline numbers for the comparison grid - short "value / label" pairs in
  // the spirit of Apple's compare-page Quick Look rows. Every value here is a
  // fact already stated in `details` below, just pulled out and made
  // scannable rather than buried in prose.
  quickFacts?: { value: string; label: string }[];
}[] = [
  {
    id: "None",
    label: "None",
    desc: "View a scan without running inference.",
    quickFacts: [
      { value: "In your browser", label: "Where it runs" },
      { value: "None", label: "Inference" },
    ],
    details: [
      "Local scans stay in your browser. Sample scans open in the dataset viewer.",
      "No inference runs, so there's nothing to download or share afterward.",
    ],
  },
  {
    id: "ePAI",
    label: "ePAI",
    desc: "Full abdominal organ segmentation, with detailed pancreas and tumor analysis",
    quickFacts: [
      { value: "25", label: "Structures segmented" },
      { value: "3", label: "Pancreas tumor subtypes" },
      { value: "Abdominal", label: "Best for" },
    ],
    details: [
      "25 structures in one pass",
      "Major organs, vasculature, pancreas region",
      "Pancreas gland, duct, and 3 tumor subtypes (PDAC, cyst, PNET)",
      "Built for abdominal CT, not scans of the entire body",
    ],
  },
  {
    id: "Atlas-Net",
    label: "Atlas-Net",
    desc: "For anatomically consistent results, with the same organ and tumor coverage as ePAI",
    quickFacts: [
      { value: "25", label: "Structures segmented" },
      { value: "3", label: "Pancreas tumor subtypes" },
      { value: "Plausibility", label: "Optimized for" },
    ],
    details: [
      "25 structures in one pass, with the same coverage based on nnU-Net as ePAI",
      "Major organs, vasculature, pancreas region",
      "Pancreas gland, duct, and 3 tumor subtypes (PDAC, cyst, PNET)",
      "Matches segmentations to a known anatomical atlas",
    ],
  },
  {
    id: "LesionSegmenter",
    label: "LesionSegmenter",
    desc: "For fast pancreatic lesion detection",
    quickFacts: [
      { value: "4", label: "Organs covered" },
      { value: "Pancreatic", label: "Validated lesion type" },
      { value: "Fast", label: "Speed" },
    ],
    details: [
      "Lesions in 4 organs in one pass",
      "Pick which organ to feature as the primary result",
      "Pancreatic lesion detection validated against ground truth",
      "Optimized for speed over broader organ coverage",
    ],
  },
  {
    id: "SuPreM",
    label: "SuPreM",
    desc: "Open pre-trained U-Net for abdominal, pelvic and lung organ segmentation (organs only, no tumors)",
    quickFacts: [
      { value: "20", label: "Structures segmented" },
      { value: "Organs", label: "Output" },
      { value: "Free", label: "Plan" },
    ],
    details: [
      "20 structures in one pass: liver, spleen, kidneys, pancreas, stomach, gallbladder, adrenal glands, duodenum, colon, bladder and prostate",
      "Also the aorta, inferior vena cava, celiac artery, lungs and femurs",
      "Organs only: no tumor or lesion classes",
      "Included in every plan, including Free",
    ],
  },
];
import { useLocation, useNavigate } from "react-router-dom";
import "./UploadPage.css";

// Lazy so NiiVue / Cornerstone aren't pulled into the upload bundle until a file
// is actually previewed. CtPreview handles NIfTI, DicomPreview handles a DICOM series.
const CtPreview = lazy(() => import("../components/CtPreview/CtPreview"));
const DicomPreview = lazy(() => import("../components/CtPreview/DicomPreview"));
import { API_BASE } from "../helpers/constants";
import { itemToId } from "../helpers/search";
import { stageSample, releaseStagedSample, previewStagedSample, type StagedSample } from "../helpers/stagedSample";
import {
  addRecentUpload,
  batchAnnouncement,
  friendlyScanName,
  markRecentUploadViewed,
  renameRecentUpload,
  groupUploads,
  isGroupInFlight,
  loadRecentUploads,
  readJobUpdatedAt,
  RECENT_UPLOADS_CHANGED,
  RECENT_UPLOADS_MIGRATED,
  getRecentUploadsAccount,
  removeRecentUpload,
  splitByAge,
  updateRecentUploadStatus,
  updateRecentUploadStages,
  type RecentUpload,
  type RecentUploadsMigratedDetail,
  type UploadGroup,
} from "../helpers/recentUploads";
import WorkspaceIntro from "./LandingPage";
import "./Workspace.css";
import ProcessingSummaryBar from "../components/ProcessingSummaryBar";
import WorkspaceRunCard from "../components/WorkspaceRunCard";
import PipelineStepSelector from "../components/PipelineStepSelector";
import BatchDetailsModal from "../components/BatchDetailsModal";
import { track } from "../helpers/analytics";
import UpgradeDialog, { type UpgradeBlock } from "../components/UpgradeDialog";
import { useAuth } from "../contexts/authContext";
import {
  gatingPlan,
  isModelLocked,
  maxConcurrentScans,
  canPostprocess,
  type PlanId,
} from "../helpers/accountProfile";
import { countDicomSlices, looksLikeDicom, setLocalDicomFiles } from "../helpers/dicomLocal";
import { setLocalNiftiFile } from "../helpers/localNifti";
import {
  chunkSizeOf,
  deletePendingUpload,
  loadPendingUploads,
  savePendingUpload,
  setPendingNextChunk,
  setPendingUploaded,
  type PendingUpload,
} from "../helpers/pendingUploads";
import { postWithRetry, resolveResumeStart } from "../helpers/chunkUpload";
import { assertUploadAccount, createAccountUploadController, isUploadAccountCurrent } from "../helpers/uploadAccount";
// Upload state that belongs to the tab rather than to one mount of this page
// (see helpers/uploadTabState): a page opened again while an earlier one is still
// sending sees the same uploads, and its Cancel reaches them.
import {
  announceCancel,
  cancelSessionUpload,
  holdSession,
  holdsTabLock,
  onCancelFromOtherTab,
  queuedUploads,
  runCancelled,
  sessionFreeAcrossTabs,
  sessionReleased,
  // Monotonic count of bytes actually put on the wire; the "safe to close"
  // ticker diffs it to measure throughput.
  uploadBytesSent as bytesSentRef,
  uploadControllers,
  uploadRemaining,
  // Whether the current foreground upload got stored in IndexedDB (resumable).
  // If IDB was unavailable we fall back to warning before an unload instead.
  uploadResumable as uploadResumableRef,
  waitForSessionLock,
} from "../helpers/uploadTabState";
import { forgetQueuedDiscard, queuedDiscards, queueDiscardAfterSignIn } from "../helpers/discardAfterSignIn";
import { requestReconstructionInference } from "../helpers/reconstructionInference";
import { requestInferenceAdmission } from "../helpers/inferenceAdmission";
import { createBatchArchive, startBlobDownload } from "../helpers/batchDownload";
import { msUntil } from "../helpers/resetTime";
import { appendPipelineFields, EMPTY_PIPELINE, pipelineAcknowledged, readPipelineOptions, readPipelineStages, type InferenceSelection, type PipelineSelection, type PipelineOptions, type PipelinePreviewSelection } from "../helpers/inferencePipeline";


// A reply that isn't JSON came from something in front of the app (a proxy's
// HTML error page while the server restarts, say). The raw detail (content
// type, HTTP status, the start of the body) goes to the console for
// debugging; the page only ever shows the plain sentence.
const parseApiResponse = async (res: Response): Promise<any> => {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  const text = await res.text();
  const shortBody = text.slice(0, 200).replace(/\s+/g, " ").trim();
  console.error(
    `Expected JSON but got ${contentType || "unknown content-type"} (HTTP ${res.status}). Body: ${shortBody}`,
  );
  throw new Error(
    [502, 503, 504].includes(res.status)
      ? "The server is busy or restarting."
      : "The server sent a reply this page couldn't read.",
  );
};

// A 409 from the server: the upload it holds no longer matches what this page
// is sending (a leftover session it can no longer vouch for, or a chunk count
// that changed mid-upload). Its wording is written for API clients, so
// uploadFailureReason phrases it for people.
class UploadConflictError extends Error {}

// The error a non-OK upload reply becomes: the server's own message, typed
// when it is a 409.
const uploadReplyError = (res: Response, data: { error?: string }, fallback: string): Error =>
  res.status === 409
    ? new UploadConflictError(data.error || fallback)
    : new Error(data.error || fallback);

// The upload endpoints take at most this many chunks per file (the server
// refuses more). With CHUNK_SIZE it caps a NIfTI at about 4.8 GiB.
const MAX_UPLOAD_CHUNKS = 10_000;

// A NIfTI the server can never take: nothing to send, or more chunks than it
// allows. Checked when the file is picked, so the person hears about the file
// at once instead of after an upload that no retry can fix.
const unusableNiftiReason = (file: File, chunkSize: number): string | null => {
  if (file.size === 0)
    return `${file.name} is empty (0 bytes). Download or export it again and select it once more.`;
  if (file.size > MAX_UPLOAD_CHUNKS * chunkSize)
    return `${file.name} is too large to upload. The limit is about 4.8 GiB.`;
  return null;
};

// The server's replies to a file it can never take (see MAX_UPLOAD_CHUNKS),
// which only reach the page when a file got past the pick-time check. The
// DICOM slice route's own bounds reply is about a slice index, not the file.
const UNUSABLE_FILE_MESSAGE =
  "The server can't take this file because it is empty or too large (the limit is about 4.8 GiB). Check the file and select it again.";
const isUnusableFileReply = (err: unknown): boolean =>
  err instanceof Error && /^invalid total_chunks\b|^chunk index is outside upload bounds/i.test(err.message.trim());

// What the status line says went wrong with an upload: one or more whole
// sentences, so callers can add what to do next without nesting punctuation.
// fetch rejects with a TypeError when the request never got an answer.
const uploadFailureReason = (err: unknown): string => {
  if (err instanceof TypeError) return "The connection to the server was lost.";
  const text = err instanceof Error ? err.message.trim() : "";
  if (!text) return "The server didn't say why.";
  // A 409 words its own fix ("restart the upload"), which would sit beside ours.
  if (/^Upload ownership is unknown/i.test(text)) return "The server no longer has this upload.";
  if (err instanceof UploadConflictError || /total_chunks changed/i.test(text))
    return "The upload was interrupted and needs to start over.";
  // The server refuses a file with no bytes (no chunks to send) or more than
  // MAX_UPLOAD_CHUNKS chunks. Both are about the file, not the connection.
  if (isUnusableFileReply(err)) return UNUSABLE_FILE_MESSAGE;
  // A parameter name (snake_case) means the server answered in API terms; the
  // raw text goes to the console, not the page.
  if (/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i.test(text)) {
    console.error("Upload failure reason withheld from the page:", text);
    return "The server couldn't finish the upload.";
  }
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// What the status line says when a run fails to start on the server. The
// server's text is written for operators (session ids, process exit statuses,
// internal state), so it goes to the console and the page gets a sentence.
const serverFailureReason = (err: unknown, fallback: string): string => {
  if (err instanceof TypeError) return "The connection to the server was lost.";
  console.error("Server failure reason withheld from the page:", err);
  return fallback;
};

// A 401 on an upload request: the sign-in lapsed (or was ended in another tab)
// while this page still believed it was signed in. It says so and opens the
// sign-in popup instead of ending in a wordless Failed card.
const UPLOAD_SESSION_EXPIRED_MESSAGE =
  "Your session expired during the upload. Sign in and run the scan again.";
class SignedOutError extends Error {}
// The same 401 on a single result download, worded as a batch download's is.
const SIGN_IN_TO_DOWNLOAD = "Please sign in again before downloading results.";

// The server answering the run request with a refusal: its status picks the
// sentence (a 400 is about the file, anything else about the server).
class RunRejectedError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A 413 from the server. Picking the same file again or pressing Run again
// sends the same bytes into the same limit, so this failure never says to retry.
class TooLargeError extends Error {}

// What View says when several scans are selected with no model.
const VIEW_ONE_SCAN_MESSAGE =
  "View opens one scan at a time. Remove the others, or choose a model to run them as a batch.";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
};

// Coarse on purpose: a to-the-second countdown on a throughput estimate reads as
// precision that isn't there, and jitters distractingly.
const formatEta = (seconds: number): string => {
  if (seconds < 45) return "<1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.round(seconds / 360) / 10} h`;
};

// Best-effort ETA model: floor + a per-model rate applied to the file size.
// There's no real per-size history yet (see /api/inference-duration-estimate,
// which this page prefers once it has enough samples) - this is a stand-in
// built from the one real measurement on hand (a ~700MB whole-body ePAI scan
// end-to-end in ~8 min post CUDA-cache-fix) plus the pipeline's own profiled
// fixed cost (read+preprocess ~ tens of seconds independent of size). A
// straight line through one real point is still a guess for every other
// point on it - it's meant to beat "same number for every file" until real
// history replaces it, not to be precise.
type EtaProfile = { floorSeconds: number; secondsPerMb: number };
const ETA_PROFILES: Record<string, EtaProfile> = {
  // Anchor: ~700MB -> ~480s end-to-end, minus ~60s fixed cost -> ~0.6s/MB.
  ePAI: { floorSeconds: 60, secondsPerMb: 0.6 },
  // No measured anchor for these yet - same shape (fixed cost + linear-ish
  // scaling), scaled down from ePAI's rate as a placeholder, not a measurement.
  LesionSegmenter: { floorSeconds: 45, secondsPerMb: 0.35 },
  // One run: a 9.7 MB abdominal CT took 213 s end to end on a GPU shared with another user.
  // A placeholder until real history replaces it, like the profile above.
  SuPreM: { floorSeconds: 90, secondsPerMb: 8 },
};
const DEFAULT_ETA_PROFILE: EtaProfile = { floorSeconds: 60, secondsPerMb: 0.45 };

const estimateTypicalSeconds = (model: string, fileSizeBytes?: number): number => {
  const profile = ETA_PROFILES[model] ?? DEFAULT_ETA_PROFILE;
  const mb = (fileSizeBytes ?? 0) / (1024 * 1024);
  return profile.floorSeconds + profile.secondsPerMb * mb;
};

// "About 3 min left" from how long the run has been going vs. how long a run
// like this one usually takes. `typicalSecondsOverride` lets the caller swap
// in a real server-measured median (see fetchDurationEstimate) once one is
// available, instead of the size-formula fallback above. Once elapsed passes
// the estimate, there's nothing honest left to say about a remaining
// duration. Admit an overrun rather than implying the model is nearly finished.
const estimateRemaining = (
  model: string,
  startedAt: number,
  fileSizeBytes?: number,
  typicalSecondsOverride?: number,
): string => {
  const typical = typicalSecondsOverride ?? estimateTypicalSeconds(model, fileSizeBytes);
  if (!Number.isFinite(typical) || typical <= 0) return "";
  const elapsed = (Date.now() - startedAt) / 1000;
  const remaining = typical - elapsed;
  if (remaining <= 0) return "Taking longer than estimated";
  return `About ${formatEta(remaining)} left`;
};

// The ETA needs when a run started going and how big its file was. The status
// reply carries the model step's start time, but not the file size, and runs
// without step timing say nothing about their start. What the page saw is kept
// per session here, so a reload, or a return to /upload minutes later, picks
// the countdown up where it was instead of restarting it. Best-effort, like the
// other localStorage readers: without it a resumed run shows no estimate.
const SCAN_TIMING_KEY = "scanRunTiming";
const SCAN_TIMING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
type ScanTiming = { startedAt?: number; sizeBytes?: number; savedAt: number };
const readScanTimings = (): Record<string, ScanTiming> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCAN_TIMING_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const loadScanTiming = (sid: string): ScanTiming | undefined => {
  const t = readScanTimings()[sid];
  return t && typeof t === "object" ? t : undefined;
};
const saveScanTiming = (sid: string, patch: Partial<ScanTiming>) => {
  try {
    const now = Date.now();
    const all = readScanTimings();
    for (const [key, t] of Object.entries(all)) {
      if (!t || typeof t.savedAt !== "number" || now - t.savedAt > SCAN_TIMING_MAX_AGE_MS) delete all[key];
    }
    all[sid] = { ...all[sid], ...patch, savedAt: now };
    localStorage.setItem(SCAN_TIMING_KEY, JSON.stringify(all));
  } catch {
    /* private mode or a full quota: the estimate just won't survive a reload */
  }
};
const forgetScanTiming = (sid: string) => {
  try {
    const all = readScanTimings();
    if (!(sid in all)) return;
    delete all[sid];
    localStorage.setItem(SCAN_TIMING_KEY, JSON.stringify(all));
  } catch {
    /* nothing stored, or storage unavailable */
  }
};

// Samples are owned server references. Unlike local selections, their CT bytes
// only cross the browser connection when the user explicitly opens a preview.
const SAMPLE_TIMEOUT_MS = 30_000;

type SelectedItem =
  | { id: string; kind: "nifti"; file: File }
  | { id: string; kind: "sample"; sample: StagedSample }
  | { id: string; kind: "dicom"; files: File[]; label: string };

const selectedItemName = (item: SelectedItem): string => item.kind === "dicom"
  ? item.label : item.kind === "sample" ? item.sample.filename : item.file.name;

function SelectedScanThumbnail({ sample }: { sample?: StagedSample }) {
  const [unavailable, setUnavailable] = useState(false);
  if (sample && !unavailable) return <img className="file-chip-thumbnail"
    src={`${API_BASE}/api/get_image_preview/${encodeURIComponent(itemToId({ case_id: sample.caseId }))}`}
    alt="" onError={() => setUnavailable(true)} />;
  return <span className="file-chip-icon" aria-hidden="true">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  </span>;
}

function SamplePreview({ sample }: { sample: StagedSample }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAccountUploadController(sample.ownerId);
    setFile(null);
    setError("");
    void previewStagedSample(sample, controller.signal).then((loaded) => {
      if (!controller.signal.aborted && isUploadAccountCurrent(sample.ownerId)) setFile(loaded);
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The preview could not be loaded.");
    });
    return () => controller.abort();
  }, [sample]);
  if (!file) return <div className="ct-preview ct-preview--msg" role="status">{error || "Loading sample preview…"}</div>;
  return <CtPreview file={file} />;
}

// The File System Access API is available in desktop Chrome and Edge, but it
// is not yet part of TypeScript's DOM declarations. Keep the small read-only
// surface we use here explicit so browsers without it retain the input fallback.
type DirectoryPickerFileHandle = {
  kind: "file";
  getFile: () => Promise<File>;
};

type DirectoryPickerDirectoryHandle = {
  kind: "directory";
  values: () => AsyncIterableIterator<
    DirectoryPickerFileHandle | DirectoryPickerDirectoryHandle
  >;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<DirectoryPickerDirectoryHandle>;
};

const readDirectoryFiles = async (
  root: DirectoryPickerDirectoryHandle,
): Promise<File[]> => {
  const files: File[] = [];

  const visit = async (directory: DirectoryPickerDirectoryHandle) => {
    for await (const entry of directory.values()) {
      if (entry.kind === "file") {
        files.push(await entry.getFile());
      } else {
        await visit(entry);
      }
    }
  };

  await visit(root);
  return files;
};

// Files under dropped entries, folders walked to any depth. The entries come
// from DataTransferItem.webkitGetAsEntry, which only works during the drop.
const readDroppedEntries = async (entries: FileSystemEntry[]): Promise<File[]> => {
  const files: File[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands back a few hundred at a time and [] once it is done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) return;
      for (const child of batch) await visit(child);
    }
  };
  for (const entry of entries) await visit(entry);
  return files;
};

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // Running inference requires an account; selecting and viewing local files
  // remains browser-only for guests. The prompt opens on sign-in: most
  // people hitting this already have an account, and the popup switches to
  // sign-up in one click for the ones who don't.
  const { isAuthenticated, loading: authLoading, promptAuth, user, usage, refreshUsage, redeemAdminCoupon } = useAuth();
  const ensureAccount = (): boolean => {
    if (isAuthenticated) return true;
    // While the first sign-in check is still answering, the account is not known
    // yet: someone who is signed in must not be shown the sign-in popup for it.
    if (!authLoading) promptAuth();
    return false;
  };
  // Everything the plan won't allow routes through one dialog; this is what's
  // currently being explained (null = nothing blocked).
  const [upgradeBlock, setUpgradeBlock] = useState<UpgradeBlock | null>(null);
  // Not always user.plan: an admin is gated as the unlimited tier whatever plan
  // their account is on, matching plan_store.limits_for_user.
  const plan = gatingPlan(user);
  // Cosmetic mirror of the server's rules — see helpers/accountProfile. The
  // server still gets the final say via a 402, which lands in the same dialog.
  const modelLocked = (id: string) => isAuthenticated && isModelLocked(plan, id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Folder picker for a DICOM series (run inference, or view-only when model is "None").
  const dicomUploadInputRef = useRef<HTMLInputElement | null>(null);
  // Hidden fallback for browsers that cannot open a folder picker: select all
  // slices inside the folder instead. This also works on phones and tablets.
  const dicomFilesInputRef = useRef<HTMLInputElement | null>(null);
  // One poll timer per in-flight session so runs can proceed in parallel.
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pollGenerationRef = useRef<Map<string, symbol>>(new Map());
  // Whether this page is the one showing. Leaving /upload stops its pollers, but
  // an upload or run request it started carries on and can reach
  // startInferencePolling afterwards; see there.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // AbortController per session so a mid-upload run can be cancelled cleanly.
  // Shared by every mount of the page in this tab, as are the bytes still to
  // send below.
  const uploadAbortRef = useRef<Map<string, AbortController>>(uploadControllers);
  // Keep same-tab retries usable even if IndexedDB storage was denied. Durable
  // pending records remain untouched and provide reload recovery when available.
  const admissionRetriesRef = useRef(new Map<string, { model: string; uploadedName: string; selection?: InferenceSelection }>());
  // Which session currently drives the foreground upload progress bar.
  const foregroundUploadSidRef = useRef<string | null>(null);
  // The batch (if any) claiming the drop zone's status slot right now. Set the
  // moment a batch run starts, cleared when a different run starts or the
  // finished batch is dismissed (View details) - so a just-finished batch
  // keeps showing "Inference complete" in the SAME box that showed its
  // progress, instead of the box going empty while a new panel appears
  // elsewhere. Single-scan runs use sessionId/inferenceCompleted for the same
  // purpose (see the drop zone render below).
  const trackedBatchIdRef = useRef<string | null>(null);
  // Uploads run ONE FILE AT A TIME through this chain. Total upload time is
  // bandwidth-bound either way, but serializing makes the first file land at
  // ~T/N instead of ~T - and since each file is dispatched to the server's job
  // queue the moment its own upload finishes, the GPU starts chewing through
  // the batch while the remaining files are still going up.
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  // Bytes still to send, per in-flight session. Summed for the "safe to close"
  // estimate and dropped when a run ends, so a cancelled or failed file can't
  // leave phantom bytes inflating the estimate for its siblings.
  const uploadRemainingRef = useRef<Map<string, number>>(uploadRemaining);
  // Background uploads started the moment a file is selected, keyed by the
  // selected item's id (not its session id, since Run hasn't created one of
  // those yet when this starts). Not IndexedDB-resumable: a reload drops
  // selectedItems entirely (it was never persisted), so there's nothing to
  // resume - the upload just restarts next time the file is picked.
  const itemUploadRef = useRef<
    Map<string, { sid: string; uploadDone: Promise<string | null>; cancel: () => void; started: boolean; claimed: boolean; attempt?: Promise<string | null> }>
  >(new Map());

  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  const [sampleLoading, setSampleLoading] = useState(false);
  const sampleAbortRef = useRef<AbortController | null>(null);
  const sampleTransportsRef = useRef(new Set<AbortController>());
  const stagedSamplesRef = useRef(new Map<string, StagedSample>());
  useEffect(() => {
    setSampleLoading(false);
    setSelectedItems((previous) => previous.filter((item) => item.kind !== "sample" || item.sample.ownerId === user?.id));
    return () => {
      const controller = sampleAbortRef.current;
      // Release the old owner's slot immediately. Its late finally must not
      // clear a sample request started by the next signed-in account.
      sampleAbortRef.current = null;
      controller?.abort();
      for (const transport of sampleTransportsRef.current) transport.abort();
      sampleTransportsRef.current.clear();
      for (const sample of stagedSamplesRef.current.values()) void releaseStagedSample(sample.sessionId, sample.ownerId);
      stagedSamplesRef.current.clear();
    };
  }, [user?.id]);
  const [viewOnlyUploadNotice, setViewOnlyUploadNotice] = useState(false);
  // Per-item background-upload progress while a file still sits in the
  // dropzone (pre-Run) - drives the file chip's own uploading/done/failed
  // styling instead of the page-wide "Uploading…" status line, which used to
  // show for every background pre-upload even though nothing else on the
  // page needed to react to it.
  const [itemUploadStatus, setItemUploadStatus] = useState<
    Record<string, "uploading" | "done" | "failed">
  >({});
  // 0-100 percent for the file chip's own progress bar while uploading -
  // real chunk-completion progress, not a simulated sweep. Only meaningful
  // while itemUploadStatus[id] === "uploading"; left stale (harmless) once
  // an item leaves the dropzone rather than cleaned up eagerly.
  const [itemUploadProgress, setItemUploadProgress] = useState<
    Record<string, number>
  >({});
  // Server-measured median duration for a session's (model, file size), once
  // fetched - see fetchDurationEstimate. Keyed by session id so each in-flight
  // run's card can prefer a real number over the size-formula guess as soon
  // as one's available; absent (not just undefined) means "haven't checked
  // yet or the server had too little history", both of which fall back to
  // estimateTypicalSeconds silently.
  const [durationEstimates, setDurationEstimates] = useState<
    Record<string, number>
  >({});
  // Which selected item's inline preview is open (null = none). One at a time.
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  // Selection feedback belongs to the last picker/sample attempt. Clear it
  // after a successful new selection without dismissing a server/run error.
  const selectionMessageRef = useRef<string | null>(null);
  const setSelectionMessage = (text: string) => {
    selectionMessageRef.current = text;
    setMessage(text);
  };
  const clearSelectionMessage = useCallback(() => {
    const previous = selectionMessageRef.current;
    selectionMessageRef.current = null;
    if (previous !== null) setMessage((current) => current === previous ? "" : current);
  }, []);
  useEffect(() => { clearSelectionMessage(); }, [user?.id, clearSelectionMessage]);
  // Bumped by each pick, so a slow slice count never notes an older folder.
  const folderNoteSeq = useRef(0);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState("");
  const downloadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => downloadAbortRef.current?.abort(), [user?.id]);
  const [sessionId, setSessionId] = useState<string>("");
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [inferenceCompleted, setInferenceCompleted] = useState<boolean>(false);
  // Starts "None" until the account's plan is known (auth resolves async, so
  // there's nothing to gate against yet) - see the effect below that picks
  // the real default once it is known.
  const [selectedModel, setSelectedModel] = useState<
    | "None"
    | "ePAI"
    | "SuPreM"
    | "OpenVAE"
    | "MedFormer"
    | "R-Super"
    | "Atlas-Net"
    | "LesionSegmenter"
    | ""
  >("None");
  // Whether the model picker still holds its untouched starting value - once
  // the user opens the dropdown and picks anything (including re-picking the
  // same default), this goes false and the plan-aware default effect below
  // stops touching selectedModel, so it can never clobber a real choice.
  const modelTouchedRef = useRef(false);
  const [modelDropOpen, setModelDropOpen] = useState(false);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponValue, setCouponValue] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  // The input is disabled while the server checks a code, so focus falls to the page;
  // a granted code also removes the whole coupon block. When the check was started from
  // the keyboard, focus goes back to the input after a refusal and to the open model
  // menu after a grant. A check started with the mouse leaves focus alone.
  const couponInputRef = useRef<HTMLInputElement>(null);
  const couponByPointerRef = useRef(false);
  const couponRefocusRef = useRef<"input" | "menu" | null>(null);
  // LesionSegmenter computes liver/pancreatic/kidney/colon lesions in one pass;
  // this selects which lesion to feature.
  const [lesionTarget, setLesionTarget] = useState<
    "pancreatic" | "liver" | "kidney" | "colon"
  >("pancreatic");
  const modelDropRef = useRef<HTMLDivElement>(null);
  const [pipeline, setPipeline] = useState<PipelineSelection>(EMPTY_PIPELINE);
  const [pipelineOptions, setPipelineOptions] = useState<PipelineOptions | null>(null);
  // Explicit build-time UI previews, default off. Previewed stages are omitted
  // from server requests in development and production alike.
  const openVaeUiPreview = import.meta.env.VITE_OPENVAE_UI_PREVIEW === "true";
  const shapeKitUiPreview = import.meta.env.VITE_SHAPEKIT_UI_PREVIEW === "true";
  const preprocessingOption = openVaeUiPreview
    ? { id: "OpenVAE", label: "OpenVAE", available: true, reason: null, supported_models: MODEL_OPTIONS.filter((option) => option.id !== "None").map((option) => option.id) }
    : pipelineOptions?.preprocessing[0];
  const postprocessingOption = shapeKitUiPreview
    ? { id: "ShapeKit", label: "ShapeKit", available: true, reason: null, supported_models: MODEL_OPTIONS.filter((option) => option.id !== "None").map((option) => option.id) }
    : pipelineOptions?.postprocessing[0];
  useEffect(() => {
    const controller = new AbortController();
    setPipelineOptions(null);
    if (user?.id) fetch(`${API_BASE}/api/pipeline/options`, { credentials: "include", signal: controller.signal })
      .then(async (response) => response.ok ? readPipelineOptions(await response.json()) : null)
      .then((options) => { if (!controller.signal.aborted) setPipelineOptions(options); })
      .catch(() => {});
    return () => controller.abort();
  }, [user?.id, plan]);
  useEffect(() => { setPipeline(EMPTY_PIPELINE); }, [user?.id]);
  useEffect(() => {
    setPipeline((current) => {
      const preprocessing = selectedModel !== "None" && (openVaeUiPreview || pipelineOptions?.preprocessing.some((option) => option.id === current.preprocessing && option.available && option.supported_models.includes(selectedModel))) ? current.preprocessing : null;
      const postprocessing = selectedModel !== "None" && (shapeKitUiPreview || pipelineOptions?.postprocessing.some((option) => option.id === current.postprocessing && option.available && option.supported_models.includes(selectedModel))) ? current.postprocessing : null;
      return preprocessing === current.preprocessing && postprocessing === current.postprocessing ? current : { preprocessing, postprocessing };
    });
  }, [selectedModel, pipelineOptions, openVaeUiPreview, shapeKitUiPreview]);

  const submitAdminCoupon = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const coupon = couponValue.trim();
    if (!coupon || couponBusy) return;
    const fromKeyboard = !couponByPointerRef.current;
    setCouponBusy(true);
    setCouponError(null);
    try {
      await redeemAdminCoupon(coupon);
      setCouponValue("");
      setCouponOpen(false);
      setMessage("Sponsored access enabled. All models are now available.");
      if (fromKeyboard) couponRefocusRef.current = "menu";
    } catch (error) {
      setCouponError(error instanceof Error ? error.message : "That access coupon could not be redeemed.");
      if (fromKeyboard) couponRefocusRef.current = "input";
    } finally {
      setCouponBusy(false);
    }
  };
  const [isDragOver, setIsDragOver] = useState(false);
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>(() =>
    loadRecentUploads(),
  );
  // Inline rename of a scan in the history list: which one is being edited and
  // the working text.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const startRename = (u: RecentUpload) => {
    setRenamingId(u.sessionId);
    setRenameValue(u.label);
  };
  const commitRename = () => {
    if (renamingId) setRecentUploads(renameRecentUpload(renamingId, renameValue));
    setRenamingId(null);
  };
  // Removing a file chip, removing a run or a batch, cancelling a whole batch and ending
  // a rename take the focused control off the page and drop keyboard focus on <body>.
  // These say where it goes instead: the run whose Rename button gets focus back, the
  // chip whose Remove button is next ("" for the file picker), and "run" (the run
  // selector, else the file picker) or "composer" (the file picker). Set only for presses
  // from the keyboard, so focus after a mouse click is left as it was.
  const renameRefocusRef = useRef<string | null>(null);
  const chipRefocusRef = useRef<string | null>(null);
  const runRefocusRef = useRef<"run" | "composer" | null>(null);
  // Which batch's "View details" popup is open (null = none).
  const [detailsBatchId, setDetailsBatchId] = useState<string | null>(null);
  // The popup shows the last download line. A line left from a download that has
  // ended (one started on the page, or in a popup since closed, or a failure that
  // came in after it closed) belongs to that download, not to the batch opened
  // next: it is dropped whenever a popup opens or closes with no download going.
  useEffect(() => {
    if (!downloadAbortRef.current) setDownloadMessage("");
  }, [detailsBatchId]);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  // New run hides the current thread only. Existing jobs keep polling and
  // remain available from the sidebar and History.
  const [freshWorkspace, setFreshWorkspace] = useState(() => Boolean(location.state?.newWorkspaceRun));
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const consumedWorkspaceRequest = useRef<string | null>(null);
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const modelInfoButton = useRef<HTMLButtonElement>(null);
  const modelInfoDialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelInfoOpen) return;
    modelInfoDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setModelInfoOpen(false); }
      if (event.key === "Tab") {
        const controls = Array.from(modelInfoDialog.current?.querySelectorAll<HTMLElement>("button, a[href], select, [tabindex='0']") ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); modelInfoButton.current?.focus(); };
  }, [modelInfoOpen]);
  // Sub-state of each Active card: "waiting" | "uploading" | "queued" | "running".
  const [sessionPhases, setSessionPhases] = useState<Record<string, string>>(
    {},
  );
  // 1-based GPU queue position while phase is "queued" (server-reported, a
  // best-effort proxy for real dispatch order - see the backend comment on
  // _queued_order). Only ever consulted while phase === "queued", but cleared
  // alongside it anyway so a finished session doesn't hold onto a stale entry.
  const [queuePositions, setQueuePositions] = useState<Record<string, number>>(
    {},
  );
  // When each session's phase first became "running" - the ETA estimate needs
  // this instead of u.timestamp (scan creation) because queue wait time isn't
  // inference time and shouldn't count against the estimate. The poll
  // callback checks this ref; render reads the etaInputs copy below.
  const runningStartedAtRef = useRef<Map<string, number>>(new Map());
  // File size per in-flight session, for the ETA formula's size scaling and
  // for asking the server for a real historical estimate (see
  // fetchDurationEstimate). Write-once at run start; render reads the
  // etaInputs copy below.
  const sessionFileSizeRef = useRef<Map<string, number>>(new Map());
  // What the ETA line renders from: a copy of the two refs above, taken when
  // a session starts running, so render never reads a ref. Written once per
  // run and dropped by clearEtaTracking, so it costs one render each way.
  const [etaInputs, setEtaInputs] = useState<
    Record<string, { startedAt: number; sizeBytes?: number }>
  >({});
  // Re-renders ProcessingCard once a second while a scan is running, purely
  // so the "About N min left" text advances - nothing else here depends on it.
  // Gated on a scan actually being in the "running" phase (the only one that
  // shows an estimate): an unconditional 1s re-render of the whole page while
  // idle is wasted work, and it kept the dropzone in a constant reflow (see
  // the transition note in UploadPage.css). A leftover "Processing" entry
  // this tab isn't driving (signed out, or queued) doesn't count, and nor does
  // a phase left behind by a card that is gone (the account signed out).
  const [, setEtaTick] = useState(0);
  const anyRunning = recentUploads.some((u) => u.status === "Processing" && sessionPhases[u.sessionId] === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setEtaTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // The "Just now" / "3 mins ago" on a run card (and in the batch details
  // dialog) is worked out at render time, and with nothing running nothing
  // renders, so it would stay as it was however long the tab sits open. A
  // slow tick, plus one when the tab comes back to the front (timers are
  // throttled while it is hidden), keeps it in step with the History list.
  const [, setMinuteTick] = useState(0);
  const hasRecentRuns = recentUploads.length > 0;
  useEffect(() => {
    if (!hasRecentRuns) return;
    const bump = () => setMinuteTick((t) => t + 1);
    const timer = setInterval(bump, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasRecentRuns]);

  // Picks the model picker's real default once the account's plan is known:
  // ePAI for a plan that actually includes it, LesionSegmenter (the one real
  // model every signed-in account has, including Free) otherwise. Runs once
  // auth settles and never again after - modelTouchedRef guards against ever
  // overwriting a choice the user already made, and plan/isAuthenticated
  // settling a second time (e.g. a slow /me response revising itself) must
  // not silently swap the model out from under a user who's already looking
  // at the page. Signed-out visitors are left on "None": defaulting them
  // into a model would just immediately bounce them into the sign-in prompt.
  useEffect(() => {
    if (modelTouchedRef.current || !isAuthenticated) return;
    modelTouchedRef.current = true;
    setSelectedModel(isModelLocked(plan, "ePAI") ? "LesionSegmenter" : "ePAI");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, plan]);
  // Drives the "safe to close this tab" line. `active` = bytes still going up
  // (the tab is needed); `eta` = seconds until that stops, or null while
  // throughput is still being measured.
  const [closeInfo, setCloseInfo] = useState<{
    active: boolean;
    eta: number | null;
  }>({ active: false, eta: null });

  // Queue a file's upload behind whatever is already uploading. Resolves once the
  // task has run or been skipped. A task queued with its session id that is
  // skipped also drops the bytes it registered, which nothing else would, since
  // they outlive this page. Such a task can also be cancelled while it waits
  // (see cancelRun), and then never starts; so does one whose run was cancelled
  // before it was queued.
  const enqueueUpload = (task: () => Promise<void>, onSkipped?: () => void, sid?: string): Promise<void> => {
    const ownerId = user?.id ?? null;
    const queuedController = createAccountUploadController(ownerId);
    const ticket = Symbol(sid);
    if (sid) queuedUploads.set(sid, (queuedUploads.get(sid) ?? new Set<symbol>()).add(ticket));
    const turn = uploadChainRef.current
      .catch(() => {})
      .then(() => {
        if (sid) {
          const tickets = queuedUploads.get(sid);
          if (!tickets?.delete(ticket)) { onSkipped?.(); return; } // cancelled while it waited
          if (tickets.size === 0) queuedUploads.delete(sid);
          if (runCancelled(sid)) {
            // Cancelled before it was queued, so Cancel had no ticket to take
            // back: drop what it registered, and the resumable copy a late
            // write may have put back.
            uploadRemainingRef.current.delete(sid);
            setPhase(sid);
            void deletePendingUpload(sid);
            onSkipped?.();
            return;
          }
        }
        if (queuedController.signal.aborted || !isUploadAccountCurrent(ownerId)) {
          if (sid) { uploadRemainingRef.current.delete(sid); setPhase(sid); }
          onSkipped?.();
          return;
        }
        return task();
      })
      .catch(() => { onSkipped?.(); })
      .finally(() => queuedController.abort());
    uploadChainRef.current = turn;
    return turn;
  };

  // Ask the server to delete what a session's upload left there: the chunks, or
  // the assembled file. The server keeps a scan that was run, and holds the
  // deletion for a finalize still assembling the file. Keepalive, so it outlives
  // a page that is being left. A request the server did not answer for good (the
  // sign-in had lapsed, another tab had signed in to another account, the network
  // dropped, it erred or was busy) deleted nothing, and is kept to be made again
  // at the account's next sign-in or page load. So is one whose account signed out
  // or changed before it could be sent.
  const discardServerUpload = (sid: string) => {
    const ownerId = user?.id ?? null;
    if (!ownerId) return;
    if (!isUploadAccountCurrent(ownerId)) {
      queueDiscardAfterSignIn(sid, ownerId);
      return;
    }
    fetch(`${API_BASE}/api/discard-upload/${sid}`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Upload-Owner": ownerId },
      keepalive: true,
    })
      .then(async (res) => {
        // A 409 also answers a scan that a run has taken, which is final.
        const accountChanged = res.status === 409
          && ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code === "account_changed";
        const again = accountChanged || res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
        if (again) queueDiscardAfterSignIn(sid, ownerId);
        else forgetQueuedDiscard(sid, ownerId);
      })
      .catch(() => queueDiscardAfterSignIn(sid, ownerId));
  };

  // Cancel a session's job on the server, for a run cancelled while its run
  // request was out: the request reached the server, so the job is there by
  // now, and the Cancel that already went out found none to stop.
  const cancelServerJob = (sid: string) => {
    const ownerId = user?.id ?? null;
    if (!ownerId || !isUploadAccountCurrent(ownerId)) return;
    fetch(`${API_BASE}/api/cancel-inference/${sid}`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Upload-Owner": ownerId },
      keepalive: true,
    }).catch(() => {});
  };

  // Take back one background pre-upload: stop it, then, once the attempt has
  // stopped, have the server delete whatever it received.
  const discardPreUpload = (entry: { sid: string; cancel: () => void; started: boolean; attempt?: Promise<string | null> }) => {
    entry.cancel();
    if (entry.started) void (entry.attempt ?? Promise.resolve(null)).then(() => discardServerUpload(entry.sid));
  };

  // The status line is one line for the whole page, set by whichever run last
  // wrote to it. A run that ends without a word (a Cancel from another tab, or
  // one stopped at dispatch) clears it only if it is still the run's own.
  const clearRunMessage = (...own: string[]) => setMessage((now) => (own.includes(now) ? "" : now));

  const setPhase = (sid: string, phase?: string) =>
    setSessionPhases((prev) => {
      if (phase === undefined) {
        if (!(sid in prev)) return prev;
        const { [sid]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[sid] === phase ? prev : { ...prev, [sid]: phase };
    });

  const setQueuePosition = (sid: string, pos?: number) =>
    setQueuePositions((prev) => {
      if (pos === undefined) {
        if (!(sid in prev)) return prev;
        const { [sid]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[sid] === pos ? prev : { ...prev, [sid]: pos };
    });

  const allowedExtensions = [".nii", ".nii.gz"];

  const loadSample = async () => {
    if (!ensureAccount() || sampleAbortRef.current || !user?.id) return;
    const ownerId = user.id;
    const sid = crypto.randomUUID();
    const controller = createAccountUploadController(ownerId);
    const transport = createAccountUploadController(ownerId);
    sampleAbortRef.current = controller;
    sampleTransportsRef.current.add(transport);
    setSampleLoading(true);
    setSelectionMessage("");
    let selected = false;
    let timedOut = false;
    // Cancel is immediate in the UI. Let the tiny POST settle so any late
    // successful copy can be released; switching accounts aborts transport too.
    const stopSelection = () => {
      if (sampleAbortRef.current === controller) {
        sampleAbortRef.current = null;
        if (isUploadAccountCurrent(ownerId)) setSampleLoading(false);
      }
      if (!selected) void releaseStagedSample(sid, ownerId);
    };
    controller.signal.addEventListener("abort", stopSelection, { once: true });
    const timer = window.setTimeout(() => {
      timedOut = !controller.signal.aborted;
      controller.abort();
      transport.abort();
    }, SAMPLE_TIMEOUT_MS);
    try {
      const sample = await stageSample(sid, ownerId, controller.signal, transport.signal);
      assertUploadAccount(ownerId, controller.signal);
      stagedSamplesRef.current.set(sid, sample);
      selected = true;
      setSelectedItems((previous) => [...previous, { id: sid, kind: "sample", sample }]);
      setSelectionMessage(`Sample case ${itemToId({ case_id: sample.caseId })} is ready on the server. Select Run to start inference, or Preview to inspect the scan.`);
    } catch (error) {
      if (isUploadAccountCurrent(ownerId) && (!controller.signal.aborted || timedOut)) {
        setSelectionMessage(timedOut ? "Preparing the sample timed out. Please try again."
          : error instanceof Error ? error.message : "The sample could not be prepared.");
      }
    } finally {
      window.clearTimeout(timer);
      controller.signal.removeEventListener("abort", stopSelection);
      if (!selected) void releaseStagedSample(sid, ownerId);
      if (sampleAbortRef.current === controller) {
        sampleAbortRef.current = null;
        if (isUploadAccountCurrent(ownerId)) setSampleLoading(false);
      }
      sampleTransportsRef.current.delete(transport);
      transport.abort();
      controller.abort();
    }
  };

  /* ── File handling ── */
  // Shared by Upload NIfTI, a drop of NIfTI files and a folder of them: adds
  // the usable files and says why any other was left out. Returns that message.
  const addNiftiFiles = (files: File[]) => {
    folderNoteSeq.current++;
    const usable: File[] = [];
    const reasons: string[] = [];
    for (const f of files) {
      const reason = unusableNiftiReason(f, CHUNK_SIZE);
      if (reason) reasons.push(reason);
      else usable.push(f);
    }
    if (usable.length > 0) {
      track("upload_files_selected");
      clearSelectionMessage();
      setSelectedItems((prev) => [
        ...prev,
        ...usable.map((f) => ({
          id: crypto.randomUUID(),
          kind: "nifti" as const,
          file: f,
        })),
      ]);
    }
    const left =
      reasons.length === 0
        ? ""
        : reasons.length === 1
          ? reasons[0]
          : `${reasons[0]} ${reasons.length - 1} other ${reasons.length === 2 ? "file was" : "files were"} also left out.`;
    if (left) setSelectionMessage(left);
    return left;
  };

  // A folder holds either NIfTI scans or DICOM slices. NIfTI files in it win:
  // looksLikeDicom would otherwise take an extensionless README as a slice.
  // Hidden files (macOS "._scan.nii.gz" sidecars) are not scans, so they never
  // count as NIfTI. A DICOM series set aside for a NIfTI file is said so, not dropped.
  const addFolderFiles = (files: File[]) => {
    const nifti = files.filter(
      (file) => !file.name.startsWith(".") && allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    if (nifti.length === 0) {
      addDicomFiles(files);
      return;
    }
    const shown = addNiftiFiles(nifti);
    // Two or more real slices make a series; a README and a LICENSE do not. The
    // count reads the files, so the note follows only while the status line
    // still says what this pick left there.
    const seq = ++folderNoteSeq.current;
    void countDicomSlices(files).then((slices) => {
      if (slices < 2 || seq !== folderNoteSeq.current || (selectionMessageRef.current ?? "") !== shown) return;
      const note = `The ${slices} DICOM slices in that folder were left out because it also holds a NIfTI file. To view the slices, select a folder with only the slices.`;
      setSelectionMessage(shown ? `${shown} ${note}` : note);
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const filteredFiles = Array.from(e.target.files).filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    // Reset so picking the SAME file again later still fires a change event.
    // The native <input> tracks its value by path, not by content - without
    // this, re-selecting a file you already ran once (e.g. after Run clears
    // selectedItems back to empty) is a silent no-op: no change event fires,
    // so nothing here even runs and the picker just quietly does nothing.
    e.target.value = "";
    if (filteredFiles.length === 0) {
      setSelectionMessage("Please select .nii or .nii.gz files only");
      return;
    }
    addNiftiFiles(filteredFiles);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!e.dataTransfer.files) return;
    const dropped = Array.from(e.dataTransfer.files);
    const filteredFiles = dropped.filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    const refuse = () => setSelectionMessage("Please drop .nii or .nii.gz files or a DICOM series");
    if (filteredFiles.length === 0) {
      // A DICOM drop: loose slices arrive as files, a folder as one directory
      // entry that has to be walked (entries are only readable during the drop).
      const entries = Array.from(e.dataTransfer.items ?? [])
        .map((item) => item.webkitGetAsEntry?.() ?? null)
        .filter((entry): entry is FileSystemEntry => entry !== null);
      if (entries.some((entry) => entry.isDirectory)) {
        readDroppedEntries(entries)
          .then(addFolderFiles)
          .catch(() => setSelectionMessage("Couldn't read that DICOM folder. Use Upload DICOM, then choose the folder."));
        return;
      }
      if (dropped.some(looksLikeDicom)) {
        // A README or a LICENSE has no extension either: only files that read
        // as DICOM make a series.
        void countDicomSlices(dropped).then((slices) => (slices > 0 ? addDicomFiles(dropped) : refuse()));
        return;
      }
      refuse();
      return;
    }
    const shown = addNiftiFiles(filteredFiles);
    // NIfTI files win, as in a folder; slices dropped with them, loose or in a
    // folder, are left out, and the status line says so. Only files that read as
    // DICOM are counted (a README or a LICENSE is not a slice). The count reads
    // the files, so the note follows only while the status line still says what
    // this drop left there.
    const rest = Array.from(e.dataTransfer.items ?? [])
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => entry !== null)
      .filter((entry) => entry.isDirectory || !allowedExtensions.some((ext) => entry.name.toLowerCase().endsWith(ext)));
    const seq = ++folderNoteSeq.current;
    void readDroppedEntries(rest)
      .then(countDicomSlices)
      .then((slices) => {
        if (slices === 0 || seq !== folderNoteSeq.current || (selectionMessageRef.current ?? "") !== shown) return;
        const note = `${slices} dropped DICOM ${slices === 1 ? "slice was" : "slices were"} left out. To add a DICOM series, drop it on its own.`;
        setSelectionMessage(shown ? `${shown} ${note}` : note);
      })
      .catch(() => {});
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const removeItem = (id: string) => {
    const sample = stagedSamplesRef.current.get(id);
    if (sample) {
      stagedSamplesRef.current.delete(id);
      void releaseStagedSample(sample.sessionId, sample.ownerId);
      clearSelectionMessage();
    }
    const pre = itemUploadRef.current.get(id);
    if (pre) {
      // Removed before Run: nothing will use what it already sent.
      discardPreUpload(pre);
      itemUploadRef.current.delete(id);
    }
    setSelectedItems((prev) => prev.filter((item) => item.id !== id));
    setPreviewItemId((prev) => (prev === id ? null : prev));
    setItemUploadStatus((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
    setItemUploadProgress((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  // Treat folder and manual multi-file selection identically after the browser
  // gives us File objects. Folder support differs among browsers, but the upload
  // pipeline itself must not.
  const addDicomFiles = (files: File[]) => {
    folderNoteSeq.current++;
    const candidates = files.filter(looksLikeDicom);
    if (!candidates.length) {
      setSelectionMessage(
        "No DICOM files found. Choose the folder containing the .dcm slices. If your device cannot select folders, select the slice files instead.",
      );
      return;
    }
    clearSelectionMessage();
    setSelectedItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "dicom",
        files: candidates,
        label: `DICOM series (${candidates.length} ${candidates.length === 1 ? "slice" : "slices"})`,
      },
    ]);
  };

  // One user-facing DICOM control works across browsers: Chrome/Edge use their
  // native folder chooser, browsers with webkitdirectory use that, and every
  // remaining browser falls back to selecting the individual slices.
  const chooseDicomFiles = async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      try {
        // File System Access methods are Web-IDL methods and must be invoked
        // with Window as their receiver. Calling the detached function throws
        // "Illegal invocation" in Chromium, making this button appear inert.
        const directory = await picker.call(window);
        addFolderFiles(await readDirectoryFiles(directory));
      } catch (err) {
        // Cancelling the native chooser is a normal no-op, not an upload error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("DICOM directory selection failed", err);
        setSelectionMessage(
          "Couldn't read that DICOM folder. Select DICOM again, then choose all slices in the folder.",
        );
      }
      return;
    }

    const supportsDirectoryInput =
      "webkitdirectory" in document.createElement("input");
    if (supportsDirectoryInput) {
      dicomUploadInputRef.current?.click();
      return;
    }

    dicomFilesInputRef.current?.click();
  };

  const handleDicomInferenceSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same folder later
    addFolderFiles(files);
  };

  /* ── Inference polling (one timer per session) ── */
  const stopPolling = (sid: string) => {
    const timer = pollTimersRef.current.get(sid);
    if (timer !== undefined) {
      clearTimeout(timer);
      pollTimersRef.current.delete(sid);
    }
    pollGenerationRef.current.delete(sid);
  };

  const stopAllPolling = () => {
    pollTimersRef.current.forEach((timer) => clearTimeout(timer));
    pollTimersRef.current.clear();
    pollGenerationRef.current.clear();
  };

  // Ask the server for a real median duration for this model/file-size, once
  // a run starts - see /api/inference-duration-estimate. Best-effort: on any
  // failure (network, server has no history yet) durationEstimates simply
  // stays without this sid, and estimateRemaining falls back to the
  // size-formula guess silently. Fire-and-forget by design - this is a nice-
  // to-have upgrade to the ETA display, not something a run should ever wait
  // on or fail over.
  const fetchDurationEstimate = (sid: string, model: string, fileSizeBytes?: number) => {
    const params = new URLSearchParams({ model });
    if (fileSizeBytes) params.set("size_bytes", String(fileSizeBytes));
    fetch(`${API_BASE}/api/inference-duration-estimate?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available && typeof data.median_seconds === "number") {
          setDurationEstimates((prev) => ({ ...prev, [sid]: data.median_seconds }));
        }
      })
      .catch(() => {}); // silent - the formula fallback covers this
  };

  // A run has left the "running" state for good (finished, failed, or
  // cancelled) - drop everything the ETA display was tracking for it, so a
  // future session id can't inherit stale timing/size/estimate data.
  const clearEtaTracking = (sid: string) => {
    runningStartedAtRef.current.delete(sid);
    sessionFileSizeRef.current.delete(sid);
    forgetScanTiming(sid);
    setEtaInputs((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _dropped, ...rest } = prev;
      return rest;
    });
    setDurationEstimates((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const finishSession = (sid: string, updatedAt?: unknown) => {
    stopPolling(sid);
    setPhase(sid);
    setRecentUploads(updateRecentUploadStatus(sid, "Completed", user?.id ?? null, updatedAt));
    setSessionId(sid);
    setInferenceCompleted(true);
    // Deliberately does NOT navigate to the viewer - a finished run just sits
    // in Completed Uploads until the user clicks View, same as any other
    // completed scan. Auto-opening the viewer the moment a run finished used
    // to yank people into it even when they weren't looking at this tab
    // anymore (e.g. running several scans back to back).
  };

  const startInferencePolling = (sid: string, model: string) => {
    // Only the page that is showing polls. A run request the page left behind
    // finishes in its old closures, and a poller started there would run on with
    // nobody looking, next to the one the returned page starts for the same
    // session once that request has settled.
    if (!mountedRef.current) return;
    stopPolling(sid);
    const generation = Symbol(sid);
    pollGenerationRef.current.set(sid, generation);
    let notFoundCount = 0;
    // This poller watched the run wait in the queue, so the moment it turns
    // to "running" is a start it saw, not one it came in the middle of.
    let sawQueued = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
          credentials: "include",
        });
        // The sign-in has lapsed (or was ended in another tab), so every further
        // poll would be refused the same way. Stop, sign the page out as the
        // server already has, and ask for sign-in: once someone signs in, the
        // account's runs are followed again.
        if (res.status === 401) {
          if (pollGenerationRef.current.get(sid) !== generation) return;
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          window.dispatchEvent(new Event("bodymaps:session-expired"));
          promptAuth();
          return;
        }
        const data = await parseApiResponse(res);
        if (pollGenerationRef.current.get(sid) !== generation) return;
        const status = (data.status || "").toLowerCase();

        // The server doesn't know this session: the upload never finished
        // (tab closed mid-upload) or the backend restarted and lost its
        // in-memory job table. A few consecutive hits = gone, not a blip.
        if (status === "not_found") {
          notFoundCount += 1;
          if (notFoundCount >= 3) {
            stopPolling(sid);
            setPhase(sid);
            setQueuePosition(sid);
            clearEtaTracking(sid);
            setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
            setMessage(
              "This session no longer exists on the server. The run was marked as failed.",
            );
          }
          return;
        }
        notFoundCount = 0;

        if (!res.ok)
          throw new Error(data.error || data.status || "Status check failed");

        // Ignore a delayed response from a previous attempt before terminal
        // cleanup can stop the current attempt's poller or replace its stages.
        const version = readJobUpdatedAt(data.updated_at);
        const knownVersion = loadRecentUploads(user?.id ?? null).find(u => u.sessionId === sid)?.serverUpdatedAt;
        if (version !== undefined && knownVersion !== undefined && version < knownVersion) return;
        const stages = readPipelineStages(data.pipeline_stages);
        if (stages) setRecentUploads(updateRecentUploadStages(sid, stages, user?.id ?? null, data.updated_at));

        if (status === "completed") {
          setQueuePosition(sid);
          clearEtaTracking(sid);
          finishSession(sid, data.updated_at);
        } else if (status === "failed") {
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null, data.updated_at));
          // The job's error is written for operators; the page says what to do.
          if (data.error) console.error("Inference failed:", data.error);
          setMessage("The scan couldn't be processed. Run it again.");
        } else if (status === "cancelled") {
          // Cancelled elsewhere (another tab, or the backend) - reflect it.
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null, data.updated_at));
        } else if (status === "queued" || status === "running") {
          if (status === "queued") sawQueued = true;
          if (status === "running" && !runningStartedAtRef.current.has(sid)) {
            // When the model step began: the server's own time for it when the
            // reply has one, else now for a run this page started or watched
            // leave the queue, else what a page that saw the start saved. A run
            // joined while running with none of these has no honest start to
            // count from, so no estimate is drawn and the next poll asks again.
            const saved = loadScanTiming(sid);
            const sizeBytes = sessionFileSizeRef.current.get(sid) ?? saved?.sizeBytes;
            const serverStart = Date.parse(stages?.find((stage) => stage.id === "segmentation")?.started_at ?? "");
            const sawStart = sessionFileSizeRef.current.has(sid) || sawQueued;
            const startedAt = Number.isFinite(serverStart) ? serverStart : sawStart ? Date.now() : saved?.startedAt;
            if (startedAt !== undefined) {
              runningStartedAtRef.current.set(sid, startedAt);
              saveScanTiming(sid, { startedAt, sizeBytes });
              setEtaInputs((prev) => ({ ...prev, [sid]: { startedAt, sizeBytes } }));
              fetchDurationEstimate(sid, model, sizeBytes);
            }
          }
          setPhase(sid, status);
          setQueuePosition(
            sid,
            status === "queued" && typeof data.queue_position === "number"
              ? data.queue_position
              : undefined,
          );
        }
      } catch (err) {
        // Network blip or proxy error while the backend restarts - the job
        // may still be alive server-side, so keep polling.
        console.error(err);
      } finally {
        // Schedule only after this request settles. setInterval allowed slow
        // requests to overlap and stale responses to overwrite newer state.
        if (pollGenerationRef.current.get(sid) === generation) {
          const nextTimer = setTimeout(poll, 2500);
          pollTimersRef.current.set(sid, nextTimer);
        }
      }
    };
    const timer = setTimeout(poll, 0);
    pollTimersRef.current.set(sid, timer);
  };

  // Cancel one run, whatever phase it's in: aborts an in-flight upload, takes
  // a waiting one out of the line, or kills a queued/running server job.
  // `quiet` leaves the status line to a caller cancelling several at once.
  const cancelRun = (upload: RecentUpload, { quiet = false } = {}) => {
    const sid = upload.sessionId;
    const ownerId = user?.id ?? null;
    track("upload_cancel_inference");
    stopPolling(sid);
    setPhase(sid);
    setQueuePosition(sid);
    clearEtaTracking(sid);

    cancelSessionUpload(sid);
    admissionRetriesRef.current.delete(sid);
    deletePendingUpload(sid);

    // Fire-and-forget: if the job never reached the server (upload phase)
    // this 404s, which is fine - the client side is already torn down. What
    // that upload left on the server is then deleted, since no job will ever
    // use it.
    fetch(`${API_BASE}/api/cancel-inference/${sid}`, {
      method: "POST",
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          discardServerUpload(sid);
          return;
        }
        // The status poll only looks every 2.5 s, so the scan can have
        // finished a moment before Cancel was pressed. The server then says
        // so instead of cancelling, and the card follows it: its result
        // exists and the scan was spent.
        const data = await res.json().catch(() => null);
        if (data?.status === "completed") {
          finishSession(sid);
          setMessage("It had already finished.");
        } else if (data?.status === "failed") {
          setRecentUploads(updateRecentUploadStatus(sid, "Failed", ownerId));
          setMessage("The scan couldn't be processed. Run it again.");
        }
      })
      .catch(() => {});

    if (foregroundUploadSidRef.current === sid) {
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
    }
    setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", ownerId));
    // Only now, so a tab that acts on it reads the card as Cancelled.
    announceCancel(sid, ownerId);
    if (!quiet) setMessage(`Cancelled ${upload.label}`);
  };

  // Another tab cancelled a run this page may be showing or carrying. Its
  // upload is already stopped (see helpers/uploadTabState); what is left is
  // this page's own polling, phase and cards.
  useEffect(() => onCancelFromOtherTab(({ sid, ownerId }) => {
    if (ownerId !== (user?.id ?? null)) return;
    stopPolling(sid);
    setPhase(sid);
    setQueuePosition(sid);
    clearEtaTracking(sid);
    if (foregroundUploadSidRef.current === sid) {
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
    }
    setRecentUploads(loadRecentUploads(ownerId));
  }), [user?.id]);

  useEffect(() => {
    // Resume every in-flight run - there can be several in parallel. Uploads
    // that were still mid-transfer live in IndexedDB and must be *resumed*
    // (not polled - the server has no job for them yet); the rest are already
    // inferencing server-side, so we reconnect their pollers.
    let cancelled = false;
    const ownerId = user?.id ?? null;
    const resumed = new Set<string>();
    // Ends the waits on sessions another tab is carrying when this run of the
    // effect is over.
    const stopWaiting = new AbortController();
    // Takes up a session that an earlier mount of this page was still uploading
    // or starting when this one opened, once that has ended: the state it left
    // behind decides what, if anything, is still to do.
    const takeUpAfter = async (u: RecentUpload) => {
      if (cancelled || getRecentUploadsAccount() !== ownerId) return;
      const latest = loadRecentUploads(ownerId);
      setRecentUploads(latest);
      setPhase(u.sessionId);
      if (latest.find((r) => r.sessionId === u.sessionId)?.status !== "Processing") return;
      const left = (await loadPendingUploads()).find((p) => p.sessionId === u.sessionId);
      if (cancelled || getRecentUploadsAccount() !== ownerId) return;
      resumeOne(u, left);
    };
    const resumeOne = (u: RecentUpload, p: PendingUpload | undefined) => {
      if (u.serverSynced) {
        // /me/jobs already proved the job exists. An old IndexedDB upload
        // cursor must never cause us to submit that inference a second time.
        startInferencePolling(u.sessionId, u.model);
        return;
      }
      const held = sessionReleased(u.sessionId);
      if (held) {
        // Still uploading or starting from before the page was left and opened
        // again. Starting it here too would send the file twice, or poll for a
        // job that does not exist yet, so wait for it and carry on from there.
        setPhase(u.sessionId, "uploading");
        void held.then(() => takeUpAfter(u));
        return;
      }
      void (async () => {
        // Another tab on /upload can be carrying this session (the holds only
        // see this tab): resuming its upload would send the file twice, and
        // polling before it has sent the run request would fail the run. Leave
        // it to that tab, and take it up if that tab finishes or closes.
        const release = p ? holdSession(u.sessionId) : undefined;
        const free = p ? await holdsTabLock(u.sessionId) : await sessionFreeAcrossTabs(u.sessionId);
        if (!free || cancelled) {
          release?.();
          if (cancelled) return;
          setPhase(u.sessionId, "waiting");
          await waitForSessionLock(u.sessionId, stopWaiting.signal);
          await takeUpAfter(u);
          return;
        }
        if (runCancelled(u.sessionId)) {
          // Cancelled while the lock was being asked for; p is what was stored
          // before, and what it uploaded is nobody's now.
          release?.();
          setPhase(u.sessionId);
          if (p) {
            void deletePendingUpload(u.sessionId);
            discardServerUpload(u.sessionId);
          }
          return;
        }
        if (p?.uploadedFilename) {
          // Fully uploaded, but the tab closed before its job was created. The
          // file is already on the server - just replay the inference call. Not
          // queued behind the resuming uploads: it costs one POST and getting it
          // into the GPU queue now is the whole point.
          void dispatchInference(p.sessionId, p.model, p.uploadedFilename, false, p.pipeline).finally(release);
        } else if (p) {
          setPhase(u.sessionId, "waiting");
          uploadRemainingRef.current.set(p.sessionId, p.file.size);
          // Read back from IndexedDB, so a reload in the middle loses nothing.
          void enqueueUpload(() => {
            uploadResumableRef.current = true;
            return runUpload(p, false);
          }, undefined, p.sessionId).then(release); // resume the upload
        } else {
          startInferencePolling(u.sessionId, u.model); // resume polling
        }
      })();
    };
    const resume = async (sessionIds?: Set<string>) => {
      if (!ownerId || getRecentUploadsAccount() !== ownerId) return;
      const processing = loadRecentUploads(ownerId).filter(
        (u) => u.status === "Processing" && (!sessionIds || sessionIds.has(u.sessionId)),
      );
      const pending = await loadPendingUploads();
      if (cancelled || getRecentUploadsAccount() !== ownerId) return;
      const pendingById = new Map(pending.map((p) => [p.sessionId, p]));

      for (const u of processing) {
        // A verified newer server attempt may reuse the same session ID after
        // its previous poller finished. Only reconnect; never replay an upload.
        if ((resumed.has(u.sessionId) && !(sessionIds?.has(u.sessionId) && u.serverSynced)) || pollTimersRef.current.has(u.sessionId)
          || (uploadAbortRef.current.has(u.sessionId) && !sessionReleased(u.sessionId))) continue;
        resumed.add(u.sessionId);
        resumeOne(u, pendingById.get(u.sessionId));
      }

      // Pending uploads may belong to another signed-in account on this device.
      // Resume only this account's scoped history; never prune other accounts'
      // IndexedDB files just because their cards are not visible here.

      if (processing.length > 0) {
        // Keep a session id bound for the action bar, but don't surface a
        // "Reconnected · N runs" message — the processing summary bar shows this.
        setSessionId(processing[0].sessionId);
      }
    };
    // Legacy history is imported only after the server confirms ownership.
    // That request can finish after this page mounts; resume just those new IDs.
    const onMigrated = (event: Event) => {
      const detail = (event as CustomEvent<RecentUploadsMigratedDetail>).detail;
      if (detail?.ownerId === ownerId) void resume(new Set(detail.sessionIds));
    };
    window.addEventListener(RECENT_UPLOADS_MIGRATED, onMigrated);
    void resume();
    return () => {
      cancelled = true;
      stopWaiting.abort();
      window.removeEventListener(RECENT_UPLOADS_MIGRATED, onMigrated);
      stopAllPolling();
    };
  }, [user?.id]);

  // Deletions the server has not answered for good wait in this browser (see
  // discardServerUpload): each is sent again at its account's sign-ins and page
  // loads. Keyed on the user object, which every sign-in replaces, so signing in
  // again to the same account after a lapsed sign-in sends them too.
  useEffect(() => {
    if (!user?.id) return;
    queuedDiscards(user.id).forEach((sid) => discardServerUpload(sid));
    // discardServerUpload reads the account it is keyed on and refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Only warn before an unload if the current upload could NOT be stored in
  // IndexedDB (quota/private-mode) - otherwise an interrupted upload resumes
  // automatically on reopen, so no scary dialog is needed. closeInfo.active
  // also covers bytes an earlier mount of this page is still sending, which
  // never set this mount's isUploading.
  useEffect(() => {
    if (!(isUploading || closeInfo.active) || uploadResumableRef.current) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isUploading, closeInfo.active]);

  // "Safe to close" estimate. Only the upload needs this tab: once a file is
  // dispatched it lives in the server's DB-backed job queue behind the GPU lock,
  // so the tab becomes disposable the moment the last byte lands. Rather than
  // accumulating a fixed total (which a cancel or failure would leave stale),
  // both terms are re-derived every tick from live state: remaining bytes from
  // the per-session map, throughput from the delta in bytes actually sent.
  useEffect(() => {
    let lastBytes = bytesSentRef.current;
    let rate = 0; // bytes/sec, smoothed - raw per-second deltas are far too jumpy
    const timer = setInterval(() => {
      const sent = bytesSentRef.current;
      const delta = sent - lastBytes;
      lastBytes = sent;
      rate = rate === 0 ? delta : rate * 0.7 + delta * 0.3;

      let remaining = 0;
      uploadRemainingRef.current.forEach((bytes) => {
        remaining += bytes;
      });
      const active = uploadRemainingRef.current.size > 0;
      // Below ~1 KB/s the estimate is noise (or the connection stalled) -
      // show "uploading" with no number rather than an absurd one.
      const eta = active && rate > 1024 ? Math.max(1, Math.round(remaining / rate)) : null;
      // Hand back the same object when nothing changed so React skips the
      // render: a fresh {active:false, eta:null} every second re-rendered
      // this whole page once a second while it sat idle.
      setCloseInfo((prev) =>
        prev.active === active && prev.eta === eta ? prev : { active, eta },
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!modelDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        modelDropRef.current &&
        !modelDropRef.current.contains(e.target as Node)
      )
        setModelDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelDropOpen]);

  /* ── Upload (chunked) ── */
  useEffect(() => {
    const closeMenus = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modelDropOpen) modelDropRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      setModelDropOpen(false);
    };
    document.addEventListener("keydown", closeMenus);
    return () => document.removeEventListener("keydown", closeMenus);
  }, [modelDropOpen]);

  useEffect(() => {
    const target = couponRefocusRef.current;
    if (couponBusy || !target) return;
    couponRefocusRef.current = null;
    // Only when focus was lost; someone who moved on meanwhile keeps their place.
    if (!keyboardFocusLost()) return;
    if (target === "input") {
      couponInputRef.current?.focus();
      return;
    }
    const menu = modelDropRef.current?.querySelector<HTMLElement>("#segmentation-options");
    (menu?.querySelector<HTMLElement>('[role="button"].selected') ?? menu?.querySelector<HTMLElement>('[role="button"]'))?.focus();
  }, [couponBusy]);

  const focusComposer = useCallback(() => {
    const target = document.querySelector<HTMLButtonElement>("[data-composer-focus]");
    document.getElementById("scan-composer")?.scrollIntoView?.({ block: "start", behavior: "auto" });
    target?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    window.addEventListener("bodymaps:focus-composer", focusComposer);
    const timer = window.location.hash === "#scan-composer" ? window.setTimeout(focusComposer, 0) : undefined;
    return () => { window.removeEventListener("bodymaps:focus-composer", focusComposer); window.clearTimeout(timer); };
  }, [focusComposer]);
  useEffect(() => {
    if (!location.state?.newWorkspaceRun && !location.state?.workspaceRunId) return;
    if (consumedWorkspaceRequest.current === location.key) return;
    consumedWorkspaceRequest.current = location.key;
    const { newWorkspaceRun, workspaceRunId, ...state } = location.state;
    if (newWorkspaceRun) {
      sampleAbortRef.current?.abort();
      sampleAbortRef.current = null;
      setSampleLoading(false);
      // A submitted batch clears its selection before admitting each scan.
      // Release only what is still in the composer, never a later batch item
      // whose admission has not started yet.
      for (const item of selectedItems) {
        const sample = stagedSamplesRef.current.get(item.id);
        if (sample) {
          stagedSamplesRef.current.delete(item.id);
          void releaseStagedSample(sample.sessionId, sample.ownerId);
        }
        const entry = itemUploadRef.current.get(item.id);
        if (entry && !entry.claimed) {
          // Cleared before Run, like Remove: nothing will use what it sent.
          discardPreUpload(entry);
          itemUploadRef.current.delete(item.id);
        }
      }
      setSelectedItems([]);
      setPreviewItemId(null);
      setItemUploadStatus({});
      setItemUploadProgress({});
      setViewOnlyUploadNotice(false);
      selectionMessageRef.current = null;
      setMessage("");
      setIsDragOver(false);
      setModelDropOpen(false);
      setModelInfoOpen(false);
      setDetailsBatchId(null);
      setRenamingId(null);
      setFocusedRunId(null);
      setFreshWorkspace(true);
      for (const input of [fileInputRef.current, dicomUploadInputRef.current, dicomFilesInputRef.current]) {
        if (input) input.value = "";
      }
      setComposerFocusRequest((previous) => previous + 1);
    } else if (typeof workspaceRunId === "string") {
      setFreshWorkspace(false);
      setFocusedRunId(workspaceRunId);
    }
    navigate(location.pathname + location.search + location.hash, { replace: true, state });
    // discardPreUpload reads the account and refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, navigate, selectedItems]);
  useEffect(() => {
    if (composerFocusRequest) focusComposer();
  }, [composerFocusRequest, focusComposer]);

  useEffect(() => {
    const id = renameRefocusRef.current;
    if (renamingId !== null || !id) return;
    renameRefocusRef.current = null;
    if (!keyboardFocusLost()) return;
    Array.from(document.querySelectorAll<HTMLElement>("[data-rename-trigger]"))
      .find((button) => button.dataset.renameTrigger === id)?.focus();
  }, [renamingId]);
  useEffect(() => {
    const id = chipRefocusRef.current;
    if (id === null) return;
    chipRefocusRef.current = null;
    if (!keyboardFocusLost()) return;
    const next = id ? Array.from(document.querySelectorAll<HTMLElement>("[data-chip-remove]"))
      .find((button) => button.dataset.chipRemove === id) : undefined;
    (next ?? document.querySelector<HTMLElement>("[data-composer-focus]"))?.focus();
  }, [selectedItems]);
  useEffect(() => {
    const target = runRefocusRef.current;
    if (!target) return;
    runRefocusRef.current = null;
    if (!keyboardFocusLost()) return;
    ((target === "run" ? document.getElementById("workspace-current-run") : null)
      ?? document.querySelector<HTMLElement>("[data-composer-focus]"))?.focus();
  }, [recentUploads]);

  useEffect(() => {
    const refresh = () => setRecentUploads(loadRecentUploads(user?.id ?? null));
    refresh();
    window.addEventListener(RECENT_UPLOADS_CHANGED, refresh);
    return () => window.removeEventListener(RECENT_UPLOADS_CHANGED, refresh);
  }, [user?.id]);

  // 512 KiB, not 256 KiB. Measured against the live backend (67 MB payload, loopback
  // so the client's own uplink isn't in the path, median of 3 runs): 256 KiB chunks
  // sustained ~2.6-12.7 MB/s and were wildly unstable (one run took 1707s), while
  // 512 KiB sustained ~145 MB/s tightly (0.42-0.51s across every run). Halving the
  // request count removes most of the per-request multipart+fsync overhead that a
  // single-worker gunicorn pays.
  //
  // Do NOT raise this past ~960 KiB: nginx in front of the app enforces
  // client_max_body_size 1m, and chunks >= 1024 KiB get a hard 413 (measured -
  // 960 KiB passes, 1024 KiB fails). Lifting that ceiling is a server-config change,
  // not a client one.
  const CHUNK_SIZE = 512 * 1024;

  // Hand an already-uploaded file to the server's job queue. Split out of the
  // upload path because the two halves fail independently: the bytes are on the
  // server before this runs, so a tab closed in this window only needs the
  // inference call replayed, not the whole file re-sent. Once this returns
  // successfully the run is entirely server-side and the tab is free.
  const dispatchInference = async (
    sid: string,
    model: string,
    uploadedName: string,
    foreground: boolean,
    selection?: InferenceSelection,
    isDicom = false,
  ) => {
    if (!isUploadAccountCurrent(user?.id ?? null)) return;
    if (loadRecentUploads(user?.id ?? null).find((upload) => upload.sessionId === sid)?.status !== "Processing") {
      await deletePendingUpload(sid);
      if (runCancelled(sid)) {
        // Cancelled while its bytes were on their way (from another tab, or
        // before this tab could stop them): no run will use the file now.
        setPhase(sid);
        discardServerUpload(sid);
        if (foreground) clearRunMessage("Finalizing upload...");
      }
      return;
    }
    // Reuse the upload's controller when there is one, so a Cancel pressed
    // during the upload still aborts this call.
    let controller = uploadAbortRef.current.get(sid);
    if (!controller) {
      controller = createAccountUploadController(user?.id ?? null);
      uploadAbortRef.current.set(sid, controller);
    }
    try {
      assertUploadAccount(user?.id ?? null, controller.signal);
      if (foreground) setMessage(`Starting ${model} inference...`);
      const inferFd = new FormData();
      inferFd.append("session_id", sid);
      inferFd.append("model_name", model);
      inferFd.append("uploaded_filename", uploadedName);
      appendPipelineFields(inferFd, selection);
      setPhase(sid, "admitting");
      const signal = controller.signal;
      const { response: res, data, pending } = await requestInferenceAdmission(async () => {
        assertUploadAccount(user?.id ?? null, signal);
        const response = await fetch(`${API_BASE}/api/run-epai-inference`, {
          method: "POST", body: inferFd, credentials: "include",
          headers: { "X-Upload-Owner": user?.id ?? "" }, signal,
        });
        return { response, data: await parseApiResponse(response) };
      }, signal);
      assertUploadAccount(user?.id ?? null, controller.signal);
      if (pending) {
        // Its bytes and frozen choices are still resumable. The first request
        // may yet create the job, so a later retry must reuse this session ID.
        admissionRetriesRef.current.set(sid, { model, uploadedName, selection });
        setPhase(sid, "admission-pending");
        if (foreground) setMessage("");
        return;
      }
      // 402 is the plan refusing, not a failure — the server's reason drives
      // the upgrade dialog. The scan goes to Cancelled rather than Failed:
      // nothing broke, it just never ran.
      if (res.status === 402 && data?.code === "plan_limit") {
        admissionRetriesRef.current.delete(sid);
        await deletePendingUpload(sid);
        // No job was made and nothing points at the file it uploaded any more.
        discardServerUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null));
        setUpgradeBlock({
          reason: data.reason, message: data.message, feature: data.feature,
          limit: data.limit, used: data.used, resetsAt: data.resets_at ?? null,
          plan: (data.plan as PlanId) ?? "free",
        });
        if (foreground) setMessage("");
        return;
      }
      // 401 is an expired or missing sign-in, not a failure of the scan itself
      // (the page can still believe it is signed in when the cookie has
      // lapsed). Like the 402: mark it Cancelled, say why, and open the sign-in
      // popup instead of leaving a wordless Failed card.
      if (res.status === 401) {
        admissionRetriesRef.current.delete(sid);
        await deletePendingUpload(sid);
        // A run again gets a new session, so nothing points at this upload any
        // more. Asking now meets the same 401; it is asked again once the person
        // has signed in.
        discardServerUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null));
        setMessage("Your session expired before the run could start. Sign in and run the scan again.");
        promptAuth();
        return;
      }
      // Cancelled while the run request was being admitted: the server stopped
      // it, so the run is Cancelled, not Failed (a Cancel from another tab gets
      // here without this tab's request being aborted).
      if (res.status === 409 && data?.code === "inference_cancelled") {
        admissionRetriesRef.current.delete(sid);
        await deletePendingUpload(sid);
        discardServerUpload(sid);
        setPhase(sid);
        if (!runCancelled(sid)) setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null));
        else setRecentUploads(loadRecentUploads(user?.id ?? null));
        if (foreground) clearRunMessage(`Starting ${model} inference...`);
        return;
      }
      if (!res.ok) throw new RunRejectedError(res.status, data.error || "Failed to start inference");
      admissionRetriesRef.current.delete(sid);
      assertUploadAccount(user?.id ?? null, controller.signal);
      // Cancelled while the request was out, too late for this tab to abort it
      // (a Cancel from another tab, say): the job exists now, and is stopped.
      if (runCancelled(sid)) {
        cancelServerJob(sid);
        await deletePendingUpload(sid);
        setPhase(sid);
        if (foreground) clearRunMessage(`Starting ${model} inference...`);
        return;
      }
      if (!pipelineAcknowledged(data.pipeline, model, selection)) {
        // Guard a mixed-version deployment or resumed request against silently
        // losing its optional steps. The old server may already have admitted it.
        await fetch(`${API_BASE}/api/cancel-inference/${sid}`, { method: "POST", credentials: "include",
          headers: { "X-Upload-Owner": user?.id ?? "" } }).catch(() => {});
        assertUploadAccount(user?.id ?? null, controller.signal);
        await deletePendingUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
        setMessage("The server did not confirm the selected pipeline. Cancellation was requested; refresh before starting another run.");
        return;
      }
      const stages = readPipelineStages(data.pipeline_stages);
      if (stages) setRecentUploads(updateRecentUploadStages(sid, stages, user?.id ?? null));

      // Queued server-side now - nothing here is needed to finish the run, so
      // drop the resumable record.
      await deletePendingUpload(sid);
      refreshUsage(); // a scan was just spent; keep the settings counter honest
      setSessionId(sid);
      if (data.status === "completed") {
        finishSession(sid);
        if (foreground) setMessage("");
        return;
      }
      // An idempotent replay may reconnect to an already-running job.
      setPhase(sid, data.status === "running" ? "running" : "queued");
      // No status-line message here: the processing card below already shows
      // "Running..." for this session, so a raw-UUID line would just duplicate it.
      if (foreground) setMessage("");
      startInferencePolling(sid, model);
    } catch (err) {
      if (controller.signal.aborted || runCancelled(sid)) {
        // A Cancel aborted the request, which may have reached the server first.
        if (runCancelled(sid)) cancelServerJob(sid);
        if (foreground) clearRunMessage(`Starting ${model} inference...`);
        return;
      }
      console.error(err);
      admissionRetriesRef.current.delete(sid);
      setPhase(sid);
      await deletePendingUpload(sid);
      // Not resumable now, so the file it uploaded is nobody's. The server keeps
      // it if a job was made after all (the reply may only have been lost).
      discardServerUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
      // The card only says "Failed", which does not tell a bad file from a
      // server that could not start it. Say which, naming the file or folder
      // picked (the server's own name for a converted DICOM series is not it).
      const picked = loadRecentUploads(user?.id ?? null).find((upload) => upload.sessionId === sid)?.sourceName;
      const thing = isDicom ? "folder" : "file";
      const what = isDicom ? "DICOM series" : "scan";
      setMessage(
        err instanceof RunRejectedError && err.status === 400
          ? `${picked || `This ${what}`} could not be run. ${
              isDicom
                ? "The server couldn't read this DICOM series as a single 3D CT scan."
                : "The server couldn't read it as a single 3D CT scan (.nii or .nii.gz)."
            } Check the ${thing} and select it again.`
          : `The server couldn't start the run for ${picked || `this ${what}`}. Select the ${thing} again and press Run to try again.`,
      );
    } finally {
      controller.abort();
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  const retryAdmission = async (sid: string) => {
    const ownerId = user?.id ?? null;
    if (!isUploadAccountCurrent(ownerId) || uploadAbortRef.current.has(sid)) return;
    const release = holdSession(sid);
    try {
      const saved = admissionRetriesRef.current.get(sid);
      if (saved) {
        await dispatchInference(sid, saved.model, saved.uploadedName, false, saved.selection);
        return;
      }
      const pending = (await loadPendingUploads()).find((p) => p.sessionId === sid);
      if (!isUploadAccountCurrent(ownerId) || uploadAbortRef.current.has(sid)) return;
      if (pending?.uploadedFilename) {
        await dispatchInference(sid, pending.model, pending.uploadedFilename, false, pending.pipeline);
      }
    } finally {
      release();
    }
  };

  // Upload selected NIfTI bytes ahead of Run only when an inference model is
  // selected. View-only selections never enter this path. Reuses
  // isUploading/message, the SAME state the foreground runUpload path
  // drives: only one upload is ever active at a time (both routes go
  // through uploadChainRef). Returns the uploaded filename, or null on
  // failure/abort.
  const preUploadOnly = async (
    sid: string,
    file: File,
    onProgress?: (pct: number) => void,
    onFailure?: (notice: string) => void,
  ): Promise<string | null> => {
    const controller = createAccountUploadController(user?.id ?? null);
    uploadAbortRef.current.set(sid, controller);
    uploadRemainingRef.current.set(sid, file.size);
    // Not resumable (no IndexedDB record for a pre-upload) - closing the tab
    // now really does lose progress, so the unload warning should fire.
    uploadResumableRef.current = false;
    foregroundUploadSidRef.current = sid;
    setIsUploading(true);
    try {
      assertUploadAccount(user?.id ?? null, controller.signal);
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const CONCURRENCY = 6;
      let nextIndexToStart = 0;
      let completedChunks = 0;
      const uploadOneChunk = async (i: number) => {
        assertUploadAccount(user?.id ?? null, controller.signal);
        const chunk = file.slice(
          i * CHUNK_SIZE,
          Math.min((i + 1) * CHUNK_SIZE, file.size),
        );
        const formData = new FormData();
        formData.append("session_id", sid);
        formData.append("chunk_index", i.toString());
        formData.append("total_chunks", totalChunks.toString());
        formData.append("file", chunk);
        const res = await postWithRetry(
          `${API_BASE}/api/upload-inference-chunk`,
          { method: "POST", body: formData, credentials: "include", headers: { "X-Upload-Owner": user?.id ?? "" }, signal: controller.signal },
        );
        if (res.status === 413)
          throw new TooLargeError("The file is too large for the server to accept.");
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "Chunk upload failed");
        bytesSentRef.current += chunk.size;
        // Not once this attempt has cleaned up: the entry would never go away
        // and keep the "keep tab open" line on.
        if (uploadRemainingRef.current.has(sid)) {
          uploadRemainingRef.current.set(
            sid,
            Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
          );
        }
        completedChunks++;
        onProgress?.(Math.round((completedChunks / totalChunks) * 100));
      };
      const worker = async () => {
        while (true) {
          const i = nextIndexToStart++;
          if (i >= totalChunks) return;
          await uploadOneChunk(i);
        }
      };
      // The first response confirms ownership and chunk-count markers are fully
      // written. Sending the first six requests together can race their creation.
      if (totalChunks > 0) {
        await uploadOneChunk(0);
        nextIndexToStart = 1;
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, totalChunks - nextIndexToStart) }, worker),
      );

      assertUploadAccount(user?.id ?? null, controller.signal);
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-upload`, {
        method: "POST",
        credentials: "include",
        headers: { "X-Upload-Owner": user?.id ?? "" },
        signal: controller.signal,
        body: new URLSearchParams({
          session_id: sid,
          total_chunks: totalChunks.toString(),
          output_filename: file.name,
        }),
      });
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw uploadReplyError(finalizeRes, finalizeData, "The upload could not be finished.");
      return finalizeData.uploaded_filename || file.name;
    } catch (err) {
      if (controller.signal.aborted) return null;
      console.error("Background upload failed:", err);
      if (err instanceof SignedOutError) {
        onFailure?.(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return null;
      }
      // The file stays selected and Run uploads it afresh, so a retry really
      // is one click away, except past the server's size or chunk limits.
      const next = err instanceof TooLargeError || isUnusableFileReply(err) ? "" : " Press Run to try again.";
      onFailure?.(`${file.name} could not be uploaded. ${uploadFailureReason(err)}${next}`);
      return null;
    } finally {
      controller.abort(); // Release the account listener, including after route navigation.
      if (foregroundUploadSidRef.current === sid) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  // Kick off a NIfTI item's upload in the background, keyed by item id.
  // Idempotent - safe to call repeatedly for the same item (e.g. once from
  // selection and again from the selectedModel-changed effect).
  const preStartUpload = (item: SelectedItem) => {
    if (item.kind !== "nifti" || selectedModel === "None" || !selectedModel || modelLocked(selectedModel)) return;
    if (itemUploadRef.current.has(item.id)) return;
    const sid = crypto.randomUUID();
    let cancelled = false;
    let resolveDone!: (name: string | null) => void;
    const uploadDone = new Promise<string | null>((res) => { resolveDone = res; });
    const entry = {
      sid, uploadDone, started: false, claimed: false,
      attempt: undefined as Promise<string | null> | undefined,
      cancel: () => {
        cancelled = true;
        uploadAbortRef.current.get(sid)?.abort();
        resolveDone(null);
      },
    };
    itemUploadRef.current.set(item.id, entry);
    setItemUploadStatus((prev) => ({ ...prev, [item.id]: "uploading" }));
    setItemUploadProgress((prev) => ({ ...prev, [item.id]: 0 }));
    const file = item.file;
    // Queued under its session id, so a Cancel on the run Run hands it to takes
    // it out of the line before it starts.
    void enqueueUpload(async () => {
      if (cancelled) { resolveDone(null); return; }
      entry.started = true;
      let failure: string | null = null;
      entry.attempt = preUploadOnly(sid, file, (pct) => {
        if (!cancelled) setItemUploadProgress((prev) => ({ ...prev, [item.id]: pct }));
      }, (notice) => { failure = notice; });
      const uploadedName = await entry.attempt;
      if (failure !== null && !entry.claimed) {
        // Run starts a new session for a failed pre-upload, so what this one
        // sent is nobody's. Say why it failed while the file is still selected.
        discardServerUpload(sid);
        if (!cancelled) setSelectionMessage(failure);
      }
      if (!cancelled) setItemUploadStatus((prev) => ({
        ...prev, [item.id]: uploadedName ? "done" : "failed",
      }));
      resolveDone(cancelled ? null : uploadedName);
    }, entry.cancel, sid);
  };

  // The daily scan allowance, when usage already says it is spent and the
  // window has not reset. Null when there is room, or when usage is not loaded
  // yet (the server's 402 at dispatch stays the fallback then).
  // `requested` is how many files are about to run: a batch bigger than what
  // is left would only have its first scans accepted, after every file had been
  // sent, so it is blocked up front like a spent allowance is.
  const dailyScansBlock = (requested = 1): UpgradeBlock | null => {
    const scans = usage?.scans;
    if (!scans || scans.limit == null || scans.used + requested <= scans.limit) return null;
    if (!scans.resets_at || !(msUntil(scans.resets_at) > 0)) return null;
    return {
      reason: "daily_scans", limit: scans.limit, used: scans.used, resetsAt: scans.resets_at,
      requested, plan: plan as PlanId,
    };
  };

  // View-only is a strict no-transfer mode. Cancel uncommitted background work
  // when it is selected; Run-claimed jobs are independent of the next selection.
  useEffect(() => {
    if (selectedModel === "None" || !selectedModel) {
      let hadStarted = false;
      const removed: string[] = [];
      itemUploadRef.current.forEach((entry, id) => {
        if (entry.claimed) return;
        hadStarted ||= entry.started;
        entry.cancel();
        itemUploadRef.current.delete(id);
        removed.push(id);
      });
      if (hadStarted) setViewOnlyUploadNotice(true);
      if (removed.length) {
        setItemUploadStatus((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.includes(id))));
        setItemUploadProgress((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.includes(id))));
      }
      return;
    }
    if (!isAuthenticated || !isUploadAccountCurrent(user?.id ?? null) || modelLocked(selectedModel)) return;
    const slots = maxConcurrentScans(plan as PlanId);
    const running = recentUploads.filter((u) => u.status === "Processing").length;
    if (selectedItems.length + running > slots) return;
    // Today's scans already spent: the server would 402 the run at dispatch.
    if (dailyScansBlock(selectedItems.length)) return;
    selectedItems.forEach(preStartUpload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id, selectedModel, selectedItems, plan, recentUploads, usage]);

  // Uploads the file described by `p`, finalizes, then starts inference.
  // Resumable: the file lives in IndexedDB and the chunk cursor is persisted, so
  // a reload can call this again to pick up where it left off - starting from
  // what the server confirms it holds, not from p.nextChunk directly.
  // `foreground` = the run the user just clicked (drives the progress
  // bar); resumed background runs show only their Active-section spinner.
  const runUpload = async (p: PendingUpload, foreground: boolean) => {
    const {
      sessionId: sid,
      file,
      filename,
      model,
      bdmapId: bid,
      totalChunks,
    } = p;
    const controller = createAccountUploadController(user?.id ?? null);
    uploadAbortRef.current.set(sid, controller);
    setPhase(sid, "uploading");
    try {
      assertUploadAccount(user?.id ?? null, controller.signal);
      // A resumed upload can't trust its own cursor - the server may have swept
      // its chunks (24h TTL) or lost the staging disk. Ask what it still holds
      // and continue from there; if nothing survived this comes back 0 and the
      // file re-sends from the start (it's still in IndexedDB). Fresh uploads
      // skip the round-trip.
      const startChunk = p.nextChunk > 0
        ? await resolveResumeStart(API_BASE, sid, p.nextChunk)
        : 0;

      // Correct the "safe to close" estimate for what the server already holds:
      // startScanRun registered the whole file, but a resume only re-sends the
      // tail.
      uploadRemainingRef.current.set(
        sid,
        Math.max(0, file.size - startChunk * chunkSizeOf(p)),
      );

      if (foreground) {
        foregroundUploadSidRef.current = sid;
        setIsUploading(true);
      }

      // Chunks upload with CONCURRENCY in flight at once instead of one at a time --
      // each chunk lands in its own server-side file (chunk-<index>), reassembled by
      // finalize-upload, so arrival order doesn't matter and parallelizing is safe.
      //
      // 6. An earlier revision lowered this to 3 on the strength of a loopback
      // benchmark where 3 in flight beat 6 (0.48s vs 0.84s for 67 MB). That
      // benchmark was measuring the wrong thing: over loopback the round-trip time
      // is ~0, so it only captured server-side processing contention and was blind
      // to the reason concurrency exists. Against the real site the change made a
      // 67 MB upload SLOWER, 18s -> 22s.
      //
      // The site serves HTTP/2 (confirmed via ALPN), so these requests multiplex
      // over a single TCP connection rather than opening one socket each --
      // concurrency here controls how many bytes are in flight against one
      // congestion window, not how many connections exist. HTTP/2 flow control
      // starts each stream at a 64 KiB window, so in-flight bytes track roughly
      // CONCURRENCY x 64 KiB independently of CHUNK_SIZE: ~192 KiB at 3, ~384 KiB
      // at 6. On a ~30 Mbps uplink the bandwidth-delay product is on the order of
      // 150 KiB, so 3 streams sits at the edge of under-filling the link while 6
      // keeps it saturated.
      //
      // Server-side contention is also less of a concern than the loopback numbers
      // implied, because nginx buffers request bodies by default and hands gunicorn
      // an already-complete request.
      const CONCURRENCY = 6;

      // Resumed uploads must be sliced exactly as they were originally sliced --
      // see chunkSizeOf(). New uploads record CHUNK_SIZE at creation. This guards
      // a *different* failure than startChunk below: chunkSizeOf keeps the byte
      // offsets right, startChunk keeps the index right. Both are needed.
      const chunkSize = chunkSizeOf(p);

      // Every cursor below starts from startChunk (what the SERVER confirmed it
      // holds), not p.nextChunk (what this tab last wrote to IndexedDB) - the
      // two differ whenever the staging area was swept or lost.
      let nextIndexToStart = startChunk;
      const completedIndices = new Set<number>();
      // The resume cursor must only ever advance over a CONTIGUOUS run of completed
      // chunks -- with parallel uploads, chunk 20 can finish before chunk 15, and
      // persisting past a gap would make a resumed run skip re-sending chunk 15.
      let contiguousWatermark = startChunk;
      const advanceWatermark = async () => {
        let advanced = false;
        while (completedIndices.has(contiguousWatermark)) {
          completedIndices.delete(contiguousWatermark);
          contiguousWatermark++;
          advanced = true;
        }
        // Same throttling intent as before (avoid an IDB write per chunk) -- persist
        // on every 16th advance, plus unconditionally once everything is done below.
        if (advanced && contiguousWatermark % 16 === 0) {
          await setPendingNextChunk(sid, contiguousWatermark);
        }
      };

      const uploadOneChunk = async (i: number) => {
        assertUploadAccount(user?.id ?? null, controller.signal);
        const chunk = file.slice(
          i * chunkSize,
          Math.min((i + 1) * chunkSize, file.size),
        );
        const formData = new FormData();
        formData.append("session_id", sid);
        formData.append("chunk_index", i.toString());
        formData.append("total_chunks", totalChunks.toString());
        formData.append("file", chunk);

        // Retried: a single dropped chunk used to fail the whole run and delete
        // its resumable copy, making a brief network blip worse than closing
        // the tab. A 413 or other 4xx still fails fast - it won't fix itself.
        const res = await postWithRetry(
          `${API_BASE}/api/upload-inference-chunk`,
          {
            method: "POST",
            body: formData,
            credentials: "include",
            headers: { "X-Upload-Owner": user?.id ?? "" },
            signal: controller.signal,
          },
        );
        if (res.status === 413)
          throw new TooLargeError("The file is too large for the server to accept.");
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "Chunk upload failed");

        completedIndices.add(i);
        bytesSentRef.current += chunk.size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
        );
        await advanceWatermark();
      };

      const worker = async () => {
        while (true) {
          const i = nextIndexToStart++;
          if (i >= totalChunks) return;
          await uploadOneChunk(i);
        }
      };
      // A fresh or swept session must establish its owner and chunk count before
      // parallel workers arrive. Resumed sessions with confirmed chunks have them.
      if (startChunk === 0 && totalChunks > 0) {
        await uploadOneChunk(0);
        nextIndexToStart = 1;
      }
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, totalChunks - nextIndexToStart) },
          worker,
        ),
      );
      // Final persist in case the last watermark advance(s) landed on a non-multiple
      // of 16 -- without this, a crash right after the loop could re-send a few
      // already-uploaded tail chunks on resume (harmless, but pointless to leave on
      // the table now that we track the exact watermark).
      if (contiguousWatermark > startChunk) {
        await setPendingNextChunk(sid, contiguousWatermark);
      }

      assertUploadAccount(user?.id ?? null, controller.signal);
      if (foreground) setMessage("Finalizing upload...");
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-upload`, {
        method: "POST",
        credentials: "include",
        headers: { "X-Upload-Owner": user?.id ?? "" },
        signal: controller.signal,
        body: new URLSearchParams({
          session_id: sid,
          total_chunks: totalChunks.toString(),
          output_filename: filename,
          ...(bid ? { bdmap_id: bid } : {}),
        }),
      });
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw uploadReplyError(finalizeRes, finalizeData, "The upload could not be finished.");
      const uploadedName = finalizeData.uploaded_filename || filename;

      // The bytes are on the server but no job exists yet. Keep the IDB record
      // (minus the now-pointless file blob) flagged as uploaded, so a tab closed
      // in this window resumes by dispatching rather than by re-uploading a file
      // the server already has - or worse, failing it. dispatchInference clears it.
      await setPendingUploaded(sid, uploadedName);
      if (foreground) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }

      await dispatchInference(sid, model, uploadedName, foreground, p.pipeline);
    } catch (err) {
      // A user cancel aborts our fetches - cancelRun already did the cleanup
      // and set the card to Cancelled, so don't overwrite that with Failed. A
      // cancel this tab was not told of fails the upload from the server's
      // side (its chunks are gone), and reads the same.
      if (controller.signal.aborted || runCancelled(sid)) {
        if (foreground) clearRunMessage("Finalizing upload...");
        return;
      }
      // A genuine failure (not a user cancel): with chunks now uploading in
      // parallel, other in-flight chunk requests would otherwise keep running
      // to completion for no reason after we've already given up on this
      // upload. Abort them too.
      controller.abort();
      console.error(err);
      setPhase(sid);
      if (foreground) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
      // A lapsed sign-in is not the file's fault: say so with the sign-in popup,
      // as the run request does for a 401. The card is Cancelled, as after a
      // Cancel, and nothing resumes a Cancelled card's copy.
      if (err instanceof SignedOutError) {
        await deletePendingUpload(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null));
        setMessage(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return;
      }
      await deletePendingUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
      // The card only says "Failed", so the status line says why, for a resumed
      // run as well as a foreground one.
      setMessage(err instanceof TooLargeError
        ? `${filename} could not be uploaded. ${err.message}`
        : isUnusableFileReply(err)
          ? `${filename} could not be uploaded. ${UNUSABLE_FILE_MESSAGE}`
          : `${filename} could not be uploaded. ${uploadFailureReason(err)} Select the file again and press Run.`);
    } finally {
      controller.abort();
      // Whatever happened, this file is no longer contributing bytes - drop it
      // so a cancel/failure can't leave its unsent bytes inflating the estimate.
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  // DICOM folder → inference. Uploads each raw slice, asks the server to convert
  // the series to NIfTI (SimpleITK), then hands off to the same inference + polling
  // flow as a NIfTI run. Not IndexedDB-resumable (a folder is many files); a reload
  // mid-upload marks the run Failed, consistent with the Active/Recent cards. Wired
  // into uploadAbortRef so the Active card's Cancel button aborts it cleanly.
  const runDicomUpload = async (sid: string, files: File[], model: string, selection: InferenceSelection) => {
    const controller = createAccountUploadController(user?.id ?? null);
    uploadAbortRef.current.set(sid, controller);
    foregroundUploadSidRef.current = sid;
    uploadResumableRef.current = false; // no IDB copy for a DICOM folder
    setPhase(sid, "uploading");
    try {
      assertUploadAccount(user?.id ?? null, controller.signal);
      setIsUploading(true);

      for (let i = 0; i < files.length; i++) {
        assertUploadAccount(user?.id ?? null, controller.signal);
        const formData = new FormData();
        formData.append("session_id", sid);
        // A retry keeps the same server-side filename, so it replaces only the
        // interrupted slice instead of creating a duplicate in the DICOM series.
        formData.append("slice_index", String(i));
        formData.append("file", files[i]);
        // Retried like NIfTI chunks, and it matters more here: a DICOM folder
        // has no IndexedDB copy, so a blip on any one slice means re-picking
        // the folder and starting over.
        const res = await postWithRetry(`${API_BASE}/api/upload-dicom-slice`, {
          method: "POST",
          credentials: "include",
          headers: { "X-Upload-Owner": user?.id ?? "" },
          body: formData,
          signal: controller.signal,
        });
        if (res.status === 413)
          throw new TooLargeError("A slice in this folder is too large for the server to accept.");
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "DICOM slice upload failed");
        bytesSentRef.current += files[i].size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - files[i].size),
        );
      }

      assertUploadAccount(user?.id ?? null, controller.signal);
      setMessage("Converting DICOM series to NIfTI...");
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-dicom`, {
        method: "POST",
        credentials: "include",
        headers: { "X-Upload-Owner": user?.id ?? "" },
        signal: controller.signal,
        body: new URLSearchParams({ session_id: sid }),
      });
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok)
        throw uploadReplyError(finalizeRes, finalizeData, "DICOM conversion failed");
      const uploadedName = finalizeData.uploaded_filename || "ct.nii.gz";

      foregroundUploadSidRef.current = null;
      setIsUploading(false);

      // Conversion is complete. Preserve Run's choices across a reload before admission.
      await savePendingUpload({ sessionId: sid, file: new Blob(), filename: uploadedName,
        model, pipeline: selection, bdmapId: "", totalChunks: 0, nextChunk: 0, uploadedFilename: uploadedName });
      await dispatchInference(sid, model, uploadedName, true, selection, true);
    } catch (err) {
      // A user cancel aborts our fetches - cancelRun already set the card to
      // Cancelled, so don't overwrite that with Failed.
      if (controller.signal.aborted || runCancelled(sid)) {
        clearRunMessage("Converting DICOM series to NIfTI...");
        return;
      }
      console.error(err);
      setPhase(sid);
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
      if (err instanceof SignedOutError) {
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled", user?.id ?? null));
        setMessage(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return;
      }
      setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
      // The server's text is written for API clients; the page says why in
      // plain words, and never to send a slice the server refuses as too large.
      const next = err instanceof TooLargeError ? "" : " Select the folder again and press Run.";
      setMessage(`DICOM upload failed. ${uploadFailureReason(err)}${next}`);
    } finally {
      controller.abort();
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  /* ── Run inference ── */
  // Queue one scan's upload/inference. Shared by single and batch runs. The
  // upload itself waits its turn on uploadChainRef - only one file is on the
  // wire at a time - so every scan can drive the foreground progress bar when
  // it gets there, without two of them fighting over it.
  const startScanRun = async (
    item: SelectedItem,
    model: string,
    selection: InferenceSelection,
    batch?: { batchId: string; batchLabel: string },
    previews?: PipelinePreviewSelection,
  ) => {
    if (!isUploadAccountCurrent(user?.id ?? null)) return;
    if (item.kind === "sample" && item.sample.ownerId !== user?.id) return;
    // A NIfTI file already has a background upload in flight (or finished) if
    // one was started at selection time - reuse its session id and skip
    // straight to waiting on it instead of re-uploading from scratch.
    let pre = item.kind === "nifti" ? itemUploadRef.current.get(item.id) : undefined;
    if (pre && itemUploadStatus[item.id] === "failed") {
      // A failed background transfer cannot be reused. Run retries from the
      // still-local file with a new session instead of consuming its null result.
      pre.cancel();
      itemUploadRef.current.delete(item.id);
      pre = undefined;
    }
    const sid = item.kind === "sample" ? item.sample.sessionId : pre?.sid ?? crypto.randomUUID();
    // Held until this run's upload and run request are over, so a page mounted
    // meanwhile (the user left /upload and came back) leaves it alone.
    const release = holdSession(sid);
    const ts = Date.now();
    setFocusedRunId(batch?.batchId ?? sid);
    // Keep the raw filename for reference, but name the scan meaningfully by
    // default (model + date); the user can rename it later.
    const sourceName = selectedItemName(item) || undefined;
    const label = friendlyScanName(model, ts);
    const fileSizeBytes =
      item.kind === "dicom"
        ? item.files.reduce((sum, f) => sum + f.size, 0)
        : item.kind === "sample" ? item.sample.size : item.file.size;
    sessionFileSizeRef.current.set(sid, fileSizeBytes);
    saveScanTiming(sid, { sizeBytes: fileSizeBytes });

    track("upload_start_inference");
    setRecentUploads(
      addRecentUpload({
        sessionId: sid,
        label,
        sourceName,
        model,
        pipeline: selection,
        ...previews,
        status: "Processing",
        timestamp: ts,
        isReconstruction: model === "OpenVAE",
        batchId: batch?.batchId,
        batchLabel: batch?.batchLabel,
      }, user?.id ?? null),
    );

    if (item.kind === "sample") {
      try {
        // Claim the existing server copy before any await or unmount cleanup.
        // The durable record resumes admission with its reference, never bytes.
        stagedSamplesRef.current.delete(item.sample.sessionId);
        setPhase(sid, "admitting");
        await savePendingUpload({ sessionId: sid, file: new Blob(), filename: item.sample.filename,
          model, pipeline: selection, bdmapId: item.sample.bdmapId, totalChunks: 0, nextChunk: 0,
          uploadedFilename: item.sample.uploadedFilename });
        if (!isUploadAccountCurrent(item.sample.ownerId)
          || loadRecentUploads(item.sample.ownerId).find((upload) => upload.sessionId === sid)?.status !== "Processing") {
          // A late IndexedDB write must not resurrect a cancelled or signed-out
          // sample. No admission request has been sent at this point.
          await deletePendingUpload(sid);
          updateRecentUploadStatus(sid, "Cancelled", item.sample.ownerId);
          void releaseStagedSample(sid, item.sample.ownerId);
          return;
        }
        await dispatchInference(sid, model, item.sample.uploadedFilename, false, selection);
        return;
      } finally {
        release();
      }
    }

    if (pre) {
      pre.claimed = true;
      itemUploadRef.current.delete(item.id);
      setItemUploadStatus((prevStatus) => {
        if (!(item.id in prevStatus)) return prevStatus;
        const { [item.id]: _dropped, ...rest } = prevStatus;
        return rest;
      });
      setItemUploadProgress((prevProgress) => {
        if (!(item.id in prevProgress)) return prevProgress;
        const { [item.id]: _dropped, ...rest } = prevProgress;
        return rest;
      });
      setPhase(sid, "uploading"); // harmless if the background upload already finished
      const file = item.kind === "nifti" ? item.file : null;
      void (async () => {
        const uploadedName = await pre.uploadDone;
        if (!isUploadAccountCurrent(user?.id ?? null)) {
          // Signed out (or another account signed in) while this waited, which
          // stopped the transfer. Keep a resumable copy, as an upload cut short
          // the same way keeps its own, so the account's next sign-in carries on
          // with the run instead of failing a card that has nothing behind it.
          if (file) await savePendingUpload(uploadedName
            ? { sessionId: sid, file: new Blob(), filename: uploadedName, model, pipeline: selection,
              bdmapId: "", totalChunks: 0, nextChunk: 0, uploadedFilename: uploadedName }
            : { sessionId: sid, file, filename: file.name, model, pipeline: selection, bdmapId: "",
              totalChunks: Math.ceil(file.size / CHUNK_SIZE), nextChunk: 0, chunkSize: CHUNK_SIZE });
          return;
        }
        if (!uploadedName) {
          // Cancel aborts this same upload (same session id): that run is over,
          // so it is neither retried nor relabelled Failed.
          if (runCancelled(sid)) return;
          // The background upload failed, but the file is still in hand: send it
          // again through the resumable path under the same session instead of
          // failing a run that was just asked for. runUpload says why if this
          // fails too.
          if (file) {
            const retry: PendingUpload = { sessionId: sid, file, filename: file.name, model, pipeline: selection,
              bdmapId: "", totalChunks: Math.ceil(file.size / CHUNK_SIZE), nextChunk: 0, chunkSize: CHUNK_SIZE };
            const resumable = await savePendingUpload(retry);
            uploadRemainingRef.current.set(sid, file.size);
            setPhase(sid, "waiting");
            await enqueueUpload(() => {
              uploadResumableRef.current = resumable;
              return runUpload(retry, true);
            }, undefined, sid);
            return;
          }
          setPhase(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed", user?.id ?? null));
          return;
        }
        await savePendingUpload({ sessionId: sid, file: new Blob(), filename: uploadedName,
          model, pipeline: selection, bdmapId: "", totalChunks: 0, nextChunk: 0, uploadedFilename: uploadedName });
        await dispatchInference(sid, model, uploadedName, false, selection);
      })().finally(release);
      return;
    }

    // Sits behind other files on the upload chain until its turn.
    setPhase(sid, "waiting");

    // The caller clears the whole selection before looping, so there's nothing to
    // consume here. A DICOM folder uploads its slices and converts server-side; a
    // NIfTI file rides the resumable path (stashed in IndexedDB so an interrupted
    // upload can resume). Reached only when no background upload was already
    // started for this item (e.g. it was selected while the model was "None").
    if (item.kind === "dicom") {
      const bytes = item.files.reduce((sum, f) => sum + f.size, 0);
      uploadRemainingRef.current.set(sid, bytes);
      void enqueueUpload(() => runDicomUpload(sid, item.files, model, selection), undefined, sid).then(release);
      return;
    }

    const file = item.file;
    const pending: PendingUpload = {
      sessionId: sid,
      file,
      filename: file.name,
      model,
      pipeline: selection,
      bdmapId: "",
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    };
    const resumable = await savePendingUpload(pending);
    uploadRemainingRef.current.set(sid, file.size);
    void enqueueUpload(() => {
      // Set when this file actually starts, not when it was queued - otherwise
      // the last file in a batch would decide the unload warning for all of them.
      uploadResumableRef.current = resumable;
      return runUpload(pending, true);
    }, undefined, sid).then(release);
  };

  const handleRunEpaiInference = async () => {
    const items = selectedItems;
    const first = items[0] ?? null;

    // "None" model = view only: open the scan in its full local viewer, nothing is
    // uploaded or run. DICOM opens the /dicom viewer, NIfTI the /local-nifti viewer.
    if (selectedModel === "None") {
      if (!first) { setSelectionMessage("Select a scan to view first."); return; }
      // View opens one viewer: it used to open the first scan and say nothing
      // about the others.
      if (items.length > 1) { setSelectionMessage(VIEW_ONE_SCAN_MESSAGE); return; }
      if (first.kind === "sample") {
        if (!ensureAccount() || first.sample.ownerId !== user?.id) return;
        navigate(`/case/${encodeURIComponent(itemToId({ case_id: first.sample.caseId }))}`);
      } else if (first.kind === "dicom") {
        setLocalDicomFiles(first.files);
        navigate("/dicom");
      } else {
        setLocalNiftiFile(first.file);
        navigate("/local-nifti");
      }
      return;
    }

    if (!ensureAccount()) return;
    if (!first) {
      setSelectionMessage("Select a file to upload first.");
      return;
    }

    // Before anything uploads: the server would refuse a locked model with a
    // 402 only after the whole CT had been sent.
    if (modelLocked(selectedModel)) {
      const opt = MODEL_OPTIONS.find((m) => m.id === selectedModel);
      setUpgradeBlock({ reason: "model_locked", feature: opt?.label ?? selectedModel, plan: plan as PlanId });
      return;
    }

    // Caught here rather than per-file, so a plan that runs one scan at a time
    // says so before anything uploads instead of accepting the first and
    // rejecting the rest one 402 at a time.
    const slots = maxConcurrentScans(plan as PlanId);
    const running = recentUploads.filter((u) => u.status === "Processing").length;
    if (items.length + running > slots) {
      setUpgradeBlock({
        reason: "concurrent_scans", limit: slots, used: running, requested: items.length, plan: plan as PlanId,
      });
      return;
    }

    // Same for a daily allowance already spent: say so before the CT is sent.
    const spent = dailyScansBlock(items.length);
    if (spent) { setUpgradeBlock(spent); return; }

    const model = selectedModel;
    if (!openVaeUiPreview && pipeline.preprocessing && modelLocked(pipeline.preprocessing)) {
      setUpgradeBlock({ reason: "model_locked", feature: pipeline.preprocessing, plan: plan as PlanId }); return;
    }
    if (!shapeKitUiPreview && pipeline.postprocessing && !canPostprocess(plan)) {
      setUpgradeBlock({ reason: "postprocessing", feature: pipeline.postprocessing, plan: plan as PlanId }); return;
    }
    const previews: PipelinePreviewSelection = {
      ...(openVaeUiPreview && pipeline.preprocessing === "OpenVAE" ? { preprocessingPreview: "OpenVAE" } : {}),
      ...(shapeKitUiPreview && pipeline.postprocessing === "ShapeKit" ? { postprocessingPreview: "ShapeKit" } : {}),
    };
    const selection: InferenceSelection = { ...pipeline, preprocessing: openVaeUiPreview ? null : pipeline.preprocessing,
      postprocessing: shapeKitUiPreview ? null : pipeline.postprocessing,
      ...(model === "LesionSegmenter" ? { lesionTarget } : {}) };
    setInferenceCompleted(false);

    setFreshWorkspace(false);

    // Multiple selected scans run together as one batch (shared id + label). A
    // single scan runs on its own with no batch metadata.
    const batch =
      items.length > 1
        ? { batchId: crypto.randomUUID(), batchLabel: `${items.length} scans` }
        : undefined;
    // This run claims the drop zone's status slot - a single scan uses
    // sessionId/inferenceCompleted for that (set inside startScanRun), a
    // batch uses this ref. Either way, starting a new run releases whatever
    // the slot was previously showing.
    trackedBatchIdRef.current = batch ? batch.batchId : null;

    // Snapshot then clear the selection, and queue every scan's run. Each lands
    // on the upload chain in selection order and is dispatched to the GPU queue
    // as soon as its own upload finishes.
    setSelectedItems([]);
    clearSelectionMessage();
    for (const item of items) {
      await startScanRun(item, model, selection, batch, previews);
    }
  };

  const showDownloadMessage = (text: string) => {
    setMessage(text);
    setDownloadMessage(text);
  };

  // A shared lock also prevents a batch and an individual download competing
  // for browser memory. Ref assignment closes the gap before React rerenders.
  const runDownload = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (downloadAbortRef.current || !ensureAccount()) return;
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setDownloadBusy(true);
    showDownloadMessage("Preparing download...");
    const timeout = window.setTimeout(() => controller.abort(), 180_000);
    try {
      await task(controller.signal);
    } catch (err) {
      showDownloadMessage(controller.signal.aborted
        ? "Download interrupted. Please retry or download each scan individually."
        : "Download failed: " + (err instanceof Error ? err.message : "Please retry."));
      // The sign-in lapsed while the page still showed it: offer it again.
      if (err instanceof SignedOutError) promptAuth();
    } finally {
      window.clearTimeout(timeout);
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
      setDownloadBusy(false);
    }
  };

  // Download one completed scan's result zip from a card or batch details.
  const downloadResult = (sid: string) => runDownload(async (signal) => {
      const statusRes = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
        credentials: "include",
        signal,
      });
      if (statusRes.status === 401) throw new SignedOutError(SIGN_IN_TO_DOWNLOAD);
      const statusData = await parseApiResponse(statusRes);
      if (!statusRes.ok)
        throw new Error(
          statusData.error || statusData.status || "Status check failed",
        );
      if (statusData.status !== "completed") {
        showDownloadMessage(
          `Status: ${statusData.status || "unknown"}. Please wait until completed.`,
        );
        return;
      }
      stopPolling(sid);

      const resultRes = await fetch(`${API_BASE}/api/get_result/${sid}`, {
        credentials: "include",
        signal,
      });
      if (resultRes.status === 401) throw new SignedOutError(SIGN_IN_TO_DOWNLOAD);
      if (resultRes.status !== 200) {
        const maybeJson = await parseApiResponse(resultRes);
        throw new Error(maybeJson?.error || "Failed to download result zip");
      }
      const blob = await resultRes.blob();
      signal.throwIfAborted();
      startBlobDownload(blob, `bodymaps_results_${sid}.zip`);
      showDownloadMessage(
        "Download started: result archive includes the files produced by this run.",
      );
  });

  // Every selected completed scan must be retrieved before any ZIP is offered.
  const downloadBatch = (uploads: RecentUpload[]) => runDownload(async (signal) => {
    const { blob, count } = await createBatchArchive(uploads, {
      apiBase: API_BASE,
      signal,
      onProgress: (done, total) => showDownloadMessage(`Preparing batch: ${done} of ${total} completed results received.`),
    });
    startBlobDownload(blob, `bodymaps_batch_results_${new Date().toISOString().slice(0, 10)}.zip`);
    showDownloadMessage(`Download started: ${count} completed scan${count === 1 ? "" : "s"}, with one result ZIP per scan.`);
  });

  const handleRunEpaiOnReconstruction = async () => {
    if (!ensureAccount() || !isUploadAccountCurrent(user?.id ?? null)) return;
    if (!sessionId) {
      setMessage("No completed reconstruction session to run ePAI on.");
      return;
    }
    const newSessionId = crypto.randomUUID();
    setInferenceCompleted(false);
    setMessage("Starting ePAI inference on reconstructed CT...");

    try {
      const data = await requestReconstructionInference({
        apiBase: API_BASE, ownerId: user?.id ?? null, sessionId: newSessionId,
        sourceSessionId: sessionId, parseResponse: parseApiResponse,
      });

      const sid = data.session_id || newSessionId;
      setSessionId(sid);
      setSelectedModel("ePAI" as const);
      setMessage(`ePAI inference started on reconstructed CT. Session: ${sid}`);
      if (sid) {
        setRecentUploads(
          addRecentUpload({
            sessionId: sid,
            label: "ePAI on reconstruction",
            model: "ePAI",
            status: "Processing",
            timestamp: Date.now(),
          }, user?.id ?? null),
        );
        startInferencePolling(sid, "ePAI");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error(err);
      setMessage(
        `ePAI couldn't be started on the reconstruction. ${serverFailureReason(err, "The server couldn't start it.")} Try again.`,
      );
    }
  };

  /* ── Render ── */
  const previewItem = selectedItems.find((i) => i.id === previewItemId) ?? null;
  // Whole-box "done" state: every selected NIfTI has finished uploading, and
  // there's at least one NIfTI item (a DICOM-only or empty selection has
  // nothing to have finished, so it stays neutral rather than reading as a
  // false "done").
  const niftiItems = selectedItems.filter((i) => i.kind === "nifti" || i.kind === "sample");
  const allUploadsDone =
    niftiItems.length > 0 &&
    niftiItems.every((i) => i.kind === "sample" || itemUploadStatus[i.id] === "done");

  // Hoisted above the JSX (rather than computed further down where these were
  // originally rendered) so the dropzone can show in-flight runs itself once
  // Run has been clicked, instead of a separate card appearing lower on the
  // page - the same box that took the upload keeps showing its status.
  const groups = groupUploads(recentUploads);
  const inFlight = groups.filter(isGroupInFlight);
  const closeNote = closeInfo.active
    ? closeInfo.eta === null
      ? "keep tab open"
      : `safe to close in ${formatEta(closeInfo.eta)}`
    : "safe to close";

  // The batch currently claiming the drop zone's status slot (see
  // trackedBatchIdRef), once it's fully resolved (no scan in it still
  // Processing). Single-scan completion uses sessionId/inferenceCompleted
  // instead - resolved separately below, right where it's rendered.
  const trackedBatchId = trackedBatchIdRef.current;
  const activeBatchGroup = trackedBatchId
    ? groups.find((g) => g.kind === "batch" && g.batchId === trackedBatchId)
    : undefined;
  const activeBatchCompleted =
    activeBatchGroup && activeBatchGroup.kind === "batch" && !isGroupInFlight(activeBatchGroup)
      ? activeBatchGroup
      : undefined;
  // finishSession sets sessionId/inferenceCompleted for EVERY finished scan,
  // batch members included (the last one to finish wins) - so this only
  // counts as "a single scan just finished" when that session isn't part of
  // a batch, letting the batch branch above take it instead.
  // The flags are loose and outlive the scan they were set for (a later run's
  // dispatch sets sessionId without clearing inferenceCompleted), so the card
  // also needs that scan itself to be Completed, not failed or cancelled.
  const completedUpload = recentUploads.find((upload) => upload.sessionId === sessionId);
  const singleCompletedVisible =
    inferenceCompleted && completedUpload?.status === "Completed" && !completedUpload.batchId;

  // Completed Uploads (below) lists everything finished-and-unviewed - EXCEPT
  // whatever the drop zone itself is currently showing as just-completed, so
  // that scan/batch doesn't appear twice on the page at once. It reappears
  // there normally once its drop-zone slot is released.
  const { recent: finished, older } = splitByAge(
    groups.filter((g) => {
      if (isGroupInFlight(g)) return false;
      if (activeBatchCompleted && g.kind === "batch" && g.batchId === activeBatchCompleted.batchId) return false;
      if (singleCompletedVisible && g.kind === "single" && g.upload.sessionId === sessionId) return false;
      return true;
    }),
  );

  // ── A single in-flight scan (not part of a batch) ──
  const renderProcessingCard = (u: RecentUpload) => <WorkspaceRunCard
    key={u.sessionId} upload={u} phase={sessionPhases[u.sessionId]} queuePosition={queuePositions[u.sessionId]}
    closeNote={sessionPhases[u.sessionId] === "admission-pending" ? "The server has your upload. Retry start here to reconnect without uploading again." : closeNote}
    estimate={sessionPhases[u.sessionId] === "running" && etaInputs[u.sessionId] && !u.pipeline?.preprocessing && !u.pipeline?.postprocessing ? estimateRemaining(
      u.model || "", etaInputs[u.sessionId].startedAt,
      etaInputs[u.sessionId].sizeBytes, durationEstimates[u.sessionId],
    ) : undefined}
    actions={<>{sessionPhases[u.sessionId] === "admission-pending" && <button type="button" onClick={() => void retryAdmission(u.sessionId)}>Retry start</button>}
      <button type="button" className="active-cancel-btn" onClick={() => cancelRun(u)}>Cancel</button></>}
  />;

  const singleCompletedCard = singleCompletedVisible && completedUpload && <WorkspaceRunCard
    key={completedUpload.sessionId} upload={completedUpload}
    actions={<>
      <button type="button" onClick={() => {
        setRecentUploads(markRecentUploadViewed(sessionId));
        navigate(`/${completedUpload.isReconstruction ? "reconstruction" : "session"}/${encodeURIComponent(sessionId)}`);
      }}>{completedUpload.isReconstruction ? "View Reconstruction" : "View Visualization"}</button>
      {completedUpload.isReconstruction && <button type="button" onClick={handleRunEpaiOnReconstruction}>Run ePAI on Result</button>}
      <button type="button" disabled={downloadBusy} onClick={() => downloadResult(sessionId)}>Download Results</button>
    </>}
  />;

  // ── A batch's finished state, same idea: the ProcessingSummaryBar that
  // showed its progress just relabels itself instead of being replaced by
  // something else. No Cancel button (nothing left to cancel); View details
  // also releases the slot, so the box returns to normal once it's been seen. ──
  const groupId = (group: UploadGroup) => group.kind === "single" ? group.upload.sessionId : group.batchId;
  const visibleIds = new Set([...inFlight.map(groupId), ...finished.map(groupId),
    ...(singleCompletedVisible ? [sessionId] : []), ...(activeBatchCompleted ? [activeBatchCompleted.batchId] : [])]);
  const workspaceGroups = groups.filter((group) => visibleIds.has(groupId(group)));
  const focusedIndex = Math.max(0, workspaceGroups.findIndex((group) => groupId(group) === focusedRunId));
  const focusedGroup = freshWorkspace ? undefined : workspaceGroups[focusedIndex];
  const currentModelInfo = MODEL_OPTIONS.find((model) => model.id === selectedModel) ?? MODEL_OPTIONS[0];
  const openSession = (upload: RecentUpload) => {
    if (upload.status !== "Completed") return;
    setRecentUploads(markRecentUploadViewed(upload.sessionId));
    navigate(`/${upload.isReconstruction ? "reconstruction" : "session"}/${encodeURIComponent(upload.sessionId)}`);
  };
  const renderWorkspaceGroup = (group: UploadGroup) => {
    if (group.kind === "single") {
      const upload = group.upload;
      if (upload.status === "Processing") return renderProcessingCard(upload);
      if (singleCompletedVisible && upload.sessionId === sessionId) return singleCompletedCard;
      return <WorkspaceRunCard key={upload.sessionId} upload={upload} actions={<>
        {upload.status === "Completed" && <><button type="button" onClick={() => openSession(upload)}>View</button>
          <button type="button" disabled={downloadBusy} onClick={() => downloadResult(upload.sessionId)}>Download</button></>}
        {renamingId === upload.sessionId ? <input autoFocus aria-label="Run name" value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename}
          onKeyDown={(event) => {
            // The Enter that confirms an input method's candidate is not the end of the edit.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            renameRefocusRef.current = upload.sessionId;
            if (event.key === "Enter") commitRename(); else setRenamingId(null);
          }} />
          : <button type="button" data-rename-trigger={upload.sessionId} onClick={() => startRename(upload)}>Rename</button>}
        <button type="button" onClick={(event) => {
          if (event.detail === 0) runRefocusRef.current = "run";
          setRecentUploads(removeRecentUpload(upload.sessionId));
        }}>Remove</button>
      </>} />;
    }
    const running = group.uploads.filter((upload) => upload.status === "Processing");
    const phases = running.map((upload) => sessionPhases[upload.sessionId]);
    const done = group.uploads.filter((upload) => upload.status === "Completed").length;
    const pendingStarts = running.filter((upload) => sessionPhases[upload.sessionId] === "admission-pending");
    const statusLabel = running.length
      ? phases.some((phase) => phase === "running" || phase === undefined) ? "Running…"
        : phases.some((phase) => phase === "queued") ? "Queued for GPU"
        : phases.some((phase) => phase === "admission-pending") ? "Waiting for server confirmation"
        : phases.some((phase) => phase === "admitting") ? "Starting runs…" : "Uploading…"
      : done === group.uploads.length ? activeBatchCompleted?.batchId === group.batchId ? "Inference complete" : "Batch complete" : "Finished with issues";
    return <div className="workspace-batch-status">
      <ProcessingSummaryBar title={group.label} running={running.length} done={done} statusLabel={statusLabel}
        failed={group.uploads.filter((upload) => upload.status === "Failed").length}
        cancelled={group.uploads.filter((upload) => upload.status === "Cancelled").length}
        closeNote={running.length ? closeNote : undefined} closeReady={!closeInfo.active}
        onViewDetails={() => { track("upload_open_batch_details"); setDetailsBatchId(group.batchId); trackedBatchIdRef.current = null; }}
        onCancelAll={running.length ? (event?: React.MouseEvent) => {
          if (event?.detail === 0) runRefocusRef.current = "composer";
          running.forEach((upload) => cancelRun(upload, { quiet: true }));
          // Each Cancel would say "Cancelled <its scan>" and the last one would
          // win: say it once for the whole batch instead.
          setMessage(running.length === 1 ? `Cancelled ${running[0].label}` : `Cancelled ${running.length} scans`);
        } : undefined} />
      <div className="workspace-batch-actions">
        {pendingStarts.length > 0 && <button type="button" onClick={() => pendingStarts.forEach((upload) => void retryAdmission(upload.sessionId))}>Retry pending starts</button>}
        {!running.length && <><button type="button" disabled={downloadBusy || !done} onClick={() => downloadBatch(group.uploads)}>Download completed</button>
          <button type="button" onClick={(event) => {
            if (event.detail === 0) runRefocusRef.current = "run";
            let next = recentUploads; group.uploads.forEach((upload) => { next = removeRecentUpload(upload.sessionId); }); setRecentUploads(next);
          }}>Remove batch</button></>}
      </div>
    </div>;
  };

  const filePickerActions = <div className="workspace-file-actions">
    <button type="button" className="dropzone-btn workspace-picker-action" aria-label="Select NIfTI file" data-composer-focus
      onClick={(event) => { event.stopPropagation(); fileInputRef.current?.click(); }}>
      <span className="workspace-picker-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg></span>
      Upload NIfTI
    </button>
    <button type="button" className="dropzone-btn workspace-picker-action" aria-label="Select DICOM"
      title="Choose a DICOM folder when supported, otherwise choose the DICOM slice files."
      onClick={(event) => { event.stopPropagation(); void chooseDicomFiles(); }}>
      <span className="workspace-picker-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 3 7.5l9 4.5 9-4.5z" /><path d="M3 12l9 4.5 9-4.5" /><path d="M3 16.5 12 21l9-4.5" /></svg></span>
      Upload DICOM
    </button>
    <button type="button" className="dropzone-btn workspace-picker-action workspace-sample" title="Load sample case 31 into the workspace"
      disabled={sampleLoading} aria-busy={sampleLoading} onClick={(event) => { event.stopPropagation(); void loadSample(); }}>
      <span className="workspace-picker-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6l-5.2 9.1A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.9L14 9V3" /><path d="M7.5 15h9" /></svg></span>
      Sample case
    </button>
  </div>;

  return (
    <div className={`upload-page-wrapper workspace-page${focusedGroup ? " has-runs" : ""}${previewItem ? " has-scan-preview" : ""}`}>
      <WorkspaceIntro collapsed={!!focusedGroup} />
      {/* The intro and its h1 are hidden from screen readers while a run is showing;
          the page still needs a top-level heading then. */}
      {focusedGroup && <h1 className="sr-only">Workspace</h1>}
      {/* Says how a batch this tab ran ended, once it stops running: its bar only
          changes its wording, which a screen reader does not announce. Always
          mounted so the change is heard. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {activeBatchCompleted ? batchAnnouncement(activeBatchCompleted.label, activeBatchCompleted.uploads) : ""}
      </span>

      <div className="upload-main">
        {focusedGroup && <section className="workspace-run-thread" aria-label="Current runs">
          <div className="workspace-run-navigation">
            <label htmlFor="workspace-current-run">Current run</label>
            <select id="workspace-current-run" value={groupId(focusedGroup)} onChange={(event) => setFocusedRunId(event.target.value)}>
              {workspaceGroups.map((group) => <option key={groupId(group)} value={groupId(group)}>{group.kind === "single" ? group.upload.label : group.label}</option>)}
            </select>
            <span>{focusedIndex + 1} of {workspaceGroups.length}</span>
            <button type="button" aria-label="Previous run" disabled={focusedIndex === 0} onClick={() => setFocusedRunId(groupId(workspaceGroups[focusedIndex - 1]))}>←</button>
            <button type="button" aria-label="Next run" disabled={focusedIndex === workspaceGroups.length - 1} onClick={() => setFocusedRunId(groupId(workspaceGroups[focusedIndex + 1]))}>→</button>
            <button type="button" onClick={() => navigate("/account/history")}>History</button>
          </div>
          {renderWorkspaceGroup(focusedGroup)}
        </section>}
        {focusedGroup && <div className="workspace-new-run-label">Start another run</div>}
        <div className="upload-card" data-tour="composer" id="scan-composer">
          {/* ── Drop zone ── */}
          <div
            className={`dropzone${selectedItems.length ? " has-selected-files" : ""}${isDragOver ? " drag-over" : ""}${allUploadsDone ? " dropzone--all-done" : ""}`}
            data-tour="scan-input"
            onClick={(event) => {
              // The hidden pickers live inside this box, so a programmatic
              // input.click() (Upload DICOM) bubbles up here. Ignore it, or
              // the NIfTI chooser opens over the DICOM one.
              if ((event.target as HTMLElement).tagName === "INPUT") return;
              fileInputRef.current?.click();
            }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".nii,.gz"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <input
              // Set the folder-picker attributes imperatively — passing webkitdirectory
              // as a JSX/spread prop doesn't reliably apply it, so the picker falls back
              // to single files. The IDL property is set too: engines disagree on which
              // one they read when it's applied after the element is parsed. On iOS and
              // Android none of this has any effect (no browser there can pick a folder),
              // so the picker hands back plain files — handleDicomInferenceSelect takes
              // any file list, so selecting the slices themselves works there.
              ref={(el) => {
                dicomUploadInputRef.current = el;
                if (el) {
                  el.webkitdirectory = true;
                  el.setAttribute("webkitdirectory", "");
                  el.setAttribute("directory", "");
                }
              }}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={handleDicomInferenceSelect}
            />
            <input
              ref={dicomFilesInputRef}
              type="file"
              multiple
              // Do not restrict this picker by extension: many valid DICOM
              // slices have no extension at all. addDicomFiles filters them.
              style={{ display: "none" }}
              onChange={handleDicomInferenceSelect}
            />
            {selectedItems.length === 0 ? (
              <>
                <svg
                  className="dropzone-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <div className="dropzone-text">Drop a CT scan here</div>
                <p className="workspace-format-note">NIfTI (.nii, .nii.gz) or a DICOM series</p>
              </>
            ) : (
              // ── Selected items: NIfTI files + DICOM series, each individually
              // previewable ── lives inside the dropzone itself now, so the file's
              // name/type/size sit in the same box as the picker instead of as a
              // separate row underneath it. Each chip reflects its own background
              // upload status: DICOM never pre-uploads (it starts on Run), so it
              // has no "uploading" state of its own here.
              <div
                className="file-chips"
                onClick={(e) => e.stopPropagation()}
              >
                {selectedItems.map((item) => {
                  const name = selectedItemName(item);
                  const subtext =
                    item.kind === "dicom"
                      ? `DICOM series · ${item.files.length} slice${item.files.length === 1 ? "" : "s"}`
                      : item.kind === "sample" ? `NIfTI · Sample case · ${formatBytes(item.sample.size)}` : `NIfTI · ${formatBytes(item.file.size)}`;
                  const isOpen = previewItemId === item.id;
                  const uploadStatus =
                    item.kind === "nifti" ? itemUploadStatus[item.id] : undefined;
                  const uploadPct = itemUploadProgress[item.id] ?? 0;
                  return (
                    <div
                      key={item.id}
                      className={`file-chip${isOpen ? " file-chip--active" : ""}${uploadStatus ? ` file-chip--${uploadStatus}` : ""}`}
                    >
                      <div className="file-chip-row">
                        <button type="button" className="file-chip-preview"
                          aria-label={`${isOpen ? "Hide preview for" : "Preview"} ${name}`}
                          aria-pressed={isOpen} title={isOpen ? "Hide scan preview" : "Preview scan"}
                          onClick={() => setPreviewItemId((previous) => previous === item.id ? null : item.id)}>
                          <SelectedScanThumbnail sample={item.kind === "sample" ? item.sample : undefined} />
                          <span className="file-chip-preview-caption" aria-hidden="true">{isOpen ? "Hide" : "Preview"}</span>
                        </button>
                        <span className="file-chip-text">
                          <span className="file-chip-name" title={name}>{name}</span>
                          <span className="file-chip-sub" title={subtext}>{subtext}</span>
                        </span>
                        <span className={`file-chip-status${uploadStatus === "uploading" ? " is-uploading" : uploadStatus === "failed" ? " is-failed" : ""}`} role="status"
                          title={item.kind === "sample" ? "Sample ready on the server. Inference starts when you select Run."
                            : uploadStatus === "failed" ? "Upload failed. Select Run to retry. Local preview is still available."
                            : uploadStatus === "done" ? "Uploaded to the server. Inference starts when you select Run."
                            : uploadStatus === "uploading" ? "Transferring the selected scan to the server. Inference has not started."
                            : "Selected in this browser. Inference has not started."}>
                          {uploadStatus !== "uploading" && <span className="file-chip-status-dot" aria-hidden="true" />}
                          {item.kind === "sample" ? "On server" : uploadStatus === "uploading" ? `Uploading ${uploadPct}%` : uploadStatus === "failed" ? "Upload failed" : uploadStatus === "done" ? "Uploaded" : "Ready"}
                        </span>
                        <button type="button"
                          className="file-chip-remove"
                          data-chip-remove={item.id}
                          onClick={(event) => {
                            if (event.detail === 0) {
                              const at = selectedItems.findIndex((other) => other.id === item.id);
                              chipRefocusRef.current = (selectedItems[at + 1] ?? selectedItems[at - 1])?.id ?? "";
                            }
                            removeItem(item.id);
                          }}
                          aria-label={`Remove ${name}`}
                        >
                          Remove
                        </button>
                      </div>
                      {uploadStatus === "uploading" && (
                        <div className="file-chip-progress-track" role="progressbar" aria-label={`Uploading ${name}`}
                          aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPct}>
                          <div
                            className="file-chip-progress-fill"
                            style={{ width: `${uploadPct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {selectedModel === "None" && viewOnlyUploadNotice && (
              <p className="workspace-format-note" role="status">
                View only has stopped pending uploads. Uploading had already started while an AI model was selected, so some scan data may already be on the server. Switching modes cannot undo that transfer.
              </p>
            )}
            {selectedItems.length ? <details className="workspace-add-scans" onClick={(event) => event.stopPropagation()}>
              <summary data-composer-focus>Add scans</summary>
              {filePickerActions}
            </details> : filePickerActions}
          </div>

          {/* ── Pre-inference preview: inspect the selected scan before running a model.
              Not held back while a transfer is sending: Preview would flip to Hide
              and show nothing for the minutes a large CT takes. ── */}
          {previewItem && (
            <>
              <div className="ct-preview-label">
                Preview ·{" "}
                {selectedItemName(previewItem)}
              </div>
              <Suspense
                fallback={
                  <div className="ct-preview ct-preview--msg" role="status">
                    Loading preview…
                  </div>
                }
              >
                {previewItem.kind === "dicom" ? (
                  <DicomPreview files={previewItem.files} />
                ) : previewItem.kind === "sample" ? (
                  <SamplePreview key={previewItem.id} sample={previewItem.sample} />
                ) : (
                  <CtPreview file={previewItem.file} />
                )}
              </Suspense>
            </>
          )}

          {/* ── Pipeline row ── */}
          <div className="pipeline-row" data-tour="pipeline">
            {/* Step 1: Preprocessing */}
            <PipelineStepSelector stage="preprocessing" value={pipeline.preprocessing} signedOut={!isAuthenticated}
              option={preprocessingOption} model={selectedModel} locked={!openVaeUiPreview && modelLocked("OpenVAE")} previewOnly={openVaeUiPreview}
              onChange={(value) => setPipeline((current) => ({ ...current, preprocessing: value as PipelineSelection["preprocessing"] }))}
              onLocked={() => setUpgradeBlock({ reason: "model_locked", feature: "OpenVAE", plan: plan as PlanId })} />

            <div className="pipeline-arrow">→</div>

            {/* Step 2: Model */}
            <div className="pipeline-step" data-tour="model">
              <div className="pipeline-step-header">
                <div className="pipeline-badge" aria-hidden="true">2</div>
                <span className="pipeline-label">Model</span>
              </div>
              <div className="model-dropdown" ref={modelDropRef}>
                <button
                  className={`model-dropdown-btn${selectedModel && selectedModel !== "None" ? " has-value" : ""}${modelDropOpen ? " open" : ""}`}
                  onClick={() => setModelDropOpen((o) => !o)}
                  aria-expanded={modelDropOpen}
                  aria-controls={modelDropOpen ? "segmentation-options" : undefined}
                  type="button"
                >
                  <span>
                    {selectedModel === "None"
                      ? "None (view scan)"
                      : selectedModel === "LesionSegmenter"
                        ? `LesionSegmenter: ${
                            LESION_OPTIONS.find((l) => l.id === lesionTarget)
                              ?.label ?? "Pancreatic lesion"
                          }`
                        : MODEL_OPTIONS.find((m) => m.id === selectedModel)
                            ?.label || "Select a model"}
                  </span>
                  <svg
                    className={`model-dropdown-chevron${modelDropOpen ? " rotated" : ""}`}
                    width="10"
                    height="6"
                    viewBox="0 0 10 6"
                    fill="none"
                  >
                    <path
                      d="M1 1l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {modelDropOpen && (
                  <div className="model-dropdown-menu" id="segmentation-options">
                    {MODEL_OPTIONS.map((m) => {
                      // Locked models stay visible with an "Upgrade" pill rather
                      // than being hidden — you can't want what you can't see,
                      // and ChatGPT's model picker works the same way.
                      const locked = modelLocked(m.id);
                      const hasSubmenu = !locked && m.id === "LesionSegmenter";
                      return (
                      <div
                        key={m.id}
                        role="button"
                        tabIndex={0}
                        aria-current={!locked && selectedModel === m.id ? "true" : undefined}
                        onKeyDown={hasSubmenu ? focusLesionChoice : activateOption}
                        className={`model-dropdown-item${selectedModel === m.id ? " selected" : ""}${locked ? " locked" : ""}${hasSubmenu ? " has-submenu" : ""}`}
                        onClick={() => {
                          if (locked) {
                            setModelDropOpen(false); modelDropRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                            setUpgradeBlock({
                              reason: "model_locked", feature: m.label, plan: plan as PlanId,
                            });
                            return;
                          }
                          if (hasSubmenu) return;
                          track("upload_select_model");
                          modelTouchedRef.current = true;
                          setSelectedModel(m.id as typeof selectedModel);
                          setModelDropOpen(false); modelDropRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                        }}
                      >
                        <div className="model-dropdown-item-content">
                          <span className="model-dropdown-item-name">
                            {m.label}
                          </span>
                          <span className="model-dropdown-item-desc">
                            {m.desc}
                          </span>
                        </div>
                        <div className="model-dropdown-item-side">
                          {locked && <span className="model-dropdown-lock">Donate</span>}
                          {hasSubmenu ? (
                            <svg
                              className="model-submenu-arrow"
                              width="7"
                              height="10"
                              viewBox="0 0 7 10"
                              fill="none"
                            >
                              <path
                                d="M1 1l4 4-4 4"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : (
                            !locked && selectedModel === m.id && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              className="model-dropdown-check"
                            >
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            )
                          )}
                        </div>
                        {hasSubmenu && (
                          <div className="model-submenu" role="menu">
                            {LESION_OPTIONS.map((l) => {
                              // lesionTarget keeps whatever it was last set to even
                              // when a different model is active (it defaults to
                              // "pancreatic" and there's no reason to clear it just
                              // because the user picked ePAI) - so the checkmark
                              // must also confirm LesionSegmenter is the SELECTED
                              // model, not just that this is the remembered target.
                              // Without the first half, "Pancreatic lesion" showed
                              // checked here even while ePAI was the active model.
                              const isChecked =
                                selectedModel === "LesionSegmenter" && lesionTarget === l.id;
                              return (
                              <div
                                key={l.id}
                                role="menuitemradio"
                                tabIndex={0}
                                onKeyDown={activateOption}
                                aria-checked={isChecked}
                                className={`model-submenu-item${isChecked ? " selected" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  modelTouchedRef.current = true;
                                  setSelectedModel("LesionSegmenter");
                                  setLesionTarget(l.id);
                                  setModelDropOpen(false); modelDropRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                                }}
                              >
                                <span className="model-submenu-check">
                                  {isChecked && (
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                    >
                                      <path
                                        d="M2 6l3 3 5-5"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </span>
                                <span className="model-submenu-label">
                                  {l.label}
                                </span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      );
                    })}
                    {isAuthenticated && modelLocked("ePAI") && (
                      <div className="model-dropdown-access" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="model-dropdown-access__toggle"
                          aria-expanded={couponOpen}
                          aria-controls={couponOpen ? "admin-access-coupon-form" : undefined}
                          onClick={() => {
                            setCouponOpen((open) => !open);
                            setCouponError(null);
                          }}
                        >
                          Have an admin access coupon?
                        </button>
                        {couponOpen && (
                          <form
                            id="admin-access-coupon-form"
                            className="model-dropdown-access__form"
                            onSubmit={submitAdminCoupon}
                            onPointerDown={() => { couponByPointerRef.current = true; }}
                            onKeyDown={() => { couponByPointerRef.current = false; }}
                          >
                            <label htmlFor="admin-access-coupon">Access coupon</label>
                            <div className="model-dropdown-access__row">
                              <input
                                ref={couponInputRef}
                                id="admin-access-coupon"
                                type="password"
                                value={couponValue}
                                onChange={(event) => setCouponValue(event.target.value)}
                                placeholder="Enter coupon"
                                autoComplete="off"
                                disabled={couponBusy}
                              />
                              <button type="submit" disabled={couponBusy || !couponValue.trim()}>
                                {couponBusy ? "Checking…" : "Unlock"}
                              </button>
                            </div>
                            {couponError && <p role="alert">{couponError}</p>}
                            <small>Access is verified by the server and does not grant admin controls.</small>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="pipeline-arrow">→</div>

            {/* Step 3: Postprocessing */}
            <PipelineStepSelector stage="postprocessing" value={pipeline.postprocessing} signedOut={!isAuthenticated}
              option={postprocessingOption} model={selectedModel} locked={!shapeKitUiPreview && !canPostprocess(plan)} previewOnly={shapeKitUiPreview}
              onChange={(value) => setPipeline((current) => ({ ...current, postprocessing: value as PipelineSelection["postprocessing"] }))}
              onLocked={() => setUpgradeBlock({ reason: "postprocessing", feature: "ShapeKit", plan: plan as PlanId })} />

            <button
              className="run-btn"
              data-tour="run"
              onClick={handleRunEpaiInference}
              // Not gated on isUploading: that flag now also covers background
              // pre-uploads (started the moment a file is selected, before Run
              // is even clickable), and Run needs to stay clickable while one
              // is in flight - handleRunEpaiInference's own empty-selection
              // check is what prevents a double-submit, not this.
              disabled={!selectedModel}
            >
              {selectedModel === "None" ? "View" : "Run"}
            </button>
          </div>

          {/* Check Status removed (auto-polling covers it); Download now lives on
              completed entries in Completed Uploads, not as an always-on button.
              The old "Upload Progress" bar is gone too - uploads now start at
              selection time and finish well before Run is usually clicked, so a
              dedicated progress bar here was rarely seen and added a layout jump
              when it briefly appeared. The Active card below still reflects
              "Uploading…" phase for anyone who clicks Run while it's in flight. */}

          {/* ── Status messages (errors / transient feedback only) ──
              The live region stays in the page and only its content comes and
              goes, so screen readers announce each new message. */}
          <div role="status" aria-live="polite">{message && <div className="status-msg">{message}</div>}</div>
          <div className="workspace-selected-model" aria-live="polite">
            <div className="workspace-model-symbol" aria-hidden="true">✧</div>
            <div><strong>{selectedModel === "None" ? "View only" : selectedModel || "Choose a model"}</strong>
              <p>{MODEL_OPTIONS.find((model) => model.id === selectedModel)?.desc || "Select a model to see its capabilities."}</p>
              {selectedModel === "LesionSegmenter" && <small>Primary result: {LESION_OPTIONS.find((lesion) => lesion.id === lesionTarget)?.label}</small>}
            </div>
            <button ref={modelInfoButton} type="button" className="workspace-additional-info" aria-haspopup="dialog" aria-expanded={modelInfoOpen} onClick={() => setModelInfoOpen(true)}>Additional info <span aria-hidden="true">⌃</span></button>
          </div>
        </div>

        {/* ── Sign-in prompt (signed-out only, not while the session is still being checked) ── */}
        {!isAuthenticated && !authLoading && (
          <div className="upload-account-banner">
            <span>
              <button type="button" className="upload-account-link" onClick={() => promptAuth()}>
                Sign in
              </button>{" "}
              to run inference.
            </span>
          </div>
        )}

        {older.length > 0 && <button type="button" className="upload-history-link" onClick={() => navigate("/account/history")}>{older.length} {older.length === 1 ? "run" : "runs"} in History →</button>}

        {modelInfoOpen && <div className="workspace-info-backdrop" onClick={() => setModelInfoOpen(false)}>
          <div ref={modelInfoDialog} className="workspace-info-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-model-info-title" onClick={(event) => event.stopPropagation()}>
            <div className="workspace-info-heading"><div><span>Additional info</span><h2 id="workspace-model-info-title">{currentModelInfo.label === "None" ? "View only" : currentModelInfo.label}</h2></div>
              <button type="button" aria-label="Close additional info" onClick={() => setModelInfoOpen(false)}>×</button></div>
            <p>{currentModelInfo.desc}</p>
            {currentModelInfo.quickFacts && <dl className="workspace-model-facts">{currentModelInfo.quickFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
            <ul>{currentModelInfo.details?.map((detail) => <li key={detail}>{detail}</li>)}</ul>
            {selectedModel === "LesionSegmenter" && <p>Primary result: {LESION_OPTIONS.find((lesion) => lesion.id === lesionTarget)?.label}. All supported lesions are computed in one pass.</p>}
          </div>
        </div>}

        <UpgradeDialog block={upgradeBlock} onClose={() => setUpgradeBlock(null)} />

        {/* Batch "View details" popup */}
        {(() => {
          if (!detailsBatchId) return null;
          const uploads = recentUploads.filter(u => u.batchId === detailsBatchId);
          if (uploads.length === 0) return null;
          const label = uploads[0].batchLabel || `${uploads.length} scans`;
          return (
            <BatchDetailsModal
              label={label}
              uploads={uploads}
              phases={sessionPhases}
              onClose={() => setDetailsBatchId(null)}
              onView={(u) => {
                if (!u.viewed) setRecentUploads(markRecentUploadViewed(u.sessionId));
                navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);
              }}
              onDownloadScan={(u) => downloadResult(u.sessionId)}
              onDownloadAll={() => downloadBatch(uploads)}
              downloadBusy={downloadBusy}
              downloadMessage={downloadMessage}
            />
          );
        })()}
      </div>

    </div>
  );
};

export default UploadPage;
