# Dépannage

## Erreurs fréquentes au démarrage

| Message / Symptôme | Cause | Résolution |
|---------------------|-------|------------|
| `Aucun fichier de configuration trouvé` | `config/config.yaml` absent ou `BRIDGE_CONFIG` mal défini | `cp config/config.example.yaml config/config.yaml` et remplir. |
| `La configuration "fluxer.token" doit être au format…` | Token mal formé ou variable non interpolée | Vérifiez que `${FLUXER_TOKEN}` dans le YAML et que `.env` contient `FLUXER_TOKEN=12345.abcde` (2 parties séparées par un point). |
| `Cannot find module 'abbrev'` (npm) | Installation npm globale corrompue | Utilisez **pnpm** : `corepack enable` puis `pnpm install`. |
| `ERR_REQUIRE_ESM` / error sur import | Node < 22 ou mauvais moduleSystem | Installez Node ≥ 22.13 (`nvm install 22`) ou utilisez Docker. |
| `Package "livekit-client" requires a peer` | Incohérence entre `@fluxerjs/voice` et `@livekit/rtc-node` | Les versions sont pinnées dans `package.json` (0.13.24 pour rtc-node). Supprimez `node_modules` et `pnpm install`. |

---

## Connexion

### Discord
- Le bot ne se connecte pas : vérifiez que le token dans `.env` est **valide**
  (Dev Portal > Bot > Token) et que l'**intent** `Message Content` est activé.
- Les permissions minimales en salon : *Voir les salons*, *Envoyer des messages*,
  *Gérer les messages*, *Gérer les webhooks*, *Ajouter des réactions*.
  Pour la voix : *Se connecter* + *Parler* + *Voir les salons* du salon vocal.

### Fluxer
- `fluxer.base_url` doit pointer vers l'API (souvent `https://…/v1`).
  Le pont ajoute `/v1` si absent. Si votre instance a un préfixe différent
  (rare), mettez la valeur exacte.
- Le token Fluxer a le format `<application_id>.<secret>` : deux segments
  séparés par un point.

---

## Rate limits (429)

Le pont respecte les `Retry-After` des deux côtés. Les backlogs sur les
open-source/cloud sont gérés automatiquement (attente + nouvelles tentatives).
Si le message `429` persiste :

1. Vérifiez que le bot n'est pas utilisé en dehors du pont (autre script) ;
2. Vérifiez que le token n'est pas limité au niveau du serveur tiers ;
3. Regardez les logs (le champ `retryAfterMs` indique l'attente estimée).

---

## Webhooks

### Le pont ne crée pas les webhooks

Le bot a besoin de la permission **Gérer les webhooks** sur chaque salon texte.
Sans cela, le nom/avatar personnalisés ne fonctionnent pas et le pont revient
à un envoi avec préfixe `**[Nom]**`.

### Les edits/suppressions ne fonctionnent pas côté Fluxer

Les messages créés par un webhook Fluxer ne sont pas nécessairement éditables
par le bot (les API des webhooks Fluxer sur les edits/suppressions ne sont pas
entièrement documentées). Le pont passe par le token du bot (`PATCH /messages`)
qui nécessite la permission *Gérer les messages*. Si ça échoue, l'erreur est
journalisée mais le pont continue de fonctionner.

---

## Logs

### Niveau

- `info` : démarrage, opérations principales ;
- `warn` : 429, déconnexions/reconnexions, replis ;
- `error` : erreurs HTTP, exceptions non interceptées.

### Masquage des secrets

Les chemins `discord.token`, `fluxer.token`, `*.Authorization` sont
automatiquement masqués (`[masqué]`) dans les logs. Vous pouvez ajouter des
chemins dans `logging.redact`.

### Format

- JSON (recommandé Docker, `logging.json: true`) ;
- Coloré (`pino-pretty`, `logging.json: false`, en développement).

---

## Santé (status server)

```bash
curl http://127.0.0.1:8083/health   # {"ok":true}
curl http://127.0.0.1:8083/status   # compteurs, état des liens, voix
curl http://127.0.0.1:8083/links    # liste des liens configurés
```

Exposez ce port uniquement via un **proxy TLS** (nginx/Caddy) et restreignez
l'accès (IPs internes uniquement).

---

## Mise à jour

```bash
git pull
pnpm install
pnpm build
# Docker : docker compose up -d --build
```

Le store `data/links.json` est entre-sessions : aucune donnée n'est perdue.