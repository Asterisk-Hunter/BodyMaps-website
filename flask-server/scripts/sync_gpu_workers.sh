#!/usr/bin/env bash
# Mirror model runtimes from the web host (bdmap1) to the GPU workers.
#
# Workers run the SAME model commands as the web host, so they need identical
# copies of the conda envs, model weights and model source at the same
# absolute paths. Run this on bdmap1 after installing/updating a model:
#
#   flask-server/scripts/sync_gpu_workers.sh            # sync every worker
#   flask-server/scripts/sync_gpu_workers.sh --check    # report only, copy nothing
#   flask-server/scripts/sync_gpu_workers.sh --undo h   # delete what this script created on h
#   flask-server/scripts/sync_gpu_workers.sh bdmap2.wse.jhu.edu   # one host
#
# Safe by design:
#   * never deletes on a worker (except --undo, which only removes paths this
#     script itself created, as recorded in the worker's manifest);
#   * a path that already existed on a worker before this script first ran
#     there may be someone else's: it is never written to (--check compares
#     its content);
#   * lowest CPU/IO priority on both ends and a bandwidth cap, so neither the
#     website nor anyone's job on the worker is slowed;
#   * refuses the web host itself, a worker sharing this host's /home, and a
#     worker without enough free disk.
# Hosts default to GPU_WORKER_HOSTS from flask-server/.env.
set -uo pipefail

HOME_DIR=/home/visitor
BWLIMIT_KBPS="${SYNC_BWLIMIT_KBPS:-40000}"   # ~40 MB/s
MIN_FREE_GB="${SYNC_MIN_FREE_GB:-100}"       # free space required before copying
MANIFEST_DIR=.bodymaps_gpu_worker            # on the worker, under $HOME_DIR
MANIFEST="$MANIFEST_DIR/managed_paths"

# Single source of truth for what a worker needs (paths relative to $HOME_DIR).
# Only what the remote-dispatched model commands use (ShapeKit and MedIA-Agentic
# always run on the web host, so their files are not needed).
SYNC_PATHS=(
  .conda/envs/epai          # ePAI; LesionSegmenter uses CONDA_ENV_LESIONSEG
  .conda/envs/atlasnet      # Atlas-Net, LesionSegmenter
  .conda/envs/suprem
  .conda/envs/openvae
  .conda/envs/rsuper        # MedFormer, R-Super
  ePAI                      # incl. ePAI/binary (editable install in the epai env)
  nnUNet                    # editable nnunetv2 install in the epai env
  atlasnet
  lesionsegmenter
  model                     # LesionSegmenter checkpoint
  suprem_native
  openvae
  rsuper
  inference
  foqkd_work/epai_trtfp16   # TensorRT plan for the ePAI warm server
)

mode=sync
hosts=()
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --undo) mode=undo ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) hosts+=("$arg") ;;
  esac
done

if [ ${#hosts[@]} -eq 0 ]; then
  if [ "$mode" = undo ]; then
    echo "--undo needs explicit host names" >&2; exit 2
  fi
  env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
  # Tolerate CRLF, quotes and spaces in .env.
  line="$(grep -E '^GPU_WORKER_HOSTS=' "$env_file" 2>/dev/null | tail -1 | tr -d "\r\"' " || true)"
  IFS=',' read -r -a hosts <<< "${line#GPU_WORKER_HOSTS=}"
fi
if [ ${#hosts[@]} -eq 0 ] || [ -z "${hosts[0]:-}" ]; then
  echo "No hosts given and GPU_WORKER_HOSTS is not set in .env" >&2
  exit 2
fi

cd "$HOME_DIR" || exit 2
# One sync at a time.
exec 9>"/tmp/sync_gpu_workers.$(id -u).lock"
if ! flock -n 9; then
  echo "Another sync_gpu_workers.sh is already running" >&2; exit 2
fi

user="${GPU_WORKER_USER:-visitor}"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=4)
status=0
self_host="$(hostname -s)"
low_prio=(nice -n 19)
command -v ionice >/dev/null 2>&1 && low_prio+=(ionice -c3)

on_host() { ssh -n "${ssh_opts[@]}" "$user@$host" "$@"; }
# -H keeps conda's hardlinks instead of duplicating them; --no-implied-dirs
# leaves existing parent dirs (e.g. .conda/envs) untouched on the worker.
rs() {
  "${low_prio[@]}" rsync -aRH --no-implied-dirs --open-noatime --bwlimit="$BWLIMIT_KBPS" \
    --timeout=300 --rsync-path="$remote_rsync" -e "ssh ${ssh_opts[*]}" "$@"
}

for host in "${hosts[@]}"; do
  host="$(echo "$host" | xargs)"
  [ -n "$host" ] || continue
  echo "=== $host ($mode)"
  if ! remote_name="$(on_host 'hostname -s' 2>/dev/null)"; then
    echo "  UNREACHABLE (passwordless ssh from this host is required)"; status=1; continue
  fi
  if [ "$remote_name" = "$self_host" ]; then
    echo "  REFUSED: $host is this machine; workers must be other hosts"; status=1; continue
  fi
  probe="$HOME_DIR/.gpuw_sync_probe_$$_$RANDOM"
  : > "$probe"
  if on_host "test -e $probe"; then
    rm -f "$probe"
    echo "  REFUSED: $host shares this host's $HOME_DIR"; status=1; continue
  fi
  rm -f "$probe"
  remote_rsync="nice -n 19 rsync"
  on_host 'command -v ionice >/dev/null' && remote_rsync="nice -n 19 ionice -c3 rsync"
  managed="$(on_host "cat $HOME_DIR/$MANIFEST 2>/dev/null" || true)"
  is_managed() { grep -qxF "$1" <<< "$managed"; }

  if [ "$mode" = undo ]; then
    while IFS= read -r p; do
      # Only plain relative paths from our own list.
      case " ${SYNC_PATHS[*]} " in *" $p "*) ;; *) continue ;; esac
      on_host "rm -rf -- $HOME_DIR/$p" && echo "  removed $p" || { echo "  FAILED  $p"; status=1; }
    done <<< "$managed"
    on_host "rm -rf -- $HOME_DIR/$MANIFEST_DIR"
    continue
  fi

  if [ "$mode" = sync ]; then
    free_kb="$(on_host "df -Pk $HOME_DIR | awk 'NR==2{print \$4}'" 2>/dev/null || echo 0)"
    if [ "${free_kb:-0}" -lt $((MIN_FREE_GB * 1024 * 1024)) ]; then
      echo "  REFUSED: less than ${MIN_FREE_GB} GB free on $host"; status=1; continue
    fi
    on_host "mkdir -p $HOME_DIR/$MANIFEST_DIR" || { echo "  FAILED to create manifest dir"; status=1; continue; }
  fi

  for p in "${SYNC_PATHS[@]}"; do
    if [ ! -e "$p" ]; then
      echo "  skip    $p (not on this host)"; continue
    fi
    exists=0
    on_host "test -e $HOME_DIR/$p" && exists=1
    ours=0
    { [ "$exists" -eq 0 ] || is_managed "$p"; } && ours=1

    if [ "$mode" = check ]; then
      if [ "$exists" -eq 0 ]; then
        echo "  MISSING $p"; status=1; continue
      fi
      # Dry run: count files that would be copied. Our copies keep bdmap1's
      # timestamps, so size+mtime is enough (fast). Paths that are not ours are
      # compared by content (checksum flag 'c', or a missing file), since only
      # their timestamps may legitimately differ.
      if [ "$ours" -eq 1 ]; then
        n="$(rs -n -i "./$p" "$user@$host:$HOME_DIR/" 2>/dev/null | grep -cE '^[<>ch]f')"
      else
        n="$(rs -n -i --checksum "./$p" "$user@$host:$HOME_DIR/" 2>/dev/null | grep -cE '^[<>ch]f[c+]')"
      fi
      if [ "${n:-0}" -eq 0 ]; then
        echo "  ok      $p"
      elif [ "$ours" -eq 1 ]; then
        echo "  STALE   $p ($n files differ; run without --check)"; status=1
      else
        echo "  DIFFERS $p ($n files; existed before this script and is never overwritten; resolve by hand)"; status=1
      fi
      continue
    fi

    if [ "$ours" -eq 0 ]; then
      # Existed before this script ever ran here: may be someone else's. Never
      # write into it. --check reports whether its content matches.
      echo "  kept    $p (existed already, not managed by this script; untouched)"
      continue
    fi
    # Record ownership before copying, so an interrupted copy can be undone.
    is_managed "$p" || on_host "echo '$p' >> $HOME_DIR/$MANIFEST" || { status=1; continue; }
    managed+=$'\n'"$p"
    if rs "./$p" "$user@$host:$HOME_DIR/"; then
      echo "  synced  $p"
    else
      echo "  FAILED  $p"; status=1
    fi
  done
  on_host 'command -v setsid >/dev/null && command -v rsync >/dev/null && command -v nvidia-smi >/dev/null' \
    && echo "  tools   ok (setsid, rsync, nvidia-smi)" \
    || { echo "  tools   MISSING (need setsid, rsync, nvidia-smi)"; status=1; }
done
exit $status
