#!/usr/bin/env python3
"""Run every kept user scan through the OTHER models, only while a GPU worker is idle and nobody is using the site.

For each scan in UserData this saves the missing model versions beside the original, so a scan the user ran with
ePAI also gets an Atlas-Net and a LesionSegmenter version (and so on), under
mask_only/USER_x/by_model/<Model>/. See services/user_dataset_models.py and deploy/USER_DATASET_SECOND_OPINIONS.md.

  --status     what exists and what is left (no GPU, no network)
  --dry-run    status plus what the idle gate sees right now: website, memory, GPU workers (read-only checks)
  --once       run what is possible right now, then exit (does not wait for an idle moment)
  --loop       keep working through the backlog forever, only while idle (run it under tmux/setsid)

It is its own process: it never runs inside the website, never uses the web host's GPU (it refuses to start unless
GPU_WORKER_LOCAL_FALLBACK is false and GPU workers are enabled), and stops at once if you create
UserData/.second_opinions.stop or send SIGTERM. Run it from flask-server/ with the website's Python.
"""
import argparse
import json
import os
import signal
import sys
import threading

SERVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)


def _prepare_environment() -> None:
    """Load the website's .env, then force the two settings that make this process safe. auto_segmentor calls
    load_dotenv() without override, so values set here win."""
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(SERVER, ".env"))
    except ImportError:
        pass
    os.environ["GPU_WORKER_LOCAL_FALLBACK"] = "false"   # never the web host's GPU
    os.environ["GPU_WORKER_PARALLEL"] = "1"             # one task at a time


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--loop", action="store_true")
    parser.add_argument("--limit", type=int, default=None, help="stop after this many finished tasks")
    parser.add_argument("--models", default=None, help="comma-separated models (default: ePAI,Atlas-Net,LesionSegmenter)")
    parser.add_argument("--root", default=None, help="UserData folder (default: USER_DATASET_PATH)")
    parser.add_argument("--json", action="store_true", help="print --status/--dry-run as JSON")
    args = parser.parse_args(argv)

    _prepare_environment()
    if args.models:
        os.environ["SECOND_OPINIONS_MODELS"] = args.models
    from services import user_dataset_models as m

    root = args.root or os.environ.get("USER_DATASET_PATH", "").strip()
    if not root or not os.path.isdir(root):
        print("USER_DATASET_PATH is not set or not a folder; nothing to do", file=sys.stderr)
        return 2
    cfg = m.Config.from_env()

    if args.status or args.dry_run:
        report = m.status_report(root, cfg)
        if args.dry_run:
            from services import gpu_workers
            deps = m.default_deps()
            try:
                m.assert_safe_environment(gpu_workers)
                safe = "yes"
            except m.UnsafeEnvironment as e:
                safe = f"NO: {e}"
            report["gate"] = {"safe_environment": safe, "website": m.website_reason(deps) or "idle",
                              "memory_gb_available": deps.available_gb(),
                              "free_workers": deps.free_workers() if safe == "yes" else "(not checked)"}
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"cases: {report['cases']}   runs in the last 24h: {report['runs_last_24h']}/{report['daily_cap']}")
            for model, c in report["models"].items():
                print(f"  {model:16s} done {c['done']:3d}  pending {c['pending']:3d}  backing off {c['backing_off']:3d}  "
                      f"gave up {c['gave_up']:3d}  (the user's own run: {c['is_users_run']})")
            if report["given_up"]:
                print("  gave up on:", ", ".join(report["given_up"]))
            if "gate" in report:
                print("idle gate right now:", json.dumps(report["gate"]))
        return 0

    from services import gpu_workers
    try:
        m.assert_safe_environment(gpu_workers)
    except m.UnsafeEnvironment as e:
        print(f"refusing to run: {e}", file=sys.stderr)
        return 3

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    sessions_dir = os.environ.get("SECOND_OPINIONS_SESSIONS_DIR") or os.path.normpath(os.path.join(SERVER, "..", "tmp"))
    os.makedirs(sessions_dir, exist_ok=True)
    counts = m.run_loop(root, cfg, m.default_deps(), sessions_dir, once=args.once, limit=args.limit, stop_event=stop)
    print("finished:", json.dumps(counts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
