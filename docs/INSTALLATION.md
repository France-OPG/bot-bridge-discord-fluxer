# Installation

## Prérequis

- **Node.js ≥ 22.13.0** (requis par `@fluxerjs/core` v3 et `@discordjs/voice` 0.19.2).
  - Recommandé : `node:22-bookworm-slim` via Docker.
  - Testez : `node --version`. Si vous avez Node 20 (ex. poste Windows courant),
    utilisez Docker (voir plus bas).
- **pnpm** : `corepack enable` (Node ≥ 16.13) ou
  `npm i -g pnpm@9`. Le module npm global de certains postes est corrompu
  (erreur `abbrev`) : utilisez pnpm.
- Deux serveurs/bots prêts :
  - **Discord** : une application bot avec un token ;
  - **Fluxer** : une instance (hébergée ou self-hosted) avec son token de bot.

## 1. Discord — créer le bot

1. Applications > *New Application* ⧸ *Bot* ;
2. Cocher uniquement ce dont le pont a besoin (voir `docs/CONFIGURATION.md`) :
   - **Privileged Gateway Intents** : `Message Content`, `Server Members` (optionnel), `Presence` (non requis) ;
   - permissions en salon : *Voir les salons*, *Envoyer des messages*,
     *Gérer les messages* (pour éditer/supprimer), *Gérer les webhooks*,
     *Ajouter des réactions*, *Se connecter/Parler* (voix) ;
3. Inviter le bot sur le serveur avec ces permissions.

> Le pont crée **un webhook par salon** (pool persistant). Accordez
> *Gérer les webhooks*.

## 2. Fluxer — créer le bot

Voir la documentation Fluxer ("self-hosting / bots") :
- créer une application bot, récupérer le token au format `<application_id>.<secret>`
  (le schéma de configuration le valide : deux parties séparées par un point) ;
- autoriser le bot sur le serveur et les salons concernés ;
- voix : vérifier que l'instance a **LiveKit configuré** et que `POST /channels/{id}/voice/token`
  répond (test via la doc API de votre instance).
- permission équivalente à *Gérer les messages* pour l'édition/suppression.

## 3. Fichiers de configuration

```bash
cp .env.example .env
# remplir : DISCORD_TOKEN, FLUXER_API_URL, FLUXER_TOKEN
cp config/config.example.yaml config/config.yaml
# renseigner vos identifiants de salons (voir docs/CONFIGURATION.md)
```

Vérifier avant de lancer :

```bash
pnpm install
pnpm cli validate-config
pnpm cli links
```

## 4. Lancer

### En développement

```bash
pnpm dev            # tsx (voir aussi : pnpm build && pnpm start)
```

### En production (recommandé : Docker)

```bash
docker compose up -d --build
docker compose logs -f discord-fluxer-bridge
```

Les volumes :
- `./config/config.yaml` → monté en lecture seule dans le conteneur ;
- `./data` → store de correspondances + cache des pièces jointes.

### En production (Proxmox : conteneur LXC)

Le pont tourne dans un conteneur **LXC Debian 12** (unprivileged) sur un hôte
Proxmox VE. Trois fichiers sont fournis dans `deploy/lxc/` :

| Fichier                          | Où il s'exécute        | Rôle                                                              |
|----------------------------------|------------------------|-------------------------------------------------------------------|
| `host-create-lxc.sh`             | hôte Proxmox (root)    | crée le conteneur, le démarre, pousse et lance le setup           |
| `container-setup.sh`             | dans le conteneur      | Node 22 (NodeSource), pnpm, clone GitHub, build, service systemd  |
| `discord-fluxer-bridge.service`  | dans le conteneur      | unité systemd (user `dxf`, redémarrage auto, durcissement)        |

1. **Publiez d'abord le dépôt sur GitHub** (voir « Publication sur GitHub » ci-dessous).
2. Sur l'hôte Proxmox, munissez-vous du dépôt (clone), puis :
   ```bash
   bash deploy/lxc/host-create-lxc.sh
   ```
   Les paramètres (VIP, hostname, stockage, ressources, bridge, URL du dépôt)
   sont en variables en tête du script : `CTID=`, `STORAGE=`, `BRIDGE=`, etc.
3. Remplissez les secrets dans le conteneur :
   ```bash
   pct exec 100 -- nano /opt/discord-fluxer-bridge/.env
   pct exec 100 -- nano /opt/discord-fluxer-bridge/config/config.yaml
   ```
   (`100` = ID du conteneur ; changez si vous avez ajusté `CTID`.)
4. Validez puis démarrez le service :
   ```bash
   pct exec 100 -- bash /opt/discord-fluxer-bridge/deploy/lxc/validate.sh
   pct exec 100 -- systemctl enable --now discord-fluxer-bridge
   pct exec 100 -- journalctl -u discord-fluxer-bridge -f
   ```

> Le service est activé automatiquement par `container-setup.sh` **uniquement si
> les tokens sont déjà présents** dans `.env`. Sinon il attend que vous les
> remplissiez (étape 3) puis démarrage manuel (étape 4). Répertoires de données
> et configuration restent dans l'image : sauvegardez la rootfs ou prévoyez un
> stockage monté.

Accès au serveur d'état : dans `config/config.yaml`, passer
`admin.status_host: "0.0.0.0"` pour l'atteindre via l'IP du conteneur
(`curl http://<ip-conteneur>:8083/health`) — ou garder `127.0.0.1` et utiliser
un tunnel SSH :
`ssh -L 8083:127.0.0.1:8083 root@<hote-proxmox>`.

## 5. Vérifications après démarrage

```bash
curl http://127.0.0.1:8083/health    # {"ok":true}
curl http://127.0.0.1:8083/status    # compteurs, état des liens, voix
pnpm cli status
```

Testez : tapez un message dans un salon Discord → il apparaît dans le salon
Fluxer associé (nom + avatar de l'auteur), et inversement. Entrez dans les
salons vocaux liés pour tester le son.

## Dépannage rapide

Voir `docs/DEPANNAGE.md` pour les erreurs courantes (npm corrompu, Node < 22,
429, webhooks, voix LiveKit…).

## Publication sur GitHub

Le dépôt est prêt à publier : `.gitignore` exclut `node_modules/`, `.env`,
`dist/`, `data/` et les caches. Depuis `discord-fluxer-bridge/` :

```bash
git init -b main
git add .
git commit -m "Passerelle Discord <-> Fluxer (texte, fichiers, réactions, voix)"
git remote add origin https://github.com/France-OPG/bot-bridge-discord-fluxer
git push -u origin main
```

> Les scripts LXC clonent ce dépôt par défaut
> (`GITHUB_REPO=https://github.com/France-OPG/bot-bridge-discord-fluxer`) :
> d'où l'importance de publier avant de lancer `host-create-lxc.sh`.
> Un CI GitHub Actions (`push`/PR) lance automatiquement typecheck + tests +
> build sur Node 22.