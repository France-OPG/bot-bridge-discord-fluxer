# discord-fluxer-bridge

Passerelle **bidirectionnelle temps réel** entre **Discord** et **Fluxer**
(Node.js + TypeScript). Le pont relaie le texte, les éditions/suppressions,
les réponses, les fichiers, les réactions et **la voix** entre deux salons qui
ne parlent pas la même langue d'hébergement — en imitant le **nom et l'avatar**
de l'utilisateur grâce aux webhooks.

- **Texte** : messages, edits, deletes, réponses citées, fichiers, réactions, avatars.
- **Voix** : pont vocal bidirectionnel mono 48 kHz (LiveKit côté Fluxer, flux Raw côté Discord).
- **Auto-liaison** : à chaque démarrage, le pont analyse les salons texte visibles des
  deux côtés et crée les correspondances tout seul (mêmes noms d'abord, puis par ordre).
- **Robuste** : anti-boucle multicouche, rate limits respectés, reconnexions automatiques,
  logs structurés, arrêt propre, serveur de santé HTTP.

Prérequis : un serveur **Linux (Debian 12+ ou Ubuntu 22.04+)** — conteneur LXC,
VM ou serveur nu. Le bot Discord doit être invité sur votre serveur
(Les permissions Administrateur suffisent).

---

## Installation — une seule ligne

```bash
git clone https://github.com/France-OPG/bot-bridge-discord-fluxer && cd bot-bridge-discord-fluxer && sudo bash install.sh
```

Le script s'occupe de tout : copie du projet dans `/opt/discord-fluxer-bridge`,
installation de Node.js 22 + pnpm, compilation, création de l'utilisateur
`dxf`, installation du service systemd et des commandes `bbdf-*`.

## Premiers pas

```bash
bbdf-ed        # renseignez vos tokens (Discord, Fluxer)
bbdf-co        # (facultatif) verrouillez des paires de salons / la voix
bbdf-ac        # active le bot
```

Les **salons sont reliés automatiquement** : rien à configurer pour lier les
salons texte. Les correspondances manuelles restent possibles dans
`config/config.yaml` et restent prioritaires.

## Commandes (valables partout sur le système)

| Commande  | Fonction                                                        |
|-----------|-----------------------------------------------------------------|
| `bbdf-up` | Met à jour le bot depuis GitHub (recommpile + redémarre, la configuration n'est **jamais** touchée) |
| `bbdf-ac` | **Active** le bot (démarre + s'active au boot)                  |
| `bbdf-de` | **Désactive** le bot (arrêt + retrait du boot)                  |
| `bbdf-ed` | Ouvre `.env` dans un éditeur (tokens Discord / Fluxer)          |
| `bbdf-co` | Ouvre `config/config.yaml` dans un éditeur (salons / options)   |

Toutes les commandes fonctionnent **où que vous soyez** dans la ligne de
commande, sans `.sh` à la fin.

## Logs et état

```bash
journalctl -u discord-fluxer-bridge -f     # logs temps réel
curl http://127.0.0.1:8083/status          # état + compteurs du pont
```

`install.sh` est **idempotent** : relancez-le à volonté (mise à jour, réparation,
changement de chemin). Sans systemd (conteneur minimal) : `bash deploy/lxc/run.sh`.

## Architecture

```
        Discord                           Fluxer
  ┌────────────────────┐           ┌─────────────────────┐
  │  DiscordAdapter     │           │  FluxerAdapter       │
  │  discord.js + REST  │  Bridge   │  @fluxerjs/core +REST│
  │  webhookPool        │◄─────────►│  webhookPool         │
  │  (nom+avatar)       │  Core     │  (nom+avatar)        │
  │  voice (@discordjs/ │◄─────────►│  voice (LiveKit)     │
  │   voice, 1 flux)    │ VoiceRouter│  AudioSource 48k mono│
  └────────────────────┘           └─────────────────────┘
        Anti-boucle : RelayGuard + signature + LinkStore (JSON)
```

Le cœur (`src/core/bridge.ts`) ne connaît que des **adaptateurs normalisés**
(`PlatformAdapter`, `VoicePlatform`) : ajouter une plateforme = implémenter une
interface.

## Documentation

- `docs/INSTALLATION.md` — prérequis, permissions des bots, installation.
- `docs/CONFIGURATION.md` — référence complète de la configuration.
- `docs/VOICE.md` — le pont vocal en détail et ses limites.
- `docs/ANALYSE.md` — analyse technique des deux plateformes et choix d'architecture.