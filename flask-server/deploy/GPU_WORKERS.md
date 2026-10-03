# Remote GPU workers

The website runs on bdmap1. If bdmap1 reboots, the site is offline; if bdmap2-4
reboot, nothing user-facing breaks. So model inference runs on bdmap2-4 and
bdmap1's GPU is only a fallback.

## How it works

`services/gpu_workers.py`, called from `_tracked_run` in
`services/auto_segmentor.py`. For each model command:

1. Health-check every host in `GPU_WORKER_HOSTS` in parallel and pick the
   least loaded healthy one (ties keep the configured order). Healthy means:
   reachable; a working GPU that is not hot (`GPU_WORKER_MAX_TEMP_C`, 85) and
   not in a hardware or thermal slowdown; GPU use below
   `GPU_WORKER_MAX_GPU_UTIL` (20%, catches jobs whose processes are hidden,
   e.g. in containers); CPU load below `GPU_WORKER_MAX_CPU_LOAD` (0.75 per
   core); at least `GPU_WORKER_MIN_FREE_GB` (40) free memory (GB10 CPU and GPU
   share one pool); no GPU process other than our `*_warm_server.py`
   predictors; not the web host; not already running one of our jobs; and not
   in a cooldown (60 s after being unreachable, `GPU_WORKER_COOLDOWN_SECONDS`
   (600) after failing a job).
2. Refuse the worker if it can see the web host's session directory (a probe
   file is visible there, or the path is on a network filesystem), then rsync
   the session directory and `flask-server/scripts` to the same absolute path
   on it. Worker session copies older than 2 days (left by a web restart
   mid-job) are deleted at the same time.
3. Preflight: every env/weight/script path the command names exists (existence
   only, not versions), the working directory exists, `setsid`/`rsync` are
   installed, and at least `GPU_WORKER_MIN_DISK_GB` (default 20) is free.
4. Run the unchanged command over SSH in its own process group. Model env vars
   from `.env` are forwarded; anything that looks like a secret is not.
5. rsync results back (except files the web app writes itself: `job.json`,
   `.owner`, `auto_masks.zip`), then delete the worker copy.

Failure policy. The rule: the remote path may only ever help. It never fails
a job that a local run would complete.
- Worker unhealthy, missing files, or the connection drops before/while the
  model runs (e.g. a reboot; ssh exit 255): try the next worker, then run on
  bdmap1 as before. A model that itself exits 255 is treated the same way.
- Remote model exits non-zero (bad input, or a broken worker: env drift, driver,
  GPU fault), runs longer than `GPU_WORKER_MAX_RUN_SECONDS` (3600; a hung
  worker), or its results cannot be fetched (3 retries): re-run once on bdmap1.
  If bdmap1 succeeds the worker was at fault and cools down; if bdmap1 also
  fails, the job fails exactly as a local run would.
- Exception: **CUDA out of memory** on a worker. Workers must be idle with
  plenty of free memory, and bdmap1 has the same GPU with less free (it also
  runs the site and Ollama), so a scan that does not fit on a worker will not
  fit there either, and a huge allocation on bdmap1's shared CPU/GPU memory can
  hang the machine that serves the website. The job fails with the model's
  error and is not re-run locally. (Example: LesionSegmenter keeps the whole
  43-class prediction on the GPU, so a 200M-voxel scan needs more than 110 GB.)
- An unexpected error in the dispatch code: the remote run is killed and the
  job runs on bdmap1.
- Cancel at any stage (before upload, during preflight, during the run, while
  fetching results) stops the job, kills the remote process tree, and never
  falls back. A cancel during an upload takes effect when that upload ends.
- The local ssh is killed by a signal without a cancel (e.g. out of memory on
  bdmap1): the remote run is killed and the job fails; no fallback.
- ShapeKit and MedIA-Agentic always stay on bdmap1.
- Set `GPU_WORKER_LOCAL_FALLBACK=false` to never use bdmap1's GPU (jobs then
  fail instead).

Cost per job when enabled: SSH connections are reused per worker (about
0.01 s per call after the first), so health check plus setup is about 0.1 s.
On top of that come the session upload (mainly the CT) and the results
download over the 100 Gbit/s LAN, typically 1-2 s. Transfers abort after 120 s
without progress (hard cap 15 min each). Model run time is the same as on
bdmap1 (same GB10 hardware).

Jobs run one at a time unless `GPU_WORKER_PARALLEL` is raised (see Parallel
jobs); the main gain is that bdmap1's GPU stays free.

If a worker runs its own warm predictor on the same port as `EPAI_WARM_URL` /
`LESIONSEG_WARM_URL`, the forwarded URL (127.0.0.1) makes jobs on that worker
use it automatically; otherwise they use the cold path, as bdmap1 does when its
warm predictor is not running. Starting warm predictors on the workers makes
jobs faster than today.

## Assumptions

- **Each worker has one GPU** (GB10), and jobs are placed per worker, not per
  GPU. Model commands carry the web host's `CUDA_VISIBLE_DEVICES` choice
  (default 0) to the worker unchanged. A multi-GPU worker would need per-GPU
  placement first.
- **One gunicorn process.** Worker reservations live in that process's memory,
  which matches the documented deployment (one process, eight threads).
- **No strict first-come-first-served order** between waiting jobs, as with the
  single lock before.

## Parallel jobs

By default one model job runs at a time, exactly as before. Set
`GPU_WORKER_PARALLEL=N` (in `.env`, with the workers enabled) to let up to N jobs
run at once, one per worker. It is capped at the number of workers in
`GPU_WORKER_HOSTS`, and ignored (1) while workers are disabled. Recommended: the
number of dependable workers (for example 2 with bdmap2 and bdmap4), leaving
the others, such as bdmap3, as spares that take over when one is down.

How it stays safe:
- **No double booking.** Workers are health-checked without being reserved, and
  the winner is reserved atomically, so two jobs never get the same worker and
  one job never sees "no worker free" just because another is checking.
- **Waiting beats overflowing.** If every usable worker is busy with our own
  jobs, a job waits (up to `GPU_WORKER_MAX_WAIT_SECONDS`, 300; cancel works while
  waiting) instead of running on bdmap1. bdmap1 is used only when no worker is
  up at all, or after that wait. Jobs beyond N wait in the normal queue, and
  the queue size (`INFERENCE_MAX_PENDING`) defaults to `3 + N`.
- **bdmap1's own GPU still runs at most one model at a time**, however many
  jobs are in flight: fallback jobs queue on a lock of their own.
- **A session never runs against itself.** A repeat request for a session whose
  job is still queued or running (a retry, a double click) waits for it, as it
  did behind the old single lock, and does not use up a job slot while waiting.
- **The older single-host ePAI mode (`EPAI_REMOTE_ENABLED`) keeps jobs strictly
  serial**, because it sends every ePAI job to one fixed GPU outside the pool.
- Placement is still by health and load, so a hot, throttled or busy worker is
  skipped, and a failing one cools down.

To roll back to one job at a time, unset `GPU_WORKER_PARALLEL` (or set it to 1)
and reload.

## One-time setup (per worker)

1. Passwordless SSH from bdmap1 as `visitor`:
   `ssh -o BatchMode=yes <host> true` must succeed on bdmap1.
2. Copy the model runtimes (~43 GB; additive, lowest priority on both ends,
   40 MB/s cap; run it in tmux):
   `flask-server/scripts/sync_gpu_workers.sh <host>`
   then `flask-server/scripts/sync_gpu_workers.sh --check <host>` -> `ok` for
   every path.
   A path that already existed on the worker (it may be someone else's) is
   never written to. `--check` compares its content (`DIFFERS` lists files to
   resolve by hand). Everything the script creates is recorded in
   `~/.bodymaps_gpu_worker/managed_paths` on the worker, and
   `sync_gpu_workers.sh --undo <host>` removes exactly those paths.
3. Add the host to `GPU_WORKER_HOSTS` in `flask-server/.env`.

## Enable / disable

In `flask-server/.env`:

```
GPU_WORKERS_ENABLED=true
GPU_WORKER_HOSTS=bdmap2.wse.jhu.edu,bdmap4.wse.jhu.edu
```

Restart gunicorn with the usual deploy procedure. To roll back, set
`GPU_WORKERS_ENABLED=false` and restart; nothing else changes.

## Maintenance

- **Reload or restart gunicorn only when no job is running.** Worker reservations
  and the web host GPU lock live in the process; a new process starts with none.
  (The health check still keeps it off a worker that is busy, but a job in
  flight is lost when its process exits anyway.) Check that no model process
  runs on bdmap1 and no worker has a session folder or GPU process first.

- After installing or updating a model, conda env or weights on bdmap1, run
  `flask-server/scripts/sync_gpu_workers.sh` (all hosts from `.env`).
  `flask-server/scripts` itself is synced automatically with every job.
- A worker that is missing anything is skipped automatically (jobs fall back),
  and the gunicorn log shows `[gpu_workers] ... missing model files`.
- **Which machine ran each job:** every finished job (completed, failed or
  cancelled) adds one line to `<sessions dir>/job_runs.jsonl` with the machine(s)
  it ran on, whether it fell back to bdmap1, how long it took and a short error.
  No user id or IP. Summarize it from `flask-server` with
  `python -m services.job_run_log /home/visitor/PanTS-Viewer/tmp/job_runs.jsonl 14`
  (the last 14 days): jobs by outcome, model and machine, and the share that fell
  back to bdmap1. The file keeps the newest 5000 jobs and survives reboots and
  restarts, unlike the server's text log.
- Logs: every remote job prints `[gpu_workers] running on <host>`; fallbacks
  print the reason.
- Do not run research jobs on a worker listed in `GPU_WORKER_HOSTS`: a busy
  worker is skipped, so website jobs fall back to bdmap1, which is what this
  setup exists to avoid.
