import { AppConfig, LinkConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import { RateLimiter } from '../rate/rateLimiter.js';
import { OutboundMessageResult, PlatformAdapter } from '../platform/types.js';
import { buildRelayWithReply, buildRelayedContent } from './format.js';
import { LinkStore } from './store.js';
import { Metrics } from './metrics.js';
import { RelayGuard } from './relayGuard.js';
import { BridgeEdit, BridgeMessage, BridgeReaction, PlatformName } from './types.js';
import { VoiceRouter } from '../audio/voiceRouter.js';

interface ReplyContext {
  authorName: string;
  preview: string;
}

export interface BridgeDeps {
  config: AppConfig;
  store: LinkStore;
  guard: RelayGuard;
  metrics: Metrics;
  discord: PlatformAdapter;
  fluxer: PlatformAdapter;
}

/**
 * Orchestrateur du pont. Relie les événements normalisés des deux
 * plateformes, applique la protection anti-boucle et achemine vers la
 * plateforme cible associée par la configuration.
 */
export class BridgeService {
  private readonly deps: BridgeDeps;
  private readonly adapters: Record<PlatformName, PlatformAdapter>;
  private readonly linksBySource = new Map<PlatformName, Map<string, LinkConfig>>();
  private readonly recentMessages = new Map<PlatformName, Map<string, ReplyContext>>();
  private running = false;
  private readonly voiceRouters = new Map<string, VoiceRouter>();
  private voiceStatsTimer: NodeJS.Timeout | null = null;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.adapters = { discord: deps.discord, fluxer: deps.fluxer };

    for (const link of deps.config.links) {
      if (!this.linksBySource.has('discord')) this.linksBySource.set('discord', new Map());
      if (!this.linksBySource.has('fluxer')) this.linksBySource.set('fluxer', new Map());
      this.linksBySource.get('discord')!.set(link.discord_channel_id, link);
      this.linksBySource.get('fluxer')!.set(link.fluxer_channel_id, link);
      this.recentMessages.set('discord', new Map());
      this.recentMessages.set('fluxer', new Map());
    }
  }

  get owner(): LinkConfig[] {
    return this.deps.config.links;
  }

  adapterFor(platform: PlatformName): PlatformAdapter {
    return this.adapters[platform];
  }

  private linkFor(platform: PlatformName, channelId: string): LinkConfig | undefined {
    return this.linksBySource.get(platform)?.get(channelId);
  }

  private get relay() {
    return this.deps.config.bridge.relay;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const log = getLogger();

    log.info('Démarrage du pont texte…');

    await this.deps.discord.start();
    await this.deps.fluxer.start();

    const discordId = this.deps.discord.getSelfId();
    const fluxerId = this.deps.fluxer.getSelfId();
    if (discordId) this.deps.guard.setSelfId('discord', discordId);
    if (fluxerId) this.deps.guard.setSelfId('fluxer', fluxerId);

    this.registerKnownWebhooks();

    this.deps.metrics.setConnected('discord', this.deps.discord.connected);
    this.deps.metrics.setConnected('fluxer', this.deps.fluxer.connected);

    this.deps.discord.onMessage((msg) => this.handleMessage(msg));
    this.deps.discord.onMessageEdit((edit) => this.handleEdit('discord', edit));
    this.deps.discord.onMessageDelete((del) => this.handleDelete('discord', del));
    this.deps.discord.onReaction((reaction) => this.handleReaction('discord', reaction));

    this.deps.fluxer.onMessage((msg) => this.handleMessage(msg));
    this.deps.fluxer.onMessageEdit((edit) => this.handleEdit('fluxer', edit));
    this.deps.fluxer.onMessageDelete((del) => this.handleDelete('fluxer', del));
    this.deps.fluxer.onReaction((reaction) => this.handleReaction('fluxer', reaction));

    log.info('Pont texte opérationnel.');

    await this.startVoiceLinks();
  }

  private registerKnownWebhooks(): void {
    for (const link of this.deps.config.links) {
      const discordWebhook = this.deps.discord.webhookIdFor?.(link.discord_channel_id);
      if (discordWebhook) this.deps.guard.registerWebhook('discord', discordWebhook);
      const fluxerWebhook = this.deps.fluxer.webhookIdFor?.(link.fluxer_channel_id);
      if (fluxerWebhook) this.deps.guard.registerWebhook('fluxer', fluxerWebhook);
    }
  }

  private async startVoiceLinks(): Promise<void> {
    const log = getLogger();
    const voiceLinks = this.deps.config.links.filter(
      (link) => link.voice?.enabled && link.voice.discord_channel_id && link.voice.fluxer_channel_id,
    );

    if (voiceLinks.length === 0) return;
    if (!this.deps.discord.voice || !this.deps.fluxer.voice) {
      log.warn('La voix est configurée mais une des plateformes ne fournit pas de force vocale.');
      return;
    }

    for (const link of voiceLinks) {
      if (!link.voice) continue;
      const router = new VoiceRouter(this.deps.discord.voice, this.deps.fluxer.voice);
      try {
        await router.connect(link.voice.discord_channel_id, link.voice.fluxer_channel_id);
        this.voiceRouters.set(link.name, router);
        log.info({ link: link.name }, 'Lien vocal Discord ↔ Fluxer connecté');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.metrics.addError(`voix ${link.name}: ${message}`);
        log.error({ link: link.name, err: message }, 'Échec de connexion du lien vocal');
      }
    }

    this.refreshVoiceMetrics();
    this.voiceStatsTimer = setInterval(() => this.refreshVoiceMetrics(), 5000);
    this.voiceStatsTimer.unref?.();
  }

  private refreshVoiceMetrics(): void {
    let participantsDiscord = 0;
    let participantsFluxer = 0;
    for (const router of this.voiceRouters.values()) {
      const counts = router.participantCounts();
      participantsDiscord += counts.discord;
      participantsFluxer += counts.fluxer;
      const packets = router.takePackets();
      if (packets.toFluxer + packets.toDiscord > 0) {
        this.deps.metrics.inc('packetsForwarded', packets.toFluxer + packets.toDiscord);
      }
    }
    this.deps.metrics.setVoice({
      activeLinks: this.voiceRouters.size,
      participantsDiscord,
      participantsFluxer,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const router of this.voiceRouters.values()) {
      try {
        await router.disconnect();
      } catch {
        /* déjà coupé */
      }
    }
    this.voiceRouters.clear();
    if (this.voiceStatsTimer) {
      clearInterval(this.voiceStatsTimer);
      this.voiceStatsTimer = null;
    }
    this.deps.metrics.setVoice({ activeLinks: 0, participantsDiscord: 0, participantsFluxer: 0 });

    await Promise.allSettled([this.deps.discord.stop(), this.deps.fluxer.stop()]);
    getLogger().info('Pont arrêté proprement.');
  }

  private sourceOf(platform: PlatformName): PlatformAdapter {
    return this.adapters[platform];
  }

  private targetOf(platform: PlatformName): PlatformAdapter {
    return platform === 'discord' ? this.adapters.fluxer : this.adapters.discord;
  }

  private remember(platform: PlatformName, messageId: string, context: ReplyContext): void {
    const map = this.recentMessages.get(platform) ?? new Map();
    map.set(messageId, context);
    if (map.size > 500) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    this.recentMessages.set(platform, map);
  }

  private displayNameFor(platform: PlatformName, author: BridgeMessage['author']): string {
    const prefix = this.deps.config.bridge.display[platform];
    return prefix ? `[${prefix}] ${author.displayName}` : author.displayName;
  }

  private buildReplyContext(platform: PlatformName, msg: BridgeMessage): ReplyContext | null {
    if (!msg.reference) return null;
    const entry = this.recentMessages.get(platform)?.get(msg.reference.messageId);
    if (entry) return entry;
    // Défense : si l'id référencé est visible dans le store mais pas en mémoire.
    const seen = this.deps.store.find(platform, msg.reference.messageId);
    if (seen) return { authorName: seen.authorName, preview: seen.contentPreview };
    return null;
  }

  private async handleMessage(msg: BridgeMessage): Promise<void> {
    const log = getLogger();
    const link = this.linkFor(msg.platform, msg.channelId);
    if (!link || !link.text) return;

    if (msg.isSystem && !this.relay.system_messages) return;

    const ownWebhookId = this.sourceOf(msg.platform).webhookIdFor?.(msg.channelId);
    if (this.deps.guard.shouldIgnore(msg, ownWebhookId)) {
      this.deps.metrics.inc('skippedOwnMessages');
      return;
    }
    if (!this.relay.messages) return;

    const target = this.targetOf(msg.platform);
    const targetChannelId = msg.platform === 'discord' ? link.fluxer_channel_id : link.discord_channel_id;

    const replyContext = this.relay.replies ? this.buildReplyContext(msg.platform, msg) : null;
    if (replyContext) this.remember(msg.platform, msg.id, replyContext);

    const content = replyContext
      ? buildRelayWithReply(msg.content, replyContext, {
          emojiMode: this.deps.config.bridge.emoji_mode,
          signature: this.deps.config.bridge.signature,
        })
      : buildRelayedContent(msg.content, {
          emojiMode: this.deps.config.bridge.emoji_mode,
          signature: this.deps.config.bridge.signature,
        });

    const attachments = this.relay.attachments ? msg.attachments : [];
    if (content.trim().length === 0 && attachments.length === 0) return;

    const authorName = this.displayNameFor(msg.platform, msg.author);

    try {
      const result: OutboundMessageResult = await target.sendMessage(targetChannelId, {
        content,
        attachments,
        author: { displayName: authorName, avatarUrl: msg.author.avatarUrl, isBot: msg.author.isBot },
      });

      this.deps.guard.recordRelayed(msg, result.id, target.name, result.channelId);
      const targetWebhookId = target.webhookIdFor?.(targetChannelId);
      if (targetWebhookId) this.deps.guard.registerWebhook(target.name, targetWebhookId);
      if (replyContext) {
        this.remember(target.name, result.id, { authorName, preview: msg.content.slice(0, 200) });
      }
      this.deps.metrics.inc('messagesBridged');
      if (attachments.length > 0) this.deps.metrics.inc('attachmentsBridged', attachments.length);

      if (replyContext) {
        log.info({
          from: msg.platform,
          channel: msg.channelId,
          to: target.name,
          relayedAt: result.id,
          author: msg.author.displayName,
        }, 'message relayé (avec réponse)');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.metrics.addError(`${msg.platform}→${target.name}: ${message}`);
    }
  }

  private async handleEdit(platform: PlatformName, edit: BridgeEdit): Promise<void> {
    if (!this.relay.edits) return;
    const link = this.linkFor(platform, edit.channelId);
    if (!link) return;

    const seen = this.deps.store.find(platform, edit.messageId);
    if (!seen) return; // message non issu du pont (ou déjà supprimé)

    const target = this.targetOf(platform);
    const content = buildRelayedContent(edit.content, {
      emojiMode: this.deps.config.bridge.emoji_mode,
      signature: '',
    });

    if (content.trim().length === 0 && this.relay.attachments) {
      // les pièces jointes n'ont pas changé — ignorer l'édition vide.
      return;
    }

    try {
      await target.editMessage(seen.remoteChannelId, seen.relayedId, content);
      this.deps.metrics.inc('editsBridged');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.metrics.addError(`edit ${platform}→${target.name}: ${message}`);
    }
  }

  private async handleDelete(platform: PlatformName, del: { messageId: string; channelId: string }): Promise<void> {
    if (!this.relay.deletes) return;
    const link = this.linkFor(platform, del.channelId);
    if (!link) return;

    const seen = this.deps.store.find(platform, del.messageId);
    if (!seen) return;

    const target = this.targetOf(platform);
    try {
      await target.deleteMessage(seen.remoteChannelId, seen.relayedId);
      this.deps.metrics.inc('deletesBridged');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.metrics.addError(`delete ${platform}→${target.name}: ${message}`);
    }
    this.deps.store.remove(platform, del.messageId);
    this.deps.store.remove(target.name, seen.relayedId);
  }

  private async handleReaction(platform: PlatformName, reaction: BridgeReaction): Promise<void> {
    if (!this.relay.reactions) return;
    const link = this.linkFor(platform, reaction.channelId);
    if (!link) return;

    const selfId = this.sourceOf(platform).getSelfId();
    if (selfId && reaction.user.id === selfId) return; // ne pas faire écho à nos propres réactions

    const seen = this.deps.store.find(platform, reaction.messageId);
    if (!seen) return;

    const target = this.targetOf(platform);
    try {
      await target.setReaction(seen.remoteChannelId, seen.relayedId, reaction.emoji, reaction.adding);
      this.deps.metrics.inc('reactionsBridged');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.metrics.addError(`reaction ${platform}→${target.name}: ${message}`);
    }
  }
getStatus(): BridgeStatus {
    return {
      metrics: this.deps.metrics.snapshot(),
      links: this.deps.config.links.map((link) => ({
        name: link.name,
        type: link.voice?.enabled ? 'text+voice' : 'text',
        discord_channel_id: link.discord_channel_id,
        fluxer_channel_id: link.fluxer_channel_id,
        voice_active: link.voice?.enabled ? this.voiceRouters.has(link.name) : false,
      })),
    };
  }
}

export interface StatusEndpoint {
  getBridge(): BridgeService;
}

/** Snapshots de l'état du pont pour le serveur de statut. */
export interface BridgeStatus {
  metrics: ReturnType<Metrics['snapshot']>;
  links: Array<{
    name: string;
    type: 'text' | 'text+voice';
    discord_channel_id: string;
    fluxer_channel_id: string;
    voice_active: boolean;
  }>;
}

/** Limiteur partagé à faible volume pour les opérations administratives. */
export function createAdminBucket(): RateLimiter {
  return new RateLimiter(1, 1000);
}