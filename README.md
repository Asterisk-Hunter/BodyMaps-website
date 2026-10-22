# Backend

Automatic reports provide segmentation measurements only, with disease status
explicitly not assessed. Stored report text is available separately as an
unverified reference and excluded from the default PDF. See
[report evidence and coverage](docs/report-evidence.md) for the contract,
limitations, and regression checks.

The viewer's AI assistant also needs its model service running. See
[AI model setup and persistent Ollama service](PanTS-Demo/src/components/AIAssistant/README_AI_MODEL_SETUP.md#hosting-the-bodymaps-ai-models-ollama-on-the-server)
for installation, restart, and health checks. Restarting Flask alone does not
start Ollama.

## Live Rooms

Dataset viewer supports temporary, signed-in collaborative review at `/live/<room-id>#<room-key>`. Up to eight equal editors can collaborate for 24 hours, then room files expire. Exports include edited labelmap, annotations, notes, chat, event history, and report without changing canonical dataset files.

Workspace, Team and browser-only local scan viewing are public. Dataset browsing,
server uploads and inference, saved results, shared reports and Live Rooms require
a signed-in account. Login, account recovery, verification and legal pages remain
public. See [website access policy](docs/website-access-policy.md),
[profile pictures](flask-server/deploy/PROFILE_PICTURES.md) and
[session retention](flask-server/deploy/SESSION_RETENTION.md) for deployment details.

Before releasing the redesign, follow the
[redesign release procedure](flask-server/deploy/REDESIGN_RELEASE.md), including
the Live Rooms restart hook, account database backup, and authenticated checks.

The workspace's optional OpenVAE and ShapeKit stages use the
[server processing pipeline](docs/processing-pipeline.md), including verified
weights, preserved original CTs, and explicit result provenance.
Approved preview releases can instead enable the documented frontend flags;
those choices are labelled **Preview only / Not run** and never execute an
optional stage. Segmentation and its account permissions remain real.

Deployment and local service instructions: [`flask-server/deploy/LIVE_ROOMS.md`](flask-server/deploy/LIVE_ROOMS.md).

## Interactive segmentation (nnInteractive)

The viewer's "Segment from click", scribble, box and lasso tools send prompts to an
[nnInteractive](https://github.com/MIC-DKFZ/nnInteractive) model server. Flask only
holds the client (`nninteractive-client` in `requirements.txt`); the model runs in its
own process with torch, ideally on a GPU host. The model weights are CC BY-NC-SA 4.0,
for non-commercial research use.

Keep the server version equal to `nninteractive-client` in `requirements.txt`; the two
are released together.
```
python3 -m venv nninteractive-env
nninteractive-env/bin/pip install nnInteractive==2.6.0
# --device cuda on a GPU host, --device mps on Apple silicon.
# The first start downloads about 400 MB of weights.
PYTORCH_ENABLE_MPS_FALLBACK=1 nninteractive-env/bin/nninteractive-server \
  --model nnInteractive_v1.0 --device cuda --no-torch-compile
```

It listens on port 1527. Set `NNINTERACTIVE_SERVER_URL` in `flask-server/.env` when it
runs anywhere else (see `flask-server/.env.example` for the session limits). Without a
reachable server, a plain click or box falls back to the older region-grow tool, and the
prompts only the model can answer (corrections, scribble, lasso, refine) say the model
is unavailable.

#### Create Conda Environment
```
conda create -n PanTS_backend python=3.11
conda activate PanTS_backend
```

#### Set up environment backend
```
cd flask-server
touch .env  # creates the .env file
nano .env
```

Inside .env file (see `flask-server/.env.example` for the full list):
```
BASE_PATH=/

PANTS_PATH=/folder/where/PanTS

USE_SSL=false
```

Password reset emails (`/api/auth/forgot-password`) and account verification
emails (`/api/auth/send-verification` — verifying is what, with a complete
profile, lifts an account to the 10-scans/day tier) go out over SMTP:

```
# Amazon SES (the production setup — the credential is a send-only SMTP key,
# handed to the deployer privately; it never lives in this repository)
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_STARTTLS=true
SMTP_USER=<SES SMTP username>
SMTP_PASSWORD=<SES SMTP password>
SMTP_FROM=no-reply@thebodymaps.com
PUBLIC_BASE_URL=https://bodymaps.wse.jhu.edu
```

`PUBLIC_BASE_URL` is what the emailed links point at, so it must be the address
users actually visit. `SMTP_FROM` must be an address on a domain the SES
identity covers. (Gmail SMTP also works for low volume — `smtp.gmail.com`,
port 587, a 16-character App Password rather than the account password — but
its ~500 recipients/day cap and suspension behaviour make it unsuitable once
signups carry verification mail.)

Leave `SMTP_USER`/`SMTP_PASSWORD` unset and both flows still work end to end:
the message — reset or verification link and all — is printed to the server log
instead of being sent, and password-signup users simply stay on the 1-scan/day
tier until mail is configured. That is the intended local-dev path — no mailbox
needed. OAuth (Google/GitHub) accounts arrive already verified and are
unaffected either way.

Optional dataset vars:
```
# Writable dir for precomputed PanTS low-res volumes (make_lowres.py output)
PANTS_LOWRES_PATH=/home/visitor/pants_lowres

# CancerVerse (second dataset). Leave unset to disable it.
CANCERVERSE_PATH=/folder/where/CancerVerse
CANCERVERSE_LOWRES_PATH=/home/visitor/cancerverse_lowres
# Optional writable overlay with updated/new scans, current metadata and the tumor index
CANCERVERSE_OVERLAY_PATH=/home/visitor/cancerverse_v351
```
`CANCERVERSE_PATH` holds the cases (`image_only/CV_########/ct.nii.gz`, or the flat `CV_########/ct.nii.gz`); the metadata CSV `CancerVerse_dataset_metadata.csv` sits **next to** that folder (in its parent). Search treats PanTS and CancerVerse as **one collection**: `/api/search`, `/api/facets` and `/api/random` cover both by default (`?dataset=pants` or `?dataset=cancerverse` still narrows them for API clients). CancerVerse has no organ masks, only tumor masks (see below): a scan without a tumor mask gets `{"masks_available": false}` from the mask endpoint and opens CT-only.

**Tumor type.** Every PanTS tumor is pancreatic. CancerVerse annotates 13 organs, so its tumor types come from the released lesion masks: run `scripts/build_cancerverse_index.py --labels CancerVerse_Label.tar.gz --out <overlay>/cancerverse_case_index.json --workers 4` once (about an hour with 2 workers; the stage script runs it for you). It decompresses every mask an annotator touched (a touched mask can be an erased, all-zero annotation, so file size alone is not evidence of a tumor) and skips the untouched ones, verifying that skip on a sample; it exits non-zero if the check ever finds a tumor in a skipped mask. With `--metadata <csv>` it refuses to write the index when the archive lacks more than 0.5% of the CSV's scans, which is what a half-downloaded archive looks like. Without the index file the CancerVerse tumor status simply shows as unknown.

**What "No tumor" means for CancerVerse.** A scan is `tumor = 0` only if it is indexed, none of that patient's scans has an annotated lesion, **and** the patient has no ICD-10 neoplasm code (C00-D49) on any scan. A patient diagnosed with a cancer that was never segmented (metastases, an organ outside the 13) has no lesion mask but is not tumor-free, so their scans count as *unknown* instead. On the current release that is 10,873 scans with no tumor, 9,639 with an annotated tumor and 3,910 unknown. Filter with `tumor_type[]=pancreas&tumor_type[]=liver` (or `tumor_type=liver;kidney`); items carry `dataset`, `tumor types` and `tumor label`. A bare number in `caseid=` always means a PanTS case; CancerVerse ids keep their `CV_` prefix.

**Case numbers.** The library is numbered as one running list in the app: 1-9,901 are PanTS and CancerVerse continues from 9,902 (`CV_00000001` is number 9,902, `CV_00024422` is 34,323). Typing a number in the search box, opening `/case/<number>` and the number shown on each card all use it. It is only a way to address cases: the ids the app and the API use are unchanged (`17` for PanTS, `CV_00000001` for CancerVerse), so existing links, caches and thumbnails keep working, and the API still reads a bare number as a PanTS case. PanTS never changes size, so CancerVerse numbers do not move; a dataset added after CancerVerse should start where CancerVerse ends at that time and then be frozen (see `PanTS-Demo/src/helpers/caseNumbering.ts`).

**Tumor masks in the viewer.** CancerVerse releases tumor masks only (13 tumor types per scan, almost all empty) and no organ masks, so the viewer can show an overlay and 3D meshes only for the scans with an annotated tumor (9,639 of 24,422 on the current release); every other scan opens CT-only. `scripts/build_cancerverse_masks.py --labels CancerVerse_Label.tar.gz --index <overlay>/cancerverse_case_index.json --out <overlay> --workers 2` folds each such scan's tumors into `<overlay>/mask_only/CV_########/combined_labels.nii.gz`: a uint8 volume on the CT's grid whose voxels hold the viewer label id of the tumor (22 pancreas, 33 liver, 34 kidney, 35 colon, 36 stomach, 37 adrenal gland, 38 bladder, 39 prostate, 40 esophagus, 41 spleen, 42 uterus, 43 duodenum, 44 gallbladder; the ids are baked into the files and into the frontend, never renumber). Where two tumors overlap the smaller one is drawn on top. It is resumable and atomic, and `stage_cancerverse_update.sh` runs it for you (`MAKE_MASKS=0` skips). The masks are served from the overlay on local disk, so they keep working if the dataset mount is down. The 3D meshes are baked from the mask on first request. In the viewer a CancerVerse case lists a single "Tumors" group with the types its scan has.

**Updating CancerVerse.** The dataset mount is read-only, so updates go into the overlay and the site prefers it. `scripts/plan_cancerverse_update.py` compares the server copy with the published release and writes the list of new or changed CTs; `scripts/stage_cancerverse_update.sh <plan> <overlay>` downloads and verifies them (size and SHA-256), builds the tumor index, draws the card thumbnails of the staged scans into `<overlay>/profile_only` (`MAKE_PREVIEWS=0` skips), and publishes the metadata CSV last, only if every download succeeded. It is resumable (a re-run only needs disk space for what is still missing), stops after `MAX_CONSECUTIVE_FAILS` (5) failed downloads in a row, validates the plan, and can pin the label archive with `LABELS_SHA256`. It never touches `.env` or restarts anything: add `CANCERVERSE_OVERLAY_PATH`, then reload the backend with the usual deploy procedure when no job is running.

Two more things follow from serving files out of the overlay. (1) nginx needs the `/_bodymaps_volume_cancerverse_overlay/` internal location from `flask-server/deploy/nginx-bodymaps.conf` (alias = the overlay folder); without it overlay CTs are streamed by Gunicorn threads instead of nginx. (2) The sign-in policy sends all API files with `Cache-Control: private, no-store, max-age=0`, including overlay files. A replaced scan never uses the old low-res copy. Previously cached files from the old public/immutable policy can remain in a browser until they expire; purge existing shared caches when releasing the access-policy change.

**Order of results.** In Browse-all and Shuffle the quality ranking lists PanTS before CancerVerse inside the same thumbnail-quality tier (PanTS cases have organ masks; CancerVerse scans are larger and would otherwise fill the first pages). Any filter, such as a tumor type, shows CancerVerse as usual.

**Sample selection.** The signed-in workspace Sample action calls `POST /api/stage-sample` with a new session UUID. The server copies the original **PanTS case 31** into the account's normal upload staging area, retaining the 16 MiB size limit and CT validation. If case 31 is unavailable, preparation reports an error instead of substituting another case. Dataset files remain unchanged. Selection returns metadata only; Run uses that server copy without downloading and re-uploading it. The button keeps its Sample case label during preparation and prevents duplicate requests. The browser downloads CT bytes only when Preview is opened. Choosing None opens case 31 in the dataset viewer.

Sample preparation is account-bound, idempotent for its session UUID, mount-gated, and rate-limited. Each account can hold three pending samples; unused copies older than an hour are reclaimed on its next sample preparation. Removing a selection releases its copy unless inference has already claimed it. Preparation itself neither runs inference nor consumes a scan allowance. Run still uses the existing model permissions and quota checks. The 16 MiB limit applies only to automatic samples; it does not change user-upload limits, downsample scans, or change normal gallery ranking.

#### Build the search/shuffle quality index

Search and shuffle can rank cases by CT file size and thumbnail display quality without
adding filesystem or vision-model work to API requests. Generate the index offline on
the host that has the dataset mounted:

```
ollama pull qwen3-vl:4b
python scripts/compute_case_quality.py \
  --out /home/visitor/data/bodymaps_case_quality.v1.json \
  --datasets all \
  --vision required \
  --overwrite
```

Then set the same path in `flask-server/.env` before starting the backend:

```
BODYMAPS_CASE_QUALITY_MANIFEST=/home/visitor/data/bodymaps_case_quality.v1.json
BODYMAPS_THUMBNAIL_VISION_MODEL=qwen3-vl:4b
```

Use `--resume` instead of `--overwrite` to reuse unchanged CT and thumbnail records.
`--vision required` fails rather than silently producing an index without vision
classification. If the manifest is unset or unavailable, ranking falls back to scan
shape and voxel-spacing metadata.

#### Install the visitor-location database

The analytics page maps where visitors come from, using MaxMind's GeoLite2
database on this server — no visitor IP is ever sent to a third party. The file
is ~60MB and not redistributable, so it is not in the repo and each deploy
fetches its own copy. Get a free licence key at
https://www.maxmind.com/en/geolite2/signup (Account > Manage License Keys), then:

```
export MAXMIND_LICENSE_KEY=<your key>
python scripts/download_geolite.py
```

It writes `flask-server/data/GeoLite2-City.mmdb` (override with `GEOIP_DB_PATH`).
Re-run it every month or two — a stale database gets quietly less accurate
rather than failing. Skip this entirely and the site works fine: locations
simply aren't recorded and the map says so.

Behind nginx, also set `TRUST_PROXY=true`. Without it every request looks like
it came from the proxy, so every visitor geolocates to the server itself.

Run backend:

```
pip install -r requirements.txt
python app.py
```

# Frontend

```
cd PanTS-Demo
touch .env
nano .env
```

Inside .env:
```
# Keep browser requests on the frontend origin so every API and image request
# carries its session cookie. Vite forwards /api to this local backend.
VITE_API_BASE=
VITE_API_PROXY_TARGET=http://127.0.0.1:5001
```

#### Run frontend

```
npm install
npm run dev
```

# Deploying Updates to the Server
---

After pushing changes, SSH into the server and run the following.

```
ssh visitor@bdmap1.wse.jhu.edu
```

#### One-paste deploy (recommended)

Paste this single line; it pulls the latest `main` and runs the tracked deploy
script, which performs every numbered step below - backup, pull, build,
migrations, restart - with waits and health checks built in:

```
cd /home/visitor/PanTS-Viewer && git fetch && git checkout main && git pull --ff-only && bash flask-server/deploy/deploy.sh
```

If anything goes wrong it stops immediately, **names the step that failed**,
and touches nothing after it - fix the problem and either paste the same line
again (every step is safe to re-run) or continue by hand from that numbered
step below. `bash flask-server/deploy/deploy.sh check` runs the preflight only
and changes nothing.

`deploy.sh` also takes a lock (so two people cannot deploy at once), waits for
running inference jobs to finish before it restarts the backend (a restart ends
them; `BODYMAPS_WAIT_FOR_JOBS` sets how long, default 15 minutes), and if the restart
fails it prints the command that goes back to the previous version. Do not restart
the backend by hand with `pkill` or `kill -HUP` while jobs may be running.

**Is the site up?** `GET /api/health` returns 200 when everything works and 503 when
the dataset storage (the network mount) is down; in that case scans and masks answer
503 immediately instead of hanging, while search, sign-in and the low-res viewer keep
working. `deploy/OUTAGE_RUNBOOK.md` says what to check, what is safe, and who can fix
what. `deploy/site_watchdog.sh` (cron, see the runbook) alerts and restarts a hung backend.

# The materials below are NOT useful anymore!

#### 1. Back up the database
Accounts, sessions and job state live in SQLite, so take a copy before any deploy that might run migrations.
```
cd /home/visitor/PanTS-Viewer/flask-server && cp *.db ~/db-backup-$(date +%F-%H%M).db 2>/dev/null && echo "backed up" || echo "no db found"
```

#### 2. Pull latest changes
Production must always deploy from `main`. Confirm the branch first, then pull.
```
cd /home/visitor/PanTS-Viewer
git fetch
git checkout main
git pull
```
If `git pull` (or the checkout) refuses because of "local changes would be overwritten," someone edited files directly on the server. Do **not** force past it. Run `git status` to see what changed, then discard each file with `git checkout -- <file>` (or ask the maintainer) before pulling again. The server should never carry local edits.

### Volume-delivery configuration (administrator required)

The viewer's large immutable CT and mask files must be streamed by nginx, not
held open by Gunicorn. Once per server (or whenever the dataset paths change),
an administrator should install the tracked nginx configuration, test it, and
reload nginx:

```
sudo cp /home/visitor/PanTS-Viewer/flask-server/deploy/nginx-bodymaps.conf /etc/nginx/sites-available/bodymaps
sudo ln -sfn /etc/nginx/sites-available/bodymaps /etc/nginx/sites-enabled/bodymaps
sudo nginx -t && sudo systemctl reload nginx
```

Then add `BODYMAPS_ACCEL_REDIRECT_ENABLED=true` to
`/home/visitor/PanTS-Viewer/flask-server/.env`. Do not enable that setting
before `nginx -t` succeeds: the application intentionally falls back to normal
Flask delivery until the private nginx locations exist. CDN/nginx rules for
`/api/*`, including CT and segmentation files, must respect
`Cache-Control: private, no-store, max-age=0` and `X-Accel-Expires: 0`. Purge old
public responses and remove any cache override that could serve a signed-out
visitor without reaching Flask. See [website access policy](docs/website-access-policy.md).

#### 3. Rebuild the frontend and refresh backend dependencies
```
cd /home/visitor/PanTS-Viewer/PanTS-Demo && npm ci && npm run build
/home/visitor/.conda/envs/PanTS_backend/bin/pip install -r /home/visitor/PanTS-Viewer/flask-server/requirements.txt
```
The `pip install` is a fast no-op when nothing changed, but it is required whenever a PR adds or bumps a Python dependency — otherwise the restarted backend crashes on a missing import and the site goes empty. If `npm run build` errors out, **stop here**: nginx keeps serving the old site until a build succeeds, so fix the error before restarting the backend.

#### 4. Apply database migrations
Required whenever a PR adds an Alembic revision; a fast no-op otherwise. Skipping it after a schema change leaves the backend querying tables that do not exist.
```
cd /home/visitor/PanTS-Viewer/flask-server && /home/visitor/.conda/envs/PanTS_backend/bin/alembic upgrade head
```
This step is **mandatory** for the tiered-access release: it carries two
revisions (`7d4f8c2a9b1e` profile fields on `user_account`, and
`9e6a1b5d4c2f` the `email_verification_token` table). Without it, signing up
and editing the profile return 500s. (The earlier account-recovery release's
two revisions run in the same command if the server ever skipped them.)

#### 4b. One-time for the tiered-access release: email credentials (optional)
Verification emails need the SES SMTP block in
`/home/visitor/PanTS-Viewer/flask-server/.env` (the variables are listed in
the email section near the top of this file). **The credential is not in this
repository and never will be** — the maintainer sends a one-time link whose
contents you paste into the SSH terminal as a single block; it appends the
credentials, restarts the backend, and health-checks it. No editor needed.
Skipping this is safe: the site
runs, verification links go to the gunicorn log instead of inboxes, and
password-signup users simply stay on the 1-scan/day tier until it is added.
OAuth sign-ins are unaffected either way.

#### 5. Restart the backend
```
# Stop the old gunicorn process and wait for the port to free
pkill -f "gunicorn.*app:app"; sleep 2
pgrep -f "gunicorn.*app:app" && echo "still running - rerun the line above" || echo "port clear"

# Start a new gunicorn process
nohup /home/visitor/.conda/envs/PanTS_backend/bin/gunicorn \
  --worker-class gthread --workers 1 --threads 8 \
  --bind 127.0.0.1:8000 --timeout 3600 \
  --chdir /home/visitor/PanTS-Viewer/flask-server \
  app:app > /tmp/gunicorn.log 2>&1 &
echo "PID: $!"
```

The production environment must set `TRUST_PROXY=true` and `TRUST_PROXY_HOPS=2`
(campus edge proxy + nginx). Forgetting it does not crash anything, which is
exactly the problem: every request then keys rate limits on the proxy's own
address (the whole site shares one 120/min analytics bucket) and analytics
geolocates every visitor to the server. The backend prints a `[boot]` warning
to the gunicorn log when it starts without it.

The hop count only helps if the proxies pass the visitor's address along. The
nginx config in `flask-server/deploy/` sets `X-Forwarded-For` to
`$remote_addr`, which drops what the campus edge proxy sent: with
`TRUST_PROXY_HOPS=2` every request then comes from `127.0.0.1`, and with 1
from the edge proxy's address. For the visitor's address to arrive, nginx has
to append to the header instead (`proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;`) and the hop count has to match the entries on a
request from outside the network, as the comment above `ProxyFix` in `app.py`
describes. When every request comes from `127.0.0.1`, the sign-in and sign-up
limits skip their per-address ceilings and only the per-account sign-in
ceiling applies. When every request comes from the edge proxy's address they
cannot tell that apart from one busy network, so 60 failed sign-ins from
anyone in 15 minutes would stop all sign-ins; check the address before
deploying.

#### 6. Verify the backend is running
Give it a few seconds to load, then check that health and the dataset library are public and a case's scans refuse signed-out requests.
```
sleep 8
curl http://127.0.0.1:8000/api/ping
curl -s -o /dev/null -w "guest search: %{http_code} (expect 200)\n" "http://127.0.0.1:8000/api/search?per_page=1"
curl -s -o /dev/null -w "guest segmentations: %{http_code} (expect 401)\n" "http://127.0.0.1:8000/api/get-segmentations/17.nii.gz"
```
Expect `{"message":"pong"}`, 200 for the library search and 401 for the segmentation. Then sign in through the deployed HTTPS site and verify dataset search and a known case's CT/mask requests succeed in that authenticated browser. A 401 without cookies does not mean the dataset is missing. If the backend fails to boot, check the log for the traceback.

Then check sign-in is wired up.
```
curl -s http://127.0.0.1:8000/api/auth/oauth/providers
curl -sS -i https://bodymaps.wse.jhu.edu/api/auth/oauth/google | grep -i "^location:" | tr '&' '\n' | grep redirect_uri
```
Expect `{"github":true,"google":true}`, then a `redirect_uri` beginning `https%3A%2F%2Fbodymaps.wse.jhu.edu`. A `http://` scheme there means `PUBLIC_BASE_URL` is unset or stale, and every sign-in fails `redirect_uri_mismatch` — the provider matches that string exactly. Note `providers` only reports whether credentials are non-empty, so it still returns `true` for rotated-but-not-updated secrets; those surface as `invalid_client` at sign-in.

Then check password reset can actually send. This asks for a link for an
address with no account, so nothing is emailed to anyone — it answers 200 either
way, and the point is what the log says next.
```
curl -s -X POST http://127.0.0.1:8000/api/auth/forgot-password \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com"}'
grep -i "\[mail\]" /tmp/gunicorn.log | tail -5
```
Expect `{"ok":true}` and **no** `[mail]` lines. A line saying "SMTP is not
configured" means `SMTP_USER`/`SMTP_PASSWORD` are unset and emailed links are
going to the log instead of to users. "SMTP rejected the credentials" means
the password is wrong for the host: for SES it must be the derived SMTP
password (not the raw secret key); for Gmail, an App Password (not the
account password).

Then check upload/assistant access and account tiers:
```
# All website features require sign-in - expect 401 for these calls too
curl -s -o /dev/null -w "guest upload: %{http_code} (expect 401)\n" -X POST http://127.0.0.1:8000/api/upload-inference-chunk
curl -s -o /dev/null -w "guest assistant: %{http_code} (expect 401)\n" -X POST -H 'Content-Type: application/json' -d '{"message":"hi"}' http://127.0.0.1:8000/api/ai-command

# A fresh account starts on 1 scan/day and gets a verification email
curl -s -c /tmp/tiercheck.txt -X POST -H 'Content-Type: application/json' \
  -d '{"email":"tier-check@example.com","password":"delete-me-123"}' \
  http://127.0.0.1:8000/api/auth/register > /dev/null
curl -s -b /tmp/tiercheck.txt http://127.0.0.1:8000/api/me/usage | head -c 120; echo
```
Expect `"plan": "free"` with `"daily_scans": 1`, and (with SMTP configured) a
verification mail in the inbox — without SMTP, the link is in
`/tmp/gunicorn.log`. Delete the throwaway account afterwards from
Settings → People as an admin. A free account can browse and has its configured daily inference allowance.

Finally, load `https://bodymaps.wse.jhu.edu/upload` in a browser: a
signed-out visitor can browse the dataset library and its Statistics page, and is
asked to sign in before opening a case or uploading. A signed-in account can select a file
and run within its account limits.

Logs are written to `/tmp/gunicorn.log`.
