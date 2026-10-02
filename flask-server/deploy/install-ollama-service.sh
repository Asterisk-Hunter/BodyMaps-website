#!/usr/bin/env bash
# Manage the existing user installation; do not download or replace models.
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
unit=bodymaps-ollama.service
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
source_unit="$script_dir/$unit"

for command in systemctl loginctl curl ss; do
  command -v "$command" >/dev/null || die "Required command not found: $command"
done
[[ -x "$HOME/ollama/bin/ollama" ]] || die "Install Ollama for this host's architecture at ~/ollama/bin/ollama first (see README_AI_MODEL_SETUP.md)."
systemctl --user show-environment >/dev/null || die "The user systemd manager is unavailable. Run this from a normal SSH login."

# Never compete with a system service or an unmanaged process using the port.
if systemctl is-active --quiet ollama.service || systemctl is-active --quiet "$unit" || systemctl --user is-active --quiet ollama.service; then
  die "Another Ollama service is active. Keep its service manager; do not install a competing one."
fi
if ! systemctl --user is-active --quiet "$unit" && [[ -n "$(ss -H -ltn 'sport = :11434')" ]]; then
  die "Port 11434 is already occupied. Identify its owner before installing the service; nothing was stopped."
fi
if [[ -e "$unit_dir/$unit" ]] && ! cmp -s "$source_unit" "$unit_dir/$unit"; then
  die "$unit_dir/$unit already exists with different contents. Review it before replacing it."
fi

# Without linger, a user service can disappear at logout and will not boot
# until someone logs in. Do not report a durable installation without it.
account=$(id -un)
if [[ "$(loginctl show-user "$account" --property=Linger --value)" != yes ]]; then
  loginctl --no-ask-password enable-linger "$account" || die "An administrator must run: sudo loginctl enable-linger $account. Then rerun this script."
fi
[[ "$(loginctl show-user "$account" --property=Linger --value)" == yes ]] || die "Linger is still disabled; the service would not survive logout/reboot."

mkdir -p -- "$unit_dir"
mkdir -p -- "$HOME/.ollama/models"
install -m 644 "$source_unit" "$unit_dir/$unit"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
    printf 'Ollama is healthy on loopback, enabled at boot, and supervised by %s.\n' "$unit"
    printf 'Inspect models: OLLAMA_HOST=127.0.0.1:11434 ~/ollama/bin/ollama list\n'
    printf 'Inspect logs: journalctl --user -u %s -n 50 --no-pager\n' "$unit"
    exit 0
  fi
  sleep 1
done
die "Ollama did not become healthy. Check: journalctl --user -u $unit -n 50 --no-pager"
