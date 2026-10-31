# BodyMaps website

CT library and AI segmentation viewer for PanTS, CancerVerse and AbdomenAtlas: browse in 2D and 3D, upload a CT for segmentation, annotate and review. For non-clinical use only.

- `PanTS-Demo/`: frontend (React, Vite, TypeScript)
- `flask-server/`: backend (Flask, Python 3.11, SQLite)
- `docs/`: design notes. Dataset, nginx, proxy and optional-service details are in [docs/operations-reference.md](docs/operations-reference.md).

## Run locally

Backend:

```
conda create -n PanTS_backend python=3.11 && conda activate PanTS_backend
cd flask-server
pip install -r requirements.txt
cp .env.example .env      # set BASE_PATH=/, PANTS_PATH=<PanTS folder>, USE_SSL=false
python app.py             # serves on 127.0.0.1:5001
```

Frontend (in a second terminal):

```
cd PanTS-Demo
printf 'VITE_API_BASE=\nVITE_API_PROXY_TARGET=http://127.0.0.1:5001\n' > .env
npm install
npm run dev
```

Useful `flask-server/.env` settings (all in `.env.example`): `CANCERVERSE_PATH`, `ABDOMENATLAS_PATH` and their `*_OVERLAY_PATH` for the other datasets; `SMTP_*` for email (unset prints verification links to the log); `TRUST_PROXY=true` behind nginx. The AI assistant needs its own model service, see [AI model setup](PanTS-Demo/src/components/AIAssistant/README_AI_MODEL_SETUP.md#hosting-the-bodymaps-ai-models-ollama-on-the-server).

## Deploy to the server

GitHub first: merge the PR into `main`, then on the server (JHU VPN):

```
ssh visitor@bdmap1.wse.jhu.edu
cd /home/visitor/PanTS-Viewer && git fetch && git checkout main && git pull --ff-only && bash flask-server/deploy/deploy.sh
```

The script backs up the database, builds the new frontend aside (a failed build never touches the live site), refreshes Python packages, runs migrations, waits for running inference jobs to finish (default 15 minutes, `BODYMAPS_WAIT_FOR_JOBS` seconds), swaps the new frontend in (the previous build is kept as `PanTS-Demo/dist.prev-*`), restarts the backend and checks the site. It takes a lock so two people cannot deploy at once, and it stops at the first failure and **names the step**; rerun the same line (every step is safe to repeat) or continue by hand from that step in [docs/operations-reference.md](docs/operations-reference.md#manual-deploy-steps-fallback). If the restart fails it prints the command that goes back to the previous version.

- `bash flask-server/deploy/deploy.sh check` runs the preflight only and changes nothing.
- On a flaky VPN, run the deploy detached so a dropped connection cannot stop it halfway: `cd /home/visitor/PanTS-Viewer && git fetch && git checkout main && git pull --ff-only && setsid nohup bash flask-server/deploy/deploy.sh > ~/deploy.log 2>&1 < /dev/null &`, then `tail -f ~/deploy.log` (Ctrl-C leaves it running).
- Live Rooms is optional. If it runs on the machine, set `BODYMAPS_LIVE_ROOMS_RESTART_HOOK` to a script that supports `check` and `restart`; otherwise the script skips it (and warns if something is listening on port 8001).
- Never restart the backend by hand with `pkill` while jobs may be running.

Is the site up? `GET /api/health` is 200 when everything works and 503 when the dataset mount is down (scans answer 503 at once, while search and sign-in keep working). See `flask-server/deploy/OUTAGE_RUNBOOK.md`.

## More

[Report evidence](docs/report-evidence.md) · [Website access policy](docs/website-access-policy.md) · [Processing pipeline](docs/processing-pipeline.md) · [Guest showcase](docs/guest-showcase.md) · [Diverse quality search](docs/diverse-quality-search.md) · [Account history](docs/account-history-result-loading.md) · [Admin runbook](flask-server/deploy/ADMIN_RUNBOOK.md) · [Live Rooms](flask-server/deploy/LIVE_ROOMS.md)
