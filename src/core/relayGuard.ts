import { LinkStore } from './store.js';
import { BridgeMessage, PlatformName, SeenMessage } from './types.js';

/**
 * Protection anti-boucle : un message relayé vers l'autre plateforme ne doit
 * jamais être retransmis vers la plateforme d'origine, quelle que soit la
 * chaîne d'événements qui remonte.
 */
export class RelayGuard {
  private readonly store: LinkStore;
  private readonly signature: string;
  private selfIds = new Map<PlatformName, string>();
  private webhookIds = new Map<PlatformName, Set<string>>();

  constructor(store: LinkStore, signature: string) {
    this.store = store;
    this.signature = signature;
  }

  setSelfId(platform: PlatformName, id: string): void {
    this.selfIds.set(platform, id);
  }

  registerWebhook(platform: PlatformName, webhookId: string): void {
    if (!this.webhookIds.has(platform)) this.webhookIds.set(platform, new Set());
    this.webhookIds.get(platform)!.add(webhookId);
  }

  isOwnAuthor(msg: BridgeMessage): boolean {
    return msg.author.isBot && msg.author.id === this.selfIds.get(msg.platform);
  }

  /**
   * Indique si un message reçu doit être ignoré (il a été créé par le pont).
   * @param msg message normalisé reçu d'une plateforme
   * @param webhookId identifiant du webhook du pont sur cette plateforme (si applicable)
   */
  shouldIgnore(msg: BridgeMessage, webhookId?: string): boolean {
    // 1. Écrit par le bot du pont lui-même.
    if (this.isOwnAuthor(msg)) return true;

    // 2. Écrit via un webhook appartenant au pont.
    if (webhookId) {
      const set = this.webhookIds.get(msg.platform);
      if (set && set.has(webhookId)) return true;
    }

    // 3. Identifiant connu comme créé par le pont (correspondance déjà enregistrée).
    if (this.store.has(msg.platform, msg.id)) return true;

    // 4. Signature de contenu (défense contre les doubles ponts / resynchronisations).
    if (this.signature && msg.content.endsWith(this.signature)) return true;

    return false;
  }

  /**
   * Enregistre un message relayé. `relayedId` est l'identifiant du message
   * créé sur la plateforme cible.
   */
  recordRelayed(msg: BridgeMessage, relayedId: string, targetPlatform: PlatformName, remoteChannelId: string): void {
    const entry: SeenMessage = {
      platform: msg.platform,
      id: msg.id,
      relayedId,
      sourceId: msg.id,
      channelId: msg.channelId,
      remoteChannelId,
      authorName: msg.author.displayName,
      contentPreview: msg.content.slice(0, 200),
      createdAt: Date.now(),
    };
    this.store.record(entry);

    const remoteEntry: SeenMessage = {
      platform: targetPlatform,
      id: relayedId,
      relayedId: msg.id,
      sourceId: msg.id,
      channelId: remoteChannelId,
      remoteChannelId: msg.channelId,
      authorName: msg.author.displayName,
      contentPreview: msg.content.slice(0, 200),
      createdAt: Date.now(),
    };
    this.store.record(remoteEntry);
  }
}