#!/usr/bin/env bash
# Stage a CancerVerse update in a WRITABLE overlay folder. The dataset mount is read-only
# and owned by the dataset maintainer, so nothing here ever writes to it: the website
# prefers the overlay and falls back to the original copy (CANCERVERSE_OVERLAY_PATH).
#
#   scripts/stage_cancerverse_update.sh PLAN.tsv [OVERLAY_DIR]
#
# PLAN.tsv comes from scripts/plan_cancerverse_update.py (case_id <TAB> bytes <TAB> sha256).
# Steps, in this order, so a half-finished run never shows the site metadata for scans it
# does not have yet:
#   0. fetch the metadata CSV into OVERLAY/downloads (not published yet; a cheap early check
#      that the hub is reachable, and what the index is checked against)
#   1. download every planned CT to OVERLAY/image_only/<id>/ct.nii.gz (resumable; the file is
#      published only after its size AND sha256 match; re-running skips finished files)
#   2. download the tumor-label archive and build OVERLAY/cancerverse_case_index.json
#      (refused if the archive lacks too many of the CSV's scans, i.e. it was cut short)
#   3. build the viewer's tumor masks into OVERLAY/mask_only for the scans with an annotated tumor
#      (MAKE_MASKS=0 skips; a failure only warns: those scans open CT-only until a re-run succeeds)
#   4. draw the card thumbnails of the staged scans into OVERLAY/profile_only (MAKE_PREVIEWS=0 skips)
#   5. only if every CT succeeded: publish OVERLAY/CancerVerse_dataset_metadata.csv
# It does NOT touch .env or restart anything; the last lines say what to do next.
#
# Environment (all optional):
#   CANCERVERSE_REVISION  Hugging Face revision to read (pin a commit sha for a reproducible run)
#   MIN_FREE_GB           stop if free space would fall below this (default 300). A re-run only
#                         counts the files still missing, so resuming works on a fuller disk
#   MAX_CONSECUTIVE_FAILS stop after this many failed CT downloads in a row (default 5): a hub
#                         outage or rate limit should end the run, not sleep for days
#   MAKE_MASKS            1 (default) build the viewer tumor masks; 0 to skip
#   MAKE_PREVIEWS         1 (default) draw thumbnails for the staged scans; 0 to skip
#   LABELS_SHA256         optional sha256 the label archive must match
#   PYTHON                interpreter for the index builder (needs numpy + pandas)
#   WORKERS               index-builder processes (default 2)
#   FETCH_DELAY           seconds to pause between files (default 1, be polite to the hub)
#   RETRY_DELAY           base backoff in seconds between failed attempts (default 30)
#   DRY_RUN=1             print what would happen, change nothing
#   HF_BASE, LABELS_URL   override the download sources (used by the tests)
set -euo pipefail

PLAN="${1:?usage: $0 PLAN.tsv [OVERLAY_DIR]}"
OVERLAY="${2:-/home/visitor/cancerverse_v351}"
REVISION="${CANCERVERSE_REVISION:-main}"
HF_BASE="${HF_BASE:-https://huggingface.co/datasets/BodyMaps/CancerVerse/resolve}"
LABELS_URL="${LABELS_URL:-https://www.cs.jhu.edu/~zongwei/dataset/CancerVerse_Label.tar.gz}"
LABELS_SHA256="${LABELS_SHA256:-}"
MAX_CONSECUTIVE_FAILS="${MAX_CONSECUTIVE_FAILS:-5}"
MAKE_MASKS="${MAKE_MASKS:-1}"
MAKE_PREVIEWS="${MAKE_PREVIEWS:-1}"
MIN_FREE_GB="${MIN_FREE_GB:-300}"
PYTHON="${PYTHON:-python3}"
WORKERS="${WORKERS:-2}"
FETCH_DELAY="${FETCH_DELAY:-1}"
RETRY_DELAY="${RETRY_DELAY:-30}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[ -f "$PLAN" ] || die "plan file not found: $PLAN"
# Compare the real location, so //mnt/bodymaps, /mnt/./bodymaps and symlinks cannot slip past.
# (The read-only mount is the real protection; this is a clear early error.)
overlay_real="$(realpath -m -- "$OVERLAY" 2>/dev/null || printf '%s' "$OVERLAY")"
overlay_real="/${overlay_real#"${overlay_real%%[!/]*}"}"
case "$overlay_real" in
  /mnt/bodymaps|/mnt/bodymaps/*) die "refusing to write under the dataset mount ($OVERLAY); use a folder under your home" ;;
esac

ct_done() {  # ct_done CASE BYTES SHA: the staged file is complete and verified
  local dest="$OVERLAY/image_only/$1/ct.nii.gz"
  [ -f "$dest" ] && [ "$(wc -c < "$dest" | tr -d ' ')" = "$2" ] && [ -f "$dest.sha256" ] && [ "$(cat "$dest.sha256")" = "$3" ]
}

# Validate the plan and total up only what is still missing (a resumed run has less to fetch).
need_bytes=0; n_files=0
while IFS=$'\t' read -r case_id bytes sha || [ -n "$case_id" ]; do
  [ -n "$case_id" ] || continue
  [[ "$case_id" =~ ^CV_[0-9]+$ ]] || die "bad case id in the plan: '$case_id'"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "bad size for $case_id in the plan: '$bytes'"
  [[ "$sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "bad sha256 for $case_id in the plan"
  n_files=$((n_files + 1))
  if ! ct_done "$case_id" "$bytes" "$sha"; then need_bytes=$((need_bytes + bytes)); fi
done < "$PLAN"
free_gb() { df -Pk "$1" | awk 'NR==2 {printf "%d", $4/1048576}'; }

mkdir -p "$OVERLAY"
have=$(free_gb "$OVERLAY")
need_gb=$(( (need_bytes + 1073741823) / 1073741824 ))
log "plan: $n_files CTs, ~${need_gb} GB still to fetch; free ${have} GB on $(df -P "$OVERLAY" | awk 'NR==2 {print $1}'); keeping >= ${MIN_FREE_GB} GB free"
[ "$have" -ge $(( need_gb + MIN_FREE_GB )) ] || die "not enough free space: need ${need_gb} GB + ${MIN_FREE_GB} GB headroom, have ${have} GB"
if [ "${DRY_RUN:-0}" = "1" ]; then log "DRY_RUN: would download $n_files CTs, the label archive, build the index and publish the metadata CSV into $OVERLAY"; exit 0; fi
mkdir -p "$OVERLAY/image_only" "$OVERLAY/downloads"

fetch() {  # fetch URL DEST  (resumable, retried; DEST.part is kept between attempts)
  local url="$1" dest="$2" attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsSL -C - --retry 3 --retry-delay 10 -o "$dest.part" "$url"; then return 0; fi
    log "download failed (attempt $attempt): $url"
    [ "$attempt" -ge 3 ] && rm -f "$dest.part"     # a partial file the server cannot resume would wedge every retry
    sleep $(( attempt * RETRY_DELAY ))
  done
  return 1
}

META="$OVERLAY/downloads/CancerVerse_dataset_metadata.csv"
fetch "$HF_BASE/$REVISION/CancerVerse_dataset_metadata.csv" "$META" || die "could not download the metadata CSV"
mv "$META.part" "$META"

fail=0; done_n=0; i=0; streak=0
while IFS=$'\t' read -r case_id bytes sha || [ -n "$case_id" ]; do
  [ -n "$case_id" ] || continue
  i=$((i + 1))
  dest="$OVERLAY/image_only/$case_id/ct.nii.gz"
  if ct_done "$case_id" "$bytes" "$sha"; then
    done_n=$((done_n + 1)); continue
  fi
  mkdir -p "$(dirname "$dest")"
  if ! fetch "$HF_BASE/$REVISION/CancerVerse/$case_id/ct.nii.gz" "$dest"; then
    log "FAILED $case_id: could not download"; fail=$((fail + 1)); streak=$((streak + 1))
    [ "$streak" -lt "$MAX_CONSECUTIVE_FAILS" ] || die "$streak downloads in a row failed; stopping (re-run later to resume)"
    continue
  fi
  got_bytes=$(wc -c < "$dest.part" | tr -d ' ')
  got_sha=$(sha256sum "$dest.part" | awk '{print $1}')
  if [ "$got_bytes" != "$bytes" ] || [ "$got_sha" != "$sha" ]; then
    log "FAILED $case_id: size/sha256 mismatch (got $got_bytes bytes, $got_sha); discarding"
    rm -f "$dest.part"; fail=$((fail + 1)); streak=$((streak + 1))
    [ "$streak" -lt "$MAX_CONSECUTIVE_FAILS" ] || die "$streak downloads in a row failed; stopping (re-run later to resume)"
    continue
  fi
  mv "$dest.part" "$dest"; printf '%s' "$sha" > "$dest.sha256"
  done_n=$((done_n + 1)); streak=0
  if [ $((i % 25)) -eq 0 ]; then
    log "[$i/$n_files] ok; $(free_gb "$OVERLAY") GB free"
    [ "$(free_gb "$OVERLAY")" -ge "$MIN_FREE_GB" ] || die "free space fell below ${MIN_FREE_GB} GB; stopping (re-run later to resume)"
  fi
  sleep "$FETCH_DELAY"
done < "$PLAN"
log "CTs: $done_n of $n_files verified, $fail failed"

fetch "$LABELS_URL" "$OVERLAY/downloads/CancerVerse_Label.tar.gz" || die "could not download the label archive"
if [ -n "$LABELS_SHA256" ]; then
  got_labels=$(sha256sum "$OVERLAY/downloads/CancerVerse_Label.tar.gz.part" | awk '{print $1}')
  if [ "$got_labels" != "$LABELS_SHA256" ]; then
    rm -f "$OVERLAY/downloads/CancerVerse_Label.tar.gz.part"
    die "label archive sha256 mismatch (got $got_labels)"
  fi
fi
mv "$OVERLAY/downloads/CancerVerse_Label.tar.gz.part" "$OVERLAY/downloads/CancerVerse_Label.tar.gz"
"$PYTHON" "$HERE/build_cancerverse_index.py" --labels "$OVERLAY/downloads/CancerVerse_Label.tar.gz" \
  --metadata "$META" --out "$OVERLAY/cancerverse_case_index.json" --workers "$WORKERS" || die "building the tumor index failed"

[ "$fail" -eq 0 ] || die "$fail CT downloads failed: the metadata CSV was NOT published (re-run this script to retry)"
if [ "$MAKE_MASKS" = "1" ]; then
  log "building the viewer tumor masks (skips scans that already have one)"
  nice -n 10 "$PYTHON" "$HERE/build_cancerverse_masks.py" --labels "$OVERLAY/downloads/CancerVerse_Label.tar.gz"     --index "$OVERLAY/cancerverse_case_index.json" --out "$OVERLAY" --workers "$WORKERS"     || log "WARNING: building the tumor masks failed or was partial; those scans open CT-only until a re-run succeeds"
fi
if [ "$MAKE_PREVIEWS" = "1" ]; then
  log "drawing card thumbnails for the staged scans (skips ones that exist; re-run to retry)"
  nice -n 10 "$PYTHON" "$HERE/make_profile_previews.py" --ct-root "$OVERLAY" --out-root "$OVERLAY" \
    || log "WARNING: some thumbnails failed; those cards fall back to a placeholder until a re-run succeeds"
fi
mv "$META" "$OVERLAY/CancerVerse_dataset_metadata.csv"

log "DONE. Overlay ready at $OVERLAY"
log "Next (a deliberate step, not done here): add  CANCERVERSE_OVERLAY_PATH=$OVERLAY  to flask-server/.env,"
log "then reload the backend with the usual deploy procedure, when no job is running."
