#!/usr/bin/env bash
# ============================================================================
#  bbdf-de — Désactive (arrête + retire du boot) le service du bot.
#  Usage : bbdf-de
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERREUR : pas de systemd ici. Il suffit d'arrêter le process du pont." >&2
  exit 1
fi

systemctl disable --now discord-fluxer-bridge
echo "==> Bot désactivé (arrêté et retiré du démarrage)."
echo "      Pour le relancer : bbdf-ac"