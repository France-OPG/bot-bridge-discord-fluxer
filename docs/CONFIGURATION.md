# Configuration

Deux fichiers : **`.env`** (secrets et variables) et **`config/config.yaml`**
(ou `config.yml` / `config.json`). Les chaînes `}{VAR}` du YAML sont
remplacées par les variables d'environnement (.env / processus).

Le chemin est résolu dans l'ordre :
`--config <chemin>` > `BRIDGE_CONFIG` > `config/config.yaml` > `config/config.yml` > `config/config.json`

---

## `.env`

| Variable          | Description                                            |
|-------------------|--------------------------------------------------------|
| `DISCORD_TOKEN`   | Token du bot Discord (Dev Portal)                      |
| `FLUXER_API_URL`  | URL de base de l'API Fluxer (ex. `https://chat.example.com/v1`) |
| `FLUXER_TOKEN`    | Token Fluxer `<application_id>.<secret>`               |
| `LOG_LEVEL`       | `trace | debug | info | warn | error`                  |
| `STATUS_PORT`     | Port du serveur de statut (défaut `8083`)              |

> **Ne committez jamais le fichier `.env`** (il est dans `.gitignore`).

---

## `config/config.yaml`

### `bridge`

| Clé | Type | Défaut | Description |
|-----|------|--------|-------------|
| `name` | string | `bridge` | Nom du pont (nom des webhooks créés + logs). Type Max 80 caractères pour un username de webhook. |
| `signature` | string | `""` | Marqueur ajouté en fin de message relayé (anti-boucle). `""` = aucun ajout visible. |
| `display.discord` | string | `Discord` | Préfixe `[Discord]` visible côté Fluxer. |
| `display.fluxer` | string | `Fluxer` | Préfixe `[Fluxer]` visible côté Discord. |
| `relay.messages` | bool | `true` | Relayer les messages. |
| `relay.edits` | bool | `true` | Relayer les éditions. |
| `relay.deletes` | bool | `true` | Relayer les suppressions. |
| `relay.replies` | bool | `true` | Relayer les réponses (citation `> **Nom** : extrait`). |
| `relay.reactions` | bool | `true` | Relayer les réactions. |
| `relay.attachments` | bool | `true` | Télécharger puis re-poster les pièces jointes. |
| `relay.system_messages` | bool | `false` | Relayer les messages système (arrivées, etc.). |
| `emoji_mode` | enum | `text` | `text` : `<:x:123>` → `:x:` · `raw` : identique · `strip` : supprimés. |
| `attachments.max_size_mb` | number | `24` | Taille max par fichier téléchargé. |
| `attachments.cache_dir` | string | `./data/attachments` | Cache local des pièces jointes (sha1). |

### `discord`

| Clé | Défaut | Rôle |
|-----|--------|------|
| `token` | — | `${DISCORD_TOKEN}` (ne pas y mettre le token en clair). |
| `intents.guilds` | `true` | Nécessaire pour lire les salons/guilds. |
| `intents.guild_members` | `true` | Noms d'affichage des membres. |
| `intents.guild_messages` | `true` | Messages. |
| `intents.message_content` | `true` | Contenu des messages (intent privilégié). |
| `intents.message_reactions` | `true` | Réactions. |
| `intents.voice_states` | `true` | Voix. |

### `fluxer`

| Clé | Description |
|-----|-------------|
| `base_url` | URL de base API (ajoute `/v1` si absent). |
| `token` | `${FLUXER_TOKEN}` — format `<application_id>.<secret>`. |

### `links`  (`discord_channel_id` + `fluxer_channel_id`)

Un lien associe un salon **texte** Discord et un salon **texte** Fluxer.
Le même bloc peut activer le pont vocal (voir `docs/VOICE.md`).

```yaml
links:
  - name: "general"
    discord_channel_id: "123456789012345678"
    fluxer_channel_id: "987654321098765432"
    text: true
    voice:
      enabled: true
      discord_channel_id: "222222222222222222"
      fluxer_channel_id: "333333333333333333"
```

- `text: false` : lien **vocal uniquement** (les messages texte ne passent pas).
- `voice.enabled: false` (défaut) : pas de pont vocal.

### `admin`

| Clé | Défaut | Description |
|-----|--------|-------------|
| `status_host` | `127.0.0.1` | Adresse du serveur de statut. Restez sur `127.0.0.1` ; exposez via un proxy TLS si besoin. |
| `status_port` | `8083` | Port (`${STATUS_PORT}`). |

Endpoints : `/health`, `/status`, `/links`. Aucun secret n'y transite.

### `logging`

| Clé | Défaut | Description |
|-----|--------|-------------|
| `level` | `info` | Niveau pino. |
| `json` | `true` | `true` : logs JSON (Docker) ; `false` : pino-pretty coloré. |
| `redact` | — | Chemins dot à masquer, ex. `["discord.token", "fluxer.token", "*.Authorization"]`. |

---

## Exemple complet

Voir `config/config.example.yaml` (livré avec le dépôt).

## Valider

```bash
pnpm cli validate-config      # affiche un résumé ou l'erreur
pnpm cli links                # affiche les liens interprétés
```