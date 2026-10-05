"""Append-only record of where each model job ran and how it ended.

job.json says what happened to a job; this says on which machine, whether it
fell back to the web host, and how long it took, so questions like "how often
do workers fail?" or "is bdmap1's GPU staying clear?" are one command:

    python -m services.job_run_log /path/to/sessions/job_runs.jsonl [days]

One JSON line per finished job (completed, failed or cancelled). Kept apart
from job.json and the database on purpose: nothing the site reads changes, and
writing it is best-effort, so a problem here can never affect a user's job.
It holds no user id or IP address.
"""
from __future__ import annotations

import collections
import json
import os
import sys
import threading
import time

MAX_LINES = 5000  # old samples matter least; keeps the file small
_lock = threading.Lock()


def record_job_run(path, *, session_id, model, status, duration_seconds=None,
                   input_size_bytes=None, run_info=None, error=None) -> None:
    """Append one record. Never raises."""
    try:
        run_info = run_info or {}
        record = {
            "recorded_at": time.time(),
            "session_id": session_id,
            "model": model,
            "status": status,
            "ran_on": list(run_info.get("ran_on") or []),
            "fell_back": bool(run_info.get("fell_back")),
            "duration_seconds": None if duration_seconds is None else round(duration_seconds, 1),
            "input_size_bytes": input_size_bytes,
        }
        if error:
            record["error"] = str(error)[:300]
        with _lock:
            lines = []
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    lines = f.readlines()
            lines.append(json.dumps(record) + "\n")
            if len(lines) > MAX_LINES:
                lines = lines[-MAX_LINES:]
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(lines)
            os.replace(tmp, path)
    except Exception as e:  # best-effort: never let logging touch a job
        print(f"[job_run_log] {e}")


def load(path, days=None, now=None) -> list[dict]:
    """Records from the last `days` days (all if None); unreadable lines are skipped."""
    out, cutoff = [], None
    if days is not None:
        cutoff = (now if now is not None else time.time()) - days * 86400
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if cutoff is None or rec.get("recorded_at", 0) >= cutoff:
                    out.append(rec)
    except OSError:
        pass
    return out


def summarize(records) -> str:
    """Counts by model, outcome and machine; how many fell back to the web host."""
    if not records:
        return "no jobs recorded"
    n = len(records)
    status = collections.Counter(r.get("status") for r in records)
    machine = collections.Counter(m for r in records for m in (r.get("ran_on") or ["unknown"]))
    fell = sum(1 for r in records if r.get("fell_back"))
    models = collections.Counter(r.get("model") for r in records)
    lines = [
        f"{n} jobs: " + ", ".join(f"{k} {v}" for k, v in status.most_common()),
        "by model:   " + ", ".join(f"{k} {v}" for k, v in models.most_common()),
        "ran on:     " + ", ".join(f"{k} {v}" for k, v in machine.most_common()),
        f"fell back to the web host: {fell} ({100 * fell // n}%)",
    ]
    failed = [r for r in records if r.get("status") == "failed"]
    for r in failed[-5:]:
        lines.append(f"  failed {r.get('model')} on {','.join(r.get('ran_on') or ['?'])}: {r.get('error', '')[:100]}")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m services.job_run_log <job_runs.jsonl> [days]")
    window = float(sys.argv[2]) if len(sys.argv) > 2 else None
    print(summarize(load(sys.argv[1], window)))
