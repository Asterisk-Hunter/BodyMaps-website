# Second-opinion masks for the user dataset

Every scan kept in `UserData` carries the mask of the model the user ran. This
process runs the same stored CT through the **other** models and saves each
result beside the original, so one scan has an ePAI version, an Atlas-Net
version and a LesionSegmenter version.

It is **low priority**: it only works while nobody is using the site and a GPU
worker is idle, it never uses bdmap1's GPU, and it stops the moment a user job
appears.

## What it saves

```
mask_only/USER_00000017/
    combined_labels.nii.gz, segmentations/, metadata.json     the model the user ran (unchanged)
    by_model/LesionSegmenter/
        combined_labels.nii.gz                                one image, each voxel = organ number
        segmentations/<organ>.nii.gz                          the same, one file per organ
        version.json                                          see below
    by_model/Atlas-Net/...
```

`metadata.json` gains `model_versions`, a list of every version with the
folder holding its mask (`"."` for the user's own run):

```json
"model_versions": [
  {"model": "ePAI", "role": "user_run", "mask": "."},
  {"model": "LesionSegmenter", "role": "second_opinion", "mask": "by_model/LesionSegmenter"},
  {"model": "Atlas-Net", "role": "second_opinion", "mask": "by_model/Atlas-Net"}
]
```

`version.json` records how that version was made: the model, which model the
user ran, when and how long, the worker that ran it (`executor.ran_on`), the
`provenance` (checkpoint hashes, settings, code commit) and `label_support`
(which labels that model can output at all) from `services/model_provenance.py`,
organ volumes, and whether the result contained plausible organs
(`segmentation_ok`; an empty result is still saved and says so). The input is
always the original stored CT with no pre- or post-processing.

A version appears only when every file is in place (it is written to a
`.partial` folder and renamed), so a reader never sees half a version.

## When it runs

A task starts only when **all** of these hold, checked several times in a row:

1. `GET /api/health` on the website shows `inference.active`, `queued` and
   `running` all 0. An unreadable answer counts as busy.
2. The web host has at least `SECOND_OPINIONS_MIN_AVAILABLE_GB` (20) of
   available memory (`MemAvailable`; `nvidia-smi` cannot report the GB10's
   unified memory).
3. At least one worker in `GPU_WORKER_HOSTS` passes the website's own health
   check (`services/gpu_workers.py`: reachable, GPU not busy or hot, CPU not
   busy, enough free memory, **no GPU process of anyone else**).

It uses one worker at a time, and runs **only on a worker**:

* it refuses to start unless `GPU_WORKERS_ENABLED` is true and
  `GPU_WORKER_LOCAL_FALLBACK` is false (the script forces the latter, and
  `GPU_WORKER_PARALLEL=1`, for its own process; the website's settings are not
  touched);
* a result whose run was not on a worker (`fell_back`, or the web host in
  `ran_on`) is discarded.

While a model runs, the website is polled every `SECOND_OPINIONS_POLL_SECONDS`
(3). If a user job appears, the model is cancelled (including on the worker) and
the task goes back in the queue **without counting as a failure**. The same
happens on a stop request (below) or after `SECOND_OPINIONS_MAX_RUN_SECONDS`
(1800; that one counts as a failure).

## Running it

Run it from `flask-server/` with the website's Python, as the `visitor` user.
It is its own process: starting or stopping it does not touch the website.

```
cd /home/visitor/PanTS-Viewer/flask-server
PY=/home/visitor/.conda/envs/PanTS_backend/bin/python

$PY scripts/user_dataset_second_opinions.py --status      # what exists and what is left; no GPU, no network
$PY scripts/user_dataset_second_opinions.py --dry-run     # status + what the idle gate sees right now
$PY scripts/user_dataset_second_opinions.py --once --limit 1   # one task, only if idle now, then exit

# keep going while idle (survives a dropped SSH session):
setsid nohup $PY scripts/user_dataset_second_opinions.py --loop \
  >> /home/visitor/UserData/second_opinions.log 2>&1 < /dev/null &
```

**Stop it:** `touch /home/visitor/UserData/.second_opinions.stop` (or send
SIGTERM). A running model is cancelled and requeued, then the process exits.
Remove the file before starting again. Only one instance can run (a lock in
`UserData/.second_opinions.lock`).

## Files it keeps in `UserData/`

| File | What it is |
| --- | --- |
| `second_opinions_state.json` | per-task attempts, back-off and the runs of the last 24 hours |
| `second_opinions.jsonl` | one line per finished, failed, preempted or deferred task |
| `second_opinions_status.json` | what it is doing now (updated continuously) |
| `.second_opinions.stop` / `.lock` | the stop switch and the single-instance lock |

A failed task is retried after 1 hour, then after 6 hours, and after the third
failure it gives up (listed by `--status`); delete its entry in
`second_opinions_state.json` to try again. At most `SECOND_OPINIONS_DAILY_CAP`
(100) GPU runs are started per rolling 24 hours.

## Settings (all optional, environment or `flask-server/.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECOND_OPINIONS_MODELS` | `ePAI,Atlas-Net,LesionSegmenter` | models every scan should have |
| `SECOND_OPINIONS_BASE_URL` | `http://127.0.0.1:8000` | the website, for `/api/health` |
| `SECOND_OPINIONS_IDLE_CHECKS` / `_CHECK_INTERVAL` | 3 / 20 s | consecutive idle samples needed |
| `SECOND_OPINIONS_POLL_SECONDS` | 3 | how often to look for users while a model runs |
| `SECOND_OPINIONS_MAX_RUN_SECONDS` | 1800 | per-task time limit |
| `SECOND_OPINIONS_MIN_AVAILABLE_GB` | 20 | web-host memory that must stay free |
| `SECOND_OPINIONS_DAILY_CAP` | 100 | GPU runs per rolling 24 hours |
| `SECOND_OPINIONS_MAX_ATTEMPTS` | 3 | failures before giving up |
| `SECOND_OPINIONS_SESSIONS_DIR` | `<repo>/tmp` | temporary session folders (must contain `tmp`) |

## Notes

* The stored scans are **not de-identified** (each case keeps `user_id` and
  `session_id`), so these versions are internal until that is decided.
* The workers must hold the same model environments and weights as the website
  (`scripts/sync_gpu_workers.sh`); the checkpoint hashes in `version.json` are
  those of the web host's copy.
* Deploying this needs only the new code on disk (`git pull`); no website
  restart is involved because nothing in the website imports it.
