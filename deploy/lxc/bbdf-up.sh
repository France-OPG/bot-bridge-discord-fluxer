#!/usr/bin/env bash
# ============================================================================
#  bbdf-up — Mise à jour du bot directement depuis GitHub, sans jamais
#  écraser la configuration existante (.env, config/config.yaml, data/).
#
#  Usage : bbdf-up        (ou : bash deploy/lxc/bbdf-up.sh)
#  Depuis la VM, idéalement arrêté ou activé ; le service est redémarré
#  automatiquement à la fin (install.sh), si les tokens sont présents.
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/discord-fluxer-bridge}"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "ERREUR : '$APP_DIR' n'est pas un dépôt git (chemin modifié ?)." >&2
  echo "  Réinstallez d'abord : bash $APP_DIR/install.sh" >&2
  exit 1
fi

echo "==> Mise à jour des sources depuis GitHub…"
# deploy/lxc/run.sh est régénéré par install.sh : on remet le fichier
# suivi d'origine pour ne pas bloquer le pull.
git -C "$APP_DIR" checkout -- deploy/lxc/run.sh 2>/dev/null || true
git -C "$APP_DIR" pull

echo
echo "==> Recompilation + réinstallation (configuration conservée)…"
bash "$APP_DIR/install.sh"

echo
echo "==> bbdf-up terminé. Redémarrage :"
echo "      bbdf-ac    (activer le bot)"
echo "      bbdf-de    (désactiver le bot)"
echo "      journalctl -u discord-fluxer-bridge -f   (logs)"