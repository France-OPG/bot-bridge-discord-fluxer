#!/usr/bin/env bash
# ============================================================================
#  validate.sh — Validation rapide de la configuration + état du service.
#  À exécuter dans le conteneur LXC (/opt/discord-fluxer-bridge).
# ============================================================================
set -euo pipefail

cd /opt/discord-fluxer-bridge

echo "==> 1. Validation de la configuration (config/config.yaml + .env)"
node dist/cli.js validate-config -c config/config.yaml

echo
echo "==> 2. Liens configurés"
node dist/cli.js links -c config/config.yaml

echo
echo "==> 3. État du service systemd"
if systemctl is-active --quiet discord-fluxer-bridge; then
  echo "    actif (en cours d'exécution)"
  systemctl --no-pager --full status discord-fluxer-bridge | sed -n '1,10p' || true
else
  echo "    inactif — démarrage : systemctl enable --now discord-fluxer-bridge"
  echo "    logs : journalctl -u discord-fluxer-bridge"
fi

echo
echo "==> 4. Santé HTTP (si le service tourne)"
if systemctl is-active --quiet discord-fluxer-bridge; then
  curl -fsS http://127.0.0.1:8083/health || echo "    (endpoint non joignable — vérifiez admin.status_port)"
fi

exit 0