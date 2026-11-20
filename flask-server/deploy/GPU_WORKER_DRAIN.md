# Timed GPU worker drain

Opt in by configuring `GPU_WORKER_DRAIN_DIR` on the dispatcher to a private local directory owned by its service account. An unset variable preserves existing behavior. Initial deployment and configuration follow the normal production approval process.

After deployment, an operator on the dispatcher can keep new jobs off bdmap3 for two hours without a restart:

```bash
drain_dir=/home/visitor/gpu-worker-drains
umask 077
mkdir -p -- "$drain_dir"
marker=$(mktemp "$drain_dir/.bdmap3.XXXXXX") &&
  date -u -d '+2 hours' +%s > "$marker" &&
  mv -f -- "$marker" "$drain_dir/bdmap3.until"
```

Use the configured directory. The dispatcher checks the marker when choosing and reserving a worker. Existing assignments are allowed to finish. Other workers and the configured fallback keep their ordinary behavior. Expired markers are ignored. An invalid or unreadable marker drains the named worker until corrected.

This only affects requests through the GPU worker dispatcher. Confirm no active or separately launched work before using bdmap3. Give any test a hard deadline well before expiration; verify the training process is gone before the worker returns. If cleanup is delayed, extend the drain before it expires. After checking the worker, an operator can remove the marker to return it early.
