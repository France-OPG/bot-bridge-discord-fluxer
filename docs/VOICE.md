# Voix — Pont vocal Discord ⇄ Fluxer

Le pont vocal permet à **tous les utilisateurs connectés** aux deux salons de
s'entendre, quel que soit le côté. Le routeur audio (`src/audio/voiceRouter.ts`)
procède ainsi :

1. **Côte Discord** : le bot rejoint le salon, souscrit à chaque utilisateur
   (`receiver.subscribe`) et reçoit un flux **stéréo 48 kHz** de type `Raw`
   pour chaque locuteur. Chaque flux est transformé en **mono 48 kHz** (downmix
   2→1 canaux) puis poussé dans un `PcmMixer` côté Fluxer.
2. **Routeur** : les frames mono sont mélangées par `PcmMixer` toutes les
   `960` échantillons (20 ms) ; le résultat est transmis à la plateforme
   cible.
3. **Côte Fluxer** : le bot obtient un **token LiveKit** via
   `POST /channels/{channel_id}/voice/token` (stratégie principale, vérifiée
   dans la documentation Fluxer), rejoint une `Room` LiveKit, publie un
   **`AudioSource`** mono 48 kHz (piste `dxf-mix`) et souscrit aux pistes
   audio distantes (`AudioStream`).
4. Les participants distants de chaque côté sont suivis en temps réel pour les
   métriques (nombre, active links, paquets transmis).

---

## Architecture du routeur (`voiceRouter`)

| Direction | Mixeur | Plateforme source → cible |
|-----------|--------|---------------------------|
| Discord → Fluxer | `mixToFluxer` | `discord.onAudio()` → `fluxer.transmit(frame)` |
| Fluxer → Discord | `mixToDiscord` | `fluxer.onAudio()` → `discord.transmit(frame)` |

Le « silence » d'un locuteur après 900 ms de silence déclenche un `clearUser`
dans le mélangeur correspondant, évitant les artefacts d'écho.

---

## Limites importantes (non contournables)

### Discord : un seul flux audio par bot

L'API vocale de Discord ne permet **qu'une seule piste RTP par bot dans un
salon**. Il est **impossible** de mapper les utilisateurs un par un sur le côté
Discord : tout l'audio distant (Fluxer) doit être mélangé en un seul flux qui
est envoyé via `AudioPlayer` + `PcmPushStream` (type `Raw` stéréo). C'est
pourquoi le bot s'auto-meute (`selfDeaf: false, selfMute: false`).

> Les clients Discord utilisent un encodage unique (opus sur RTP). Le bot
> reçoit ce flux, le découpe, et le retransmet côté Fluxer comme un flux
> LiveKit. Il n'est pas question d'OPUS au sein du routeur : tout est
> **PCM Int16 48 kHz**.

### Fluxer / LiveKit : pistes par participant (potentiellement)

LiveKit autorise **plusieurs `AudioSource`** (un par participant distant) dans
une même `Room`. Le pont supporte cette possibilité via l'option
`perUserTracks` (désactivée par défaut). Cependant, **l'audio qui arrive côté
Discord reste un seul flux mixé** : la granularité LiveKit ne profite qu'aux
extensions éventuelles qui traiteraient les pistes individuellement avant le
relais (stéréo spatialisée, volumes indépendants…).

### Latence et échos

La chaîne `Discord → mono → mixeur → LiveKit` et inversement introduit une
latence de quelques dizaines de millisecondes. Le routeur corrige l'écho en
purgeant les locuteurs silencieux (≥ 900 ms).

---

## Permissions requises

| Plateforme | Permission | But |
|------------|-----------|-----|
| Discord | `Se connecter`, `Parler` | Rejoindre le salon. |
| Discord | `Voir les salons` (salon vocal) | Accéder à l'ID du salon. |
| Fluxer | Accès bot au salon vocal | Nécessaire pour le token LiveKit. |

---

## Configuration

Le bloc `voice` dans un lien (`links[].voice`) :

```yaml
voice:
  enabled: true
  discord_channel_id: "222222222222222222"
  fluxer_channel_id: "333333333333333333"
```

Vous pouvez activer le voix sur **un seul lien** et laisser les autres en
texte seul.

---

## Dépannage voix

| Symptôme | Cause | Résolution |
|----------|-------|------------|
| Le bot n'apparaît pas dans le salon Discord | Channel/Guild pas en cache au démarrage | Le pont pré-fetch les salons ; vérifiez les permissions. |
| `Impossible d'obtenir un token LiveKit` | Le `POST /channels/{id}/voice/token` échoue | Vérifiez `base_url` (doit finir par `/v1`), le token Fluxer, et que LiveKit est actif sur l'instance. |
| Pas de son vers Fluxer | `perUserTracks=false` (défaut) : le mix est envoyé | C'est le comportement normal ; audio dans LiveKit arrivé comme une seule piste. |
| Écho | Locuteurs silencieux non purgés | Le routeur purge après 900 ms ; la vérifiez avec `GET /status` (`voice.packetsForwarded`). |
| `POST /voice/token` 404/403 | Fluxer : permission manquante ou salon vocal non connecté | Attribuez au bot la permission vocale sur le salon Fluxer. |
| Latence perceptible | Réseau (< 50 ms habituel) ou overload CPU | Vérifiez les ressources Docker (`docker stats`). |