#!/usr/bin/env bash
# ============================================================================
#  bbdf-ed — Édite le fichier .env (tokens Discord / Fluxer) dans votre
#  éditeur de texte favori (nano par défaut, vi en secours).
#  Usage : bbdf-ed
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/discord-fluxer-bridge}"

editor="${EDITOR:-nano}"
if ! command -v "$editor" >/dev/null 2>&1; then
  editor="vi"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Fichier introuvable : $APP_DIR/.env" >&2
  echo "  (relancez d'abord install.sh pour générer les exemples)" >&2
  exit 1
fi

echo "==> Édition de $APP_DIR/.env (tokens)…"
"$editor" "$APP_DIR/.env"

echo "==> Après modification, activez/redémarrez le bot : bbdf-ac"