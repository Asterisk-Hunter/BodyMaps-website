# When the site is down: a runbook

Written after the outage of Oct 10 2026, when the dataset storage stopped answering and the whole
site went with it. It says what to look at first, what is safe, and what only an administrator can do.

## What happened on Oct 10, and why one dead mount took everything down

* The datasets live on a network mount: `ccvl40.ccvl.jhu.edu:/bodymaps/spark`, mounted at
  `/mnt/bodymaps` on bdmap1 (and bdmap2, bdmap4). It is a `hard` NFS mount, so when the NFS server
  stopped answering, every read waited forever (the processes sit in uninterruptible `D` state).
* The backend is one gunicorn worker with a handful of threads. Every visitor request that read a
  scan parked one of those threads on the dead mount. After a few, there was no thread left to
  answer anything, including pages that need no files (search, sign-in, `/api/ping`).
* Restarting the backend would not have helped: the new process hangs on the same mount while loading
  the catalog (and a restart would end any running inference job). Killing the stuck processes does not
  fix the cause either: the mount stays dead until the NFS server answers again.

## What the code now does about it

* `services/mount_health.py` probes the mount every few seconds and keeps a cached verdict.
  `/api/health` reports it (200 when fine, **503 + `"status": "degraded"`** when the mount is down).
* Routes that read scans, masks or reports answer **503 immediately** while the mount is down, instead of
  waiting on it. Search, the case library, sign-in, `/api/ping` and `/api/health` keep working, and so do
  the low-res viewer and pre-baked meshes (they are on local disk).
* gunicorn runs 16 threads instead of 8, so the few requests that arrive before the monitor notices
  cannot use them all up.
* `deploy/site_watchdog.sh` (cron, every minute) alerts when the mount is down or the site is back, and
  restarts the backend only when the backend itself has stopped answering **and the mount is fine**.
* `deploy/deploy.sh` refuses to run twice at once, waits for running inference jobs instead of killing
  them, and prints the rollback command if the restart fails.

## First 2 minutes (nothing here changes anything)

```bash
ssh visitor@bdmap1.wse.jhu.edu
curl -s -m 10 http://127.0.0.1:8000/api/health ; echo          # status + whether the mount is down
timeout -s KILL 8 stat /mnt/bodymaps/.probe-$RANDOM; echo "rc=$?"   # rc=1 fine ("no such file"), rc=137 hung
ps -eo pid,stat,etime,wchan:22,cmd | awk '$2 ~ /^D/' | head      # processes stuck in D state
tail -n 20 /tmp/gunicorn.log
```

**Never run `df` or `ls` on `/mnt/bodymaps` while it may be hung**: they hang too and pile up as `D`
processes. Use the `timeout -s KILL` form above.

## Decide

| What you see | Meaning | Do |
| --- | --- | --- |
| `/api/health` = 200 | The site is fine. | Look at the reported problem (nginx, DNS, the user's network). |
| `/api/health` = 401 or 403 | A health access/proxy rule is wrong; the backend is answering. | Fix that rule. The watchdog alerts but does not restart and interrupt inference. Health GET/HEAD must remain public; the dataset library (search, filters, counts, thumbnails) is public too, but a case's scans still require sign-in. |
| `/api/health` = 503, `"mount": {"ok": false}` | The dataset storage is hung. The site is up but cannot serve scans. | **Do not restart anything.** Tell the storage administrator (below). The site recovers by itself when the mount answers. |
| `/api/health` does not answer, the `stat` probe is fine | The backend is stuck or dead. | The watchdog restarts it after 4 minutes. To do it now: `bash flask-server/deploy/start_backend.sh`. |
| Neither answers | The mount is hung and the guard is not running (an old backend, or `MOUNT_GUARD=0`). | Treat it as a storage outage. After the mount returns, restart: `bash flask-server/deploy/start_backend.sh`. |

If a restart is needed and inference jobs are running (`/api/health` -> `inference.active`), a restart ends
them. Use `deploy.sh` for planned work: it waits for them.

## Who can fix the storage

Nobody with a `visitor` login. The NFS server is a different machine (ccvl40), and fixing it needs root there.
Send the administrator this:

> The `/mnt/bodymaps` NFS mount from ccvl40 has stopped responding on bdmap1, bdmap2 and bdmap4, so the
> website cannot serve scans. ccvl40 still answers ping and its NFS port is open, so the NFS service looks
> hung. Before any reboot (a reboot may run a storage check and hang again): `df -h` and `dmesg | tail -50` on
> ccvl40, free space if the volume is full, then `systemctl restart nfs-server`. If a client still hangs,
> `umount -f -l /mnt/bodymaps && mount /mnt/bodymaps` on that client.

## Setting up the watchdog and alerts (one time, on bdmap1, as `visitor`)

```bash
mkdir -p ~/.bodymaps-watchdog
# optional: where alerts go (a Teams or Slack incoming-webhook URL). Mode 600, never commit it.
printf 'BODYMAPS_ALERT_WEBHOOK=%s\n' 'https://...your webhook url...' > ~/.bodymaps-watchdog.env
chmod 600 ~/.bodymaps-watchdog.env
# dry look, changes nothing:
bash /home/visitor/PanTS-Viewer/flask-server/deploy/site_watchdog.sh; tail ~/.bodymaps-watchdog/watchdog.log
# install: once a minute
( crontab -l 2>/dev/null; echo '* * * * * /home/visitor/PanTS-Viewer/flask-server/deploy/site_watchdog.sh >> /home/visitor/.bodymaps-watchdog/cron.log 2>&1' ) | crontab -
```

Switch off the automatic restart (alerts only) with `WATCHDOG_AUTORESTART=0` in the same file. It also stands
down by itself while `deploy.sh` is running, and will not restart more than once per 30 minutes or four times a day.

Also point an external uptime monitor (UptimeRobot, Healthchecks.io, anything free) at
`https://bodymaps.wse.jhu.edu/api/health` so you hear about an outage even if bdmap1 itself is down:
the watchdog runs on the same machine and cannot report that.

## Other things that take the site down, and what covers them

| Cause | What covers it |
| --- | --- |
| Storage mount hangs | The mount guard and `/api/health` above; admin fix on ccvl40. |
| Backend crashes or the machine reboots | `systemd/pants-flask.service` (`Restart=always`, starts at boot): an administrator installs it once, see `ADMIN_RUNBOOK.md`. Until then the watchdog covers a crash, but not a reboot. |
| Backend hangs while the mount is fine | The watchdog's restart. |
| A deploy kills a running inference job | `deploy.sh` waits for `inference.active == 0`. Do not use `pkill`/`kill -HUP` by hand. |
| Two people deploy at once | The deploy lock (`/tmp/bodymaps-deploy.lock`). |
| A bad deploy | `deploy.sh` prints the rollback command; every step names itself on failure. |
| Disk fills up | `deploy.sh` needs 2 GB free; the user-scan collector stops below 100 GB free; the big staging job stops at 300 GB (`USER_DATASET_MIN_FREE_GB`, `MIN_FREE_GB`). Watch `/home`. |
| Someone's long job saturates the shared machine | Run bulk work with `nice -n 15 ionice -c3`, and ask before anything over 30 minutes (the GPU and CPU are shared). |
| A merge silently drops a feature | The route-level regression test for scan collection (`tests/unit/test_user_collection_hook.py`); add one like it for anything that must not vanish quietly. |
