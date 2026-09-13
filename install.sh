#!/usr/bin/env bash
# ============================================================================
#  install.sh — Installation du pont discord-fluxer-bridge sur un conteneur
#  LXC ou une VM Linux (Debian 12+ / Ubuntu 22.04+).
#
#  Usage (à l'intérieur de votre LXC/VM, après avoir cloné le dépôt) :
#      git clone https://github.com/France-OPG/bot-bridge-discord-fluxer
#      cd bot-bridge-discord-fluxer
#      bash install.sh
#
#  La commande `install.sh` peut être relancée à volonté (mise à jour après
#  un `git pull`, changement de chemin, etc.) : elle est idempotente.
#
#  Ce qu'elle fait :
#    1. Vérifie l'environnement (root, Debian/Ubuntu)
#    2. Installe Node.js 22 (NodeSource) + pnpm (corepack)
#    3. Compile le projet TypeScript (pnpm install + pnpm build)
#    4. Crée un utilisateur système dédié (`dxf`)
#    5. Génère .env et config/config.yaml depuis les exemples (si absents)
#    6. Installe le service systemd (ou un mode "avant-plan" si pas de systemd)
#    7. Démarre le service si les tokens sont déjà renseignés
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
APP_USER="${APP_USER:-dxf}"
SERVICE_NAME="discord-fluxer-bridge"
NODE_MAJOR="22"
NODE_MIN="22.13.0"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "ERREUR : introuvable 'package.json' dans $APP_DIR." >&2
  echo "  Lancez ce script depuis la racine du dépôt (répertoire contenant package.json)." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERREUR : relancez avec les droits root (sudo bash install.sh)." >&2
  exit 1
fi

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Environnement
# ---------------------------------------------------------------------------
if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERREUR : ce script ne supporte que Debian/Ubuntu (apt manquant)." >&2
  exit 1
fi

log "Répertoire d'installation : $APP_DIR"

# ---------------------------------------------------------------------------
# 2. Node.js 22 + pnpm
# ---------------------------------------------------------------------------
log "Installation des paquets de base (curl, git, toolchain)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  git \
  make \
  g++ \
  python3 \
  build-essential \
  unzip

NODE_OK=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version | sed 's/^v//')"
  if printf '%s\n%s\n' "$NODE_MIN" "$NODE_VERSION" | sort -V -C; then
    NODE_OK="1"
  fi
fi

if [ -z "$NODE_OK" ]; then
  log "Installation de Node.js $NODE_MAJOR (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi

log "Node: $(node --version) — npm: $(npm --version)"

log "Activation de pnpm via corepack…"
corepack enable || true
corepack prepare "pnpm@$(node -p "require('$APP_DIR/package.json').packageManager.replace(/^pnpm@/, '') || '9.15.0'")" --activate || true

# ---------------------------------------------------------------------------
# 3. Compilation
# ---------------------------------------------------------------------------
cd "$APP_DIR"

log "Installation des dépendances (pnpm install --frozen-lockfile)…"
pnpm install --frozen-lockfile

log "Compilation TypeScript (pnpm build)…"
pnpm build

# ---------------------------------------------------------------------------
# 4. Utilisateur système dédié + répertoires
# ---------------------------------------------------------------------------
log "Utilisateur système '$APP_USER'…"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

log "Répertoires de données…"
mkdir -p "$APP_DIR/data/attachments"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------------------
# 5. Fichiers de configuration (jamais écrasés)
# ---------------------------------------------------------------------------
log "Génération de .env et config/config.yaml (exemples, non écrasés)…"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
[ -f "$APP_DIR/config/config.yaml" ] || cp "$APP_DIR/config/config.example.yaml" "$APP_DIR/config/config.yaml"
chown "$APP_USER:$APP_USER" "$APP_DIR/.env" "$APP_DIR/config/config.yaml"

have_secrets=1
for key in DISCORD_TOKEN FLUXER_API_URL FLUXER_TOKEN; do
  grep -q "^$key=[^[:space:]]" "$APP_DIR/.env" || have_secrets=0
done

# ---------------------------------------------------------------------------
# 6. Service / mode d'exécution
# ---------------------------------------------------------------------------
run_script="$APP_DIR/deploy/lxc/run.sh"
cat > "$run_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$APP_DIR"
exec node dist/index.js
EOF
chmod +x "$run_script"

if [ -d /run/systemd/system ]; then
  log "systemd détecté — installation du service $SERVICE_NAME…"
  sed "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" \
    "$APP_DIR/deploy/lxc/discord-fluxer-bridge.service" \
    > "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload

  if [ "$have_secrets" -eq 1 ]; then
    log "Tokens déjà présents → démarrage automatique."
    systemctl enable --now "$SERVICE_NAME"
    sleep 2
    systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,12p' || true
  else
    echo
    echo "  ⚠ Service installé mais PAS démarré : remplissez d'abord les secrets."
  fi
else
  echo
  echo "  ⚠ systemd absent (conteneur minimal) : mode 'avant-plan'."
  echo "    Lancez le pont avec :  bash $run_script"
  echo "    (ex. via tmux : tmux new -s dxf 'bash $run_script')"
fi

# ---------------------------------------------------------------------------
# 7. Récapitulatif
# ---------------------------------------------------------------------------
cat <<EOF

===========================================================================
  Installation terminée dans $APP_DIR
---------------------------------------------------------------------------
  Configuration des secrets (une seule fois) :
      nano $APP_DIR/.env
      nano $APP_DIR/config/config.yaml
    (token Discord, URL et token Fluxer, identifiants de salons)

  Validation + démarrage :
      bash $APP_DIR/deploy/lxc/validate.sh
      systemctl enable --now $SERVICE_NAME          # si systemd
      journalctl -u $SERVICE_NAME -f                # logs

  Sans systemd :
      bash $APP_DIR/deploy/lxc/run.sh               # avant-plan

  Mise à jour :
      cd $APP_DIR && git pull && bash install.sh

  Plus d'infos : docs/INSTALLATION.md
===========================================================================
EOF
exit 0