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

### En production (LXC / VM — installateur unique)

Le pont s'installe **dans** votre conteneur LXC ou votre VM Linux, avec **un
seul script** : `install.sh`. Il fonctionne sur Debian 12+ et Ubuntu 22.04+,
avec ou sans systemd (repli "avant-plan").

Étapes :

1. Créez votre conteneur/VM (Debian 12 ou Ubuntu 24.04 recommandé ; dans
   Proxmox, un conteneur LXC `unprivileged` convient parfaitement, sans besoin
   de privilèges supplémentaires) et connectez-vous dedans (SSH ou console).
2. Ouvrez les sorties réseau vers `discord.com`, `api.fluxer.app`/votre
   instance Fluxer et `deb.nodesource.com`.
3. Clonez puis installez :
   ```bash
   git clone https://github.com/France-OPG/bot-bridge-discord-fluxer
   cd bot-bridge-discord-fluxer
   sudo bash install.sh
   ```
   La commande copie d'abord les sources dans **`/opt/discord-fluxer-bridge`**
   (chemin accessible au service), quel que soit le dossier de clonage. Le
   script : vérifie l'environnement, installe **Node.js 22** (NodeSource) et
   **pnpm**, compile le projet, crée l'utilisateur `dxf`, génère `.env` et
   `config/config.yaml` (sans rien écraser), installe le service systemd.
4. Renseignez les secrets puis démarrez (depuis `/opt/discord-fluxer-bridge`) :
   ```bash
   cd /opt/discord-fluxer-bridge
   nano .env                     # DISCORD_TOKEN, FLUXER_API_URL, FLUXER_TOKEN
   nano config/config.yaml       # identifiants de salons (texte/voix)
   sudo bash deploy/lxc/validate.sh
   sudo systemctl restart discord-fluxer-bridge
   journalctl -u discord-fluxer-bridge -f
   ```

> `install.sh` **n'active le service que si les tokens sont déjà présents** ;
> sinon il attend l'étape 4. Il est idempotent : après un `git pull`, relancez
> `sudo bash install.sh` pour reconstruire.
>
> **Sans systemd** (conteneur minimé) : `install.sh` écrit un mode avant-plan
> `deploy/lxc/run.sh` pour lancer le pont (ex. `tmux new -s dxf 'bash
> deploy/lxc/run.sh'`).

Accès au serveur d'état : dans `config/config.yaml`, passer
`admin.status_host: "0.0.0.0"` pour l'atteindre via l'IP du conteneur/VM
(`curl http://<ip>:8083/health`) — ou garder `127.0.0.1` et utiliser un tunnel
SSH (`ssh -L 8083:127.0.0.1:8083 user@<ip>`).

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
`dist/`, `data/` et les caches. Depuis la racine du projet :

```bash
git init -b main
git add .
git commit -m "Passerelle Discord <-> Fluxer (texte, fichiers, réactions, voix)"
git remote add origin https://github.com/France-OPG/bot-bridge-discord-fluxer
git push -u origin main
```

> Une fois publié, les utilisateurs n'ont qu'à `git clone` puis `bash install.sh`
> sur leur LXC/VM. Un CI GitHub Actions (`push`/PR) lance automatiquement
> typecheck + tests + build sur Node 22.