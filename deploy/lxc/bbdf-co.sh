#!/usr/bin/env bash
# ============================================================================
#  bbdf-co — Édite la configuration config/config.yaml (salons, options)
#  dans votre éditeur de texte favori (nano par défaut, vi en secours).
#  Les liens de salons sont automatiques (bridge.autolink) : cette édition
#  sert surtout à verrouiller des paires manuelles ou la voix.
#  Usage : bbdf-co
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/discord-fluxer-bridge}"

editor="${EDITOR:-nano}"
if ! command -v "$editor" >/dev/null 2>&1; then
  editor="vi"
fi

if [ ! -f "$APP_DIR/config/config.yaml" ]; then
  echo "Fichier introuvable : $APP_DIR/config/config.yaml" >&2
  echo "  (relancez d'abord install.sh pour générer les exemples)" >&2
  exit 1
fi

echo "==> Édition de $APP_DIR/config/config.yaml (salons / options)…"
"$editor" "$APP_DIR/config/config.yaml"

echo "==> Après modification :"
echo "      bash $APP_DIR/deploy/lxc/validate.sh   (vérifier la config)"
echo "      bbdf-ac                                (relancer le bot)"