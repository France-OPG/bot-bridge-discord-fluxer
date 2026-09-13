# Analyse technique — Discord ⇄ Fluxer

## 1. Deux plateformes "presque" identiques

### Fluxer (fluxerapp/fluxer)
- Plateforme de messagerie/voix **open-source (AGPLv3)**, auto-hébergeable,
  dont l'API REST (`/<version>` préfixé `/v1`) et le Gateway WebSocket
  reprennent la sémantique des API de Discord (payloads de messages, webhooks,
  réactions, voice states, ops gateway tels que `4` = voice state update).
- **Voice = LiveKit** : il n'y a pas de protocole vocal maison. Les bots
  obtiennent un token via
  `POST /channels/{channel_id}/voice/token` → `{ token, endpoint, connection_id }`
  puis rejoignent un `Room` LiveKit. C'est la stratégie documentée et retenue.
- SDK officiel : `@fluxerjs/core` **(v3.0.0, requiert Node ≥ 22.13)** ;
  `@fluxerjs/voice` pour la voix est une surcouche de `@livekit/rtc-node`
  (**pinné `^0.13.24`**).
- **Webhooks avec impersonation** : nom + avatar customs, exactement comme
  Discord. Les messages créés portent `webhook_id`.

### Discord
- SDK officiel `discord.js` **(14.27.0)** + `@discordjs/voice` **(0.19.2,
  Node ≥ 22.12)** + `@discordjs/opus` (0.10.0, prebuilds désormais disponibles).
- API REST `https://discord.com/api/v10/v9`, Gateway (shards), webhooks.

## 2. Choix de la pile

| Approche     | Verdict |
|--------------|---------|
| Python       | Pas de kit officiel Discord récent (discord.py), pas de support Fluxer. |
| Go           | Pas d'implémentation complète du Gateway Fluxer ; LiveKit Go = bindings bas niveau. |
| Rust         | Client Discord bon (serenity) mais pas de carte officielle Fluxer. |
| **Node/TS**  | **Retenu** : `discord.js` (standard) + `@fluxerjs/core` (officiel) + `@livekit/rtc-node` (officiel) — le trio est fourni et tenu à jour par les éditeurs. |

**Versions confirmées sur le registre npm** (2026) : discord.js `14.27.0`,
@discordjs/voice `0.19.2`, @fluxerjs/core `3.0.0`, @livekit/rtc-node
`0.13.24` (latest = 1.0.0 mais on reste aligné sur l'écosystème Fluxer,
qui le référence en `^0.13.24`).

## 3. Architecture cible

- **Bridge Core** (`src/core`) : orchestrateur agnostique, protégé par un
  triple système anti-boucle (`RelayGuard`) et un store de correspondances
  (id originel ⇄ id relayé, persisté en JSON) pour relayer édits/suppressions/
  réactions sans ambiguïté.
- **Adaptateurs** (`src/platform/{discord,fluxer}`) : une `PlatformAdapter`
  par plateforme. L'impersonation (nom + avatar) est faite **via webhooks**,
  avec repli sur un message du bot préfixé `**[Nom]**`.
- **Voice** (`src/audio` + `voiceRouter`) : échange PCM **mono 48 kHz / 20 ms
  (960 échantillons)**, mixé côté routeur et converti selon la plateforme.

## 4. Contraintes confirmées (importantes)

1. **Discord : un bot = un seul flux audio en sortie.** L'API vocale de Discord
   ne permet pas à un bot de publier dans un canal audio/per-user via RTP. On
   n'envoie donc **qu'une seule piste mixée** (le routeur somme les locuteurs).
2. **Fluxer : LiveKit permet 1 piste par participant.** On peut publier
   plusieurs `AudioSource` (option `perUserTracks`, désactivée par défaut :
   on publie une piste mixée unique pour rester symétrique).
3. **Fin de parole Discord** : les flux reçus se terminent par `AfterSilence`
   (1,5 s) — acceptable pour du relais temps réel ; un timeout de purge côté
   routeur coupe les fondus trop longs.
4. **Avatars Fluxer : chemin CDN non entièrement documenté.** Le résolveur essaie
   plusieurs motifs (`/media/avatars/{user}/{hash}`, `/cdn/avatars/…`) avec un
   contrôle HEAD et un cache global multipiste ; en cas d'échec, l'avatar est
   omis (Discord met son avatar de service). Si votre instance héberge les
   avatars ailleurs, il faut adapter `src/platform/fluxer/avatar.ts`.
5. **Autorisations côté Fluxer** : l'édition/suppression de messages créés par
   le bot nécessite la permission équivalente à "Gérer les messages" (les
   webhooks Fluxer n'exposent hypothétiquement pas d'édit/suppression comme
   Discord — on passe par le token du bot).
6. **Gateway voix Fluxer (op 4)** : documenté mais non implémenté côté REST de
   façon garantie ; on privilégie `POST /channels/{id}/voice/token`. Un repli
   op 4 est tenté si le client l'expose, sinon le lien vocal est signalé comme
   non disponible dans les logs.
7. **Node ≥ 22.13 exigé** par `@fluxerjs/core` et `@discordjs/voice` : Docker
   `node:22-bookworm-slim`, et non le Node 20 par défaut de certains postes.

## 5. Anti-boucle (résumé)

Un message relayé est ignoré s'il correspond à :
1. auteur = bot du pont ;
2. `webhook_id` = webhook du pont (enregistré au démarrage et après chaque envoi) ;
3. identifiant déjà enregistré dans le store comme relayé ;
4. contenu se terminant par la **signature** invisible (défense ultime,
   notamment contre les doubles ponts et les proxies d'événements).

## 6. Ce qui reste à valider côté instance réelle

- URL exacte des avatars (voir point 4) ;
- élision/édition des messages de webhooks Fluxer (repli REST bot + permission Gérer les messages) ;
- comportement du Gateway Fluxer sur certains formats (réactions, `guild_id` absent en DM) ;
- latence/jitter réels du tunnel vocal sur le réseau de production.