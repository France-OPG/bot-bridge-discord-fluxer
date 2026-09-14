#!/usr/bin/env bash
# ============================================================================
#  bbdf-ac — Active (démarre + met au boot) le service du bot.
#  Usage : bbdf-ac
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERREUR : pas de systemd ici. Lancez : bash /opt/discord-fluxer-bridge/deploy/lxc/run.sh" >&2
  exit 1
fi

systemctl enable --now discord-fluxer-bridge
systemctl --no-pager --full status discord-fluxer-bridge | sed -n '1,10p' || true