#!/usr/bin/env bash
# ============================================================================
#  host-create-lxc.sh — Crée et configure un conteneur LXC Debian 12 sur
#  Proxmox VE pour héberger le pont discord-fluxer-bridge.
#
#  À exécuter SUR LE HÔTE PROXMOX (root), dans un shell :
#    bash deploy/lxc/host-create-lxc.sh
#
#  Prérequis :
#    - Accès root au hôte Proxmox VE (>= 7)
#    - Choix d'un <vmid > libre (100 par défaut)
#    - La commande `pct` disponible (normale sur Proxmox)
#
#  Le script :
#    1. télécharge/cache un template debian-12-standard
#    2. crée le conteneur (unprivileged, réseau bridge, ressources)
#    3. le démarre
#    4. pousse puis exécute container-setup.sh À L'INTÉRIEUR du conteneur
#       (install Node 22, clone du dépôt GitHub, build, service systemd)
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
#  Paramètres — adaptez à votre infrastructure
# ---------------------------------------------------------------------------
CTID="${CTID:-100}"                                # ID du conteneur (libre)
HOSTNAME="${HOSTNAME:-dxf-bridge}"                 # nom du conteneur
STORAGE="${STORAGE:-local-lvm}"                    # stockage du disque rootfs
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"      # stockage des templates (dir)
ROOTFS_SIZE="${ROOTFS_SIZE:-8G}"                   # taille du disque
CORES="${CORES:-2}"
MEM="${MEM:-1024}"                                 # Mo
SWAP="${SWAP:-256}"                                # Mo
BRIDGE="${BRIDGE:-vmbr0}"                          # bridge réseau de l'hôte
IP_MODE="${IP_MODE:-dhcp}"                         # dhcp ou "10.0.0.10/24"
ONBOOT="${ONBOOT:-1}"                              # démarrage auto avec l'hôte

GITHUB_REPO="${GITHUB_REPO:-https://github.com/France-OPG/bot-bridge-discord-fluxer}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

SETUP_SCRIPT="deploy/lxc/container-setup.sh"       # chemin relatif au dépôt
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/$SETUP_SCRIPT"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERREUR : lancez ce script en root sur le hôte Proxmox (sudo)." >&2
  exit 1
fi

if ! command -v pct >/dev/null 2>&1; then
  echo "ERREUR : commande 'pct' introuvable. Êtes-vous bien sur le hôte Proxmox ?" >&2
  exit 1
fi

if pct status "$CTID" >/dev/null 2>&1; then
  echo "ERREUR : le conteneur $CTID existe déjà (pct status)." >&2
  exit 1
fi

echo "==> Mise à jour du catalogue de templates…"
pveam update >/dev/null 2>&1 || true

echo "==> Recherche d'un template debian-12-standard…"
TEMPLATE="$(
  pveam available --section system 2>/dev/null \
    | awk '/debian-12-standard/ {print $2}' \
    | sort -V \
    | tail -n 1 \
    || true
)"
if [ -z "$TEMPLATE" ]; then
  echo "ERREUR : aucun template debian-12-standard disponible." >&2
  echo "  Vérifiez : pveam available --section system | grep debian-12" >&2
  exit 1
fi

# pveam list <storage> affiche les templates déjà téléchargés sur ce stockage.
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -qF "$TEMPLATE"; then
  echo "==> Téléchargement du template $TEMPLATE sur $TEMPLATE_STORAGE…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi

echo "==> Création du conteneur $CTID ($HOSTNAME) — $TEMPLATE"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --description "contrôleur discord-fluxer-bridge (Debian 12 / Node 22)" \
  --storage "$STORAGE" \
  --rootfs "$ROOTFS_SIZE" \
  --cores "$CORES" \
  --memory "$MEM" \
  --swap "$SWAP" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$IP_MODE,firewall=1" \
  --ostype debian \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot "$ONBOOT"

echo "==> Configuration supplémentaire (protection /etc, fuse…) "
pct set "$CTID" -features "nesting=1,fuse=1" || true

echo "==> Démarrage du conteneur…"
pct start "$CTID"

echo -n "==> Attente du démarrage (services)…"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- true 2>/dev/null; then
    echo " ok"
    break
  fi
  echo -n "."
  sleep 2
done

echo "==> Copie du script de configuration dans le conteneur…"
pct push "$CTID" "$SETUP_SCRIPT" /tmp/container-setup.sh
pct exec "$CTID" -- chmod +x /tmp/container-setup.sh

echo "==> Exécution de container-setup.sh à l'intérieur du conteneur…"
echo "    (installation Node 22 + clone $GITHUB_REPO + build + service)"
pct exec "$CTID" -- env \
  GITHUB_REPO="$GITHUB_REPO" \
  GITHUB_BRANCH="$GITHUB_BRANCH" \
  bash /tmp/container-setup.sh

CTIP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

===========================================================================
  Terminé. Récapitulatif :
    Conteneur     : $CTID ($HOSTNAME)
    IP            : ${CTIP:-(à récupérer : pct exec $CTID -- hostname -I)}
    Sources       : /opt/discord-fluxer-bridge

  Il reste à faire (une seule fois) :
    1) Éditer la configuration et les secrets dans le conteneur :
         pct exec $CTID -- nano /opt/discord-fluxer-bridge/.env
         pct exec $CTID -- nano /opt/discord-fluxer-bridge/config/config.yaml
       (token Discord, URL et token Fluxer, identifiants de salons).

    2) Valider puis relancer le service :
         pct exec $CTID -- bash /opt/discord-fluxer-bridge/deploy/lxc/validate.sh
         pct exec $CTID -- systemctl restart discord-fluxer-bridge
         pct exec $CTID -- journalctl -u discord-fluxer-bridge -f
===========================================================================
EOF