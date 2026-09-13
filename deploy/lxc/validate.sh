#!/usr/bin/env bash
# ============================================================================
#  validate.sh — Validation rapide de la configuration + état du service.
#  À exécuter à la racine du dépôt (après install.sh).
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SERVICE_NAME="discord-fluxer-bridge"

cd "$APP_DIR"

echo "==> 1. Validation de la configuration (config/config.yaml + .env)"
node dist/cli.js validate-config -c config/config.yaml

echo
echo "==> 2. Liens configurés"
node dist/cli.js links -c config/config.yaml

echo
echo "==> 3. État du service systemd"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "    actif (en cours d'exécution)"
  systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,10p' || true
else
  echo "    inactif — démarrage : systemctl enable --now $SERVICE_NAME (ou bash deploy/lxc/run.sh)"
  echo "    logs : journalctl -u $SERVICE_NAME"
fi

echo
echo "==> 4. Santé HTTP (si le service tourne)"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  curl -fsS http://127.0.0.1:8083/health || echo "    (endpoint non joignable — vérifiez admin.status_port)"
fi

exit 0