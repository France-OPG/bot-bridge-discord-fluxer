#!/usr/bin/env bash
# ============================================================================
#  container-setup.sh — Provisionne le conteneur LXC Debian 12 avec le pont
#  discord-fluxer-bridge.
#
#  À exécuter À L'INTÉRIEUR du conteneur (root). Le script host-create-lxc.sh
#  s'en charge automatiquement ; il peut aussi être relancé manuellement :
#    env GITHUB_REPO=... bash /tmp/container-setup.sh
#
#  Étapes :
#    1. Paquets système (curl, git, toolchain pour les modules natifs Node)
#    2. Node.js 22 (NodeSource) + pnpm (corepack)
#    3. Clone du dépôt GitHub dans /opt/discord-fluxer-bridge
#    4. pnpm install --frozen-lockfile + pnpm build
#    5. Utilisateur système dédié + fichiers .env / config.yaml
#    6. Service systemd activé (si les tokens sont déjà renseignés)
# ============================================================================
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-https://github.com/France-OPG/bot-bridge-discord-fluxer}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
APP_DIR="/opt/discord-fluxer-bridge"
SERVICE_NAME="discord-fluxer-bridge"
RUN_USER="dxf"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERREUR : lancez ce script en root dans le conteneur." >&2
  exit 1
fi

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
log "Mise à jour du système et installation des paquets de base…"
# shellcheck disable=SC2086
apt-get update -y && apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  git \
  make \
  g++ \
  python3 \
  build-essential \
  unzip \
  sudo

# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q "^v22"; then
  log "Installation de Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

log "Node: $(node --version) — npm: $(npm --version)"

log "Activation de pnpm via corepack…"
corepack enable || true
corepack prepare pnpm@9.15.0 --activate || true

# ---------------------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  log "Clonage du dépôt $GITHUB_REPO (branche $GITHUB_BRANCH)…"
  mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$GITHUB_BRANCH" "$GITHUB_REPO" "$APP_DIR"
else
  log "Dépôt déjà présent, mise à jour…"
  git -C "$APP_DIR" fetch --prune
  git -C "$APP_DIR" checkout "$GITHUB_BRANCH" 2>/dev/null || true
  git -C "$APP_DIR" pull --ff-only || true
fi

cd "$APP_DIR"

log "Installation des dépendances (pnpm install --frozen-lockfile)…"
pnpm install --frozen-lockfile

log "Compilation TypeScript…"
pnpm build

# ---------------------------------------------------------------------------
log "Création de l'utilisateur système '$RUN_USER'…"
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

log "Préparation des répertoires de données…"
mkdir -p "$APP_DIR/data/attachments"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ---------------------------------------------------------------------------
log "Génération de .env et config/config.yaml à partir des exemples…"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
[ -f "$APP_DIR/config/config.yaml" ] || cp "$APP_DIR/config/config.example.yaml" "$APP_DIR/config/config.yaml"
chown "$RUN_USER:$RUN_USER" "$APP_DIR/.env" "$APP_DIR/config/config.yaml"

# ---------------------------------------------------------------------------
log "Installation du service systemd…"
cp "$APP_DIR/deploy/lxc/discord-fluxer-bridge.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload

# ---------------------------------------------------------------------------
# Activation immédiate seulement si les secrets sont déjà renseignés.
have_secrets=1
for key in DISCORD_TOKEN FLUXER_API_URL FLUXER_TOKEN; do
  if grep -q "^$key=[^[:space:]]" "$APP_DIR/.env"; then
    : # présent
  else
    have_secrets=0
  fi
done

if [ "$have_secrets" -eq 1 ]; then
  log "Tokens présents → activation du service."
  systemctl enable --now "$SERVICE_NAME"
  sleep 2
  systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,12p' || true
else
  echo "===================================================================="
  echo "  Service installé mais PAS démarré : remplissez d'abord les secrets."
  echo "    nano $APP_DIR/.env"
  echo "    nano $APP_DIR/config/config.yaml"
  echo "  Puis :"
  echo "    bash $APP_DIR/deploy/lxc/validate.sh"
  echo "    systemctl enable --now discord-fluxer-bridge"
  echo "===================================================================="
fi

log "Terminé."
exit 0