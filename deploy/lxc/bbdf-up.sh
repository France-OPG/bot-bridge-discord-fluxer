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

# Le dépôt appartient à l'utilisateur système 'dxf' : déclarer le dossier
# "sûr" pour root (évite l'erreur "dubious ownership").
git config --global --add safe.directory "$APP_DIR"

echo "==> Mise à jour des sources depuis GitHub…"
# deploy/lxc/run.sh est régénéré par install.sh : on remet le fichier
# suivi d'origine pour ne pas bloquer le pull.
git -C "$APP_DIR" checkout -- deploy/lxc/run.sh 2>/dev/null || true
git -C "$APP_DIR" pull

# Ré-écrit les commandes globales (bbdf-up / bbdf-ac / bbdf-de /
# bbdf-ed / bbdf-co) : elles restent disponibles même après un pull
# brut sans install.sh.
echo "==> Commandes globales (bbdf-up / bbdf-ac / bbdf-de / bbdf-ed / bbdf-co)…"
for cmd in bbdf-up bbdf-ac bbdf-de bbdf-ed bbdf-co; do
  cat > "/usr/local/bin/$cmd" <<EOF
#!/usr/bin/env bash
# $cmd — lance le script correspondant du dépôt.
exec bash "$APP_DIR/deploy/lxc/$cmd.sh" "\$@"
EOF
  chmod +x "/usr/local/bin/$cmd"
done

echo
echo "==> Recompilation + réinstallation (configuration conservée)…"
bash "$APP_DIR/install.sh"

echo
echo "==> bbdf-up terminé. Commandes globales :"
echo "      bbdf-ac    activer le bot          | bbdf-de  désactiver le bot"
echo "      bbdf-ed    éditer .env (tokens)    | bbdf-co  éditer config/config.yaml"
echo "      journalctl -u discord-fluxer-bridge -f   (logs)"