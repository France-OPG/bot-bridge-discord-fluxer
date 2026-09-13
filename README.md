# discord-fluxer-bridge

Passerelle bidirectionnelle **temps réel** entre **Discord** et **Fluxer**
(messagerie et VoIP open-source, auto-hébergeable), en **Node.js + TypeScript**.

Le pont relaie le texte, les éditions/suppressions, les réponses, les pièces
jointes, les réactions et **la voix** entre deux (ou plusieurs) couples de
salons, en s'appuyant sur les webhooks des deux plateformes pour **imiter le
nom et l'avatar** des utilisateurs de l'autre côté.

- **Texte** : messages, edits, deletes, replies (citations), fichiers, réactions, avatars.
- **Voix** : pont vocal bidirectionnel mono 48 kHz, via LiveKit côté Fluxer et le flux "Raw" côté Discord.
- **Robustesse** : anti-boucle multicouche, rate limits respectés, reconnexions automatiques, logs structurés, arrêt propre.
- **Opérationnel** : Docker Compose, **conteneur LXC Proxmox**, CLI, serveur de santé HTTP (`/health`, `/status`).

> ⚠️ Nécessite **Node ≥ 22.13** (contrainte du SDK `@fluxerjs/core` et de
> `@discordjs/voice`). Voir `docs/INSTALLATION.md`.

---

## Démarrage rapide (Docker)

```bash
cp .env.example .env                    # remplissez les tokens
cp config/config.example.yaml config/config.yaml   # renseignez vos salons
docker compose up -d --build
docker compose logs -f discord-fluxer-bridge
curl http://127.0.0.1:8083/status       # état du pont
```

## Démarrage rapide (source)

```bash
pnpm install          # pnpm (npm est corrompu sur certains postes)
pnpm dev              # ou : pnpm build && pnpm start
```

## Démarrage rapide (LXC / VM)

Sur un conteneur LXC ou une VM Linux (Debian 12+, Ubuntu 22.04+), créez votre
système, puis clonez et lancez l'installateur :

```bash
git clone https://github.com/France-OPG/bot-bridge-discord-fluxer
cd bot-bridge-discord-fluxer
sudo bash install.sh          # Node 22 + build + service, tout en un

# Une seule fois — les secrets :
nano .env                     # DISCORD_TOKEN, FLUXER_API_URL, FLUXER_TOKEN
nano config/config.yaml       # identifiants de salons (texte/voix)

# Validation puis démarrage :
sudo bash deploy/lxc/validate.sh
sudo systemctl enable --now discord-fluxer-bridge
journalctl -u discord-fluxer-bridge -f
```

`install.sh` est **idempotent** : relancez-le après un `git pull` pour mettre à
jour. Sans systemd : mode avant-plan `bash deploy/lxc/run.sh`. Détails et
accès au serveur d'état dans `docs/INSTALLATION.md`.

Commandes utiles :

```bash
pnpm cli validate-config        # vérifie la configuration
pnpm cli links                  # liste les liens configurés
pnpm cli status                 # statistiques du serveur de statut
pnpm test                       # tests unitaires
pnpm typecheck                  # vérification des types
```

---

## Architecture

```
        Discord                           Fluxer
  ┌────────────────────┐           ┌─────────────────────┐
  │  DiscordAdapter     │           │  FluxerAdapter       │
  │  discord.js + REST  │           │  @fluxerjs/core +REST│
  │  webhookPool        │  Bridge   │  webhookPool         │
  │  (nom+avatar via    │◄─────────►│  (nom+avatar via     │
  │   webhooks)         │  Core     │   webhooks)          │
  │  voice (@discordjs/ │◄─────────►│  voice (LiveKit)     │
  │   voice, 1 flux)    │ VoiceRouter│  AudioSource 48k mono│
  └────────────────────┘           └─────────────────────┘
        Anti-boucle : RelayGuard + signature + LinkStore (JSON)
```

Le cœur (`src/core/bridge.ts`) ne connaît que des **adaptateurs normalisés**
(`PlatformAdapter`, `VoicePlatform`) : ajouter une plateforme = implémenter une
interface. Tous les détails de la recherche et des limites des API sont dans
`docs/ANALYSE.md`.

## Documentation

- `docs/ANALYSE.md` — analyse technique des deux plateformes et choix
  d'architecture (dont les limites confirmées des API).
- `docs/INSTALLATION.md` — prérequis, permissions des bots, installation locale
  et Docker.
- `docs/CONFIGURATION.md` — référence complète de la configuration.
- `docs/VOICE.md` — le pont vocal en détail et ses limites.
- `docs/DEPANNAGE.md` — dépannage pas à pas.

## Licence

AGPL-3.0-only (voir `package.json` et les licences des bibliothèques utilisées,
notamment `fluxerapp/fluxer` et `discord.js`).