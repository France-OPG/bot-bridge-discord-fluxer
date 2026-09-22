import { Client, Events, type GuildChannel, User } from '@fluxerjs/core';
import { getLogger } from '../../logging/logger.js';
import { HttpClient } from '../../rate/httpClient.js';
import { RateLimiter } from '../../rate/rateLimiter.js';
import {
  DiscoveredChannel,
  OutboundMessage,
  OutboundMessageResult,
  PlatformAdapter,
  PlatformChannel,
  PlatformUserInfo,
  VoicePlatform,
} from '../types.js';
import { BridgeEdit, BridgeMessage, BridgeReaction } from '../../core/types.js';
import { FluxerRest, FluxerVoiceToken } from './rest.js';
import { FluxerWebhookPool } from './webhookPool.js';
import { FluxerAvatarResolver } from './avatar.js';
import { FluxerVoicePlatform } from './voice.js';

export interface FluxerAdapterOptions {
  baseUrl: string;
  token: string;
  webhookName: string;
  maxFileBytes: number;
  cacheDir: string;
  bucket: RateLimiter;
  voice?: { perUserTracks?: boolean; gatewayOpFallback?: boolean };
  http?: HttpClient;
}

function isFluxerSelf(client: Client, userId: string): boolean {
  return client.user?.id === userId;
}

const DEFAULT_MESSAGE_TYPES = new Set([0, 19]);

function displayNameOf(user: User): string {
  return user.globalName || user.username || user.id;
}

function toEmojiString(emoji: { id?: string | null; name: string; animated?: boolean }): string {
  if (emoji.id) return `<${emoji.animated ? 'a' : ''}${emoji.name}:${emoji.id}>`;
  return emoji.name || '?';
}

/**
 * Adaptateur Fluxer : Gateway (@fluxerjs/core) pour les événements,
 * REST pour les actions (webhooks, envoi, édits, réactions, voix).
 */
export class FluxerAdapter implements PlatformAdapter {
  readonly name = 'fluxer' as const;
  connected = false;

  private readonly opts: FluxerAdapterOptions;
  private readonly client: Client;
  private readonly rest: FluxerRest;
  private readonly webhooks: FluxerWebhookPool;
  private readonly avatarResolver: FluxerAvatarResolver;
  private watchedTextChannels = new Set<string>();
  private messageHandlers: Array<(msg: BridgeMessage) => void> = [];
  private editHandlers: Array<(edit: BridgeEdit) => void> = [];
  private deleteHandlers: Array<(del: { messageId: string; channelId: string }) => void> = [];
  private reactionHandlers: Array<(reaction: BridgeReaction) => void> = [];
  private started = false;
  private allowReactions = true;

  readonly voice: VoicePlatform | null;

  constructor(options: FluxerAdapterOptions) {
    this.opts = options;
    this.client = new Client();
    this.rest = new FluxerRest(options.http ?? new HttpClient({ baseUrl: options.baseUrl }), options.token);
    this.webhooks = new FluxerWebhookPool({
      rest: this.rest,
      webhookName: options.webhookName,
      maxFileBytes: options.maxFileBytes,
      cacheDir: options.cacheDir,
    });
    this.webhooks.load();

    const origin = options.baseUrl.replace(/\/v1$/, '');
    this.avatarResolver = new FluxerAvatarResolver(origin);

    this.voice = new FluxerVoicePlatform({
      perUserTracks: options.voice?.perUserTracks ?? false,
      tokenProvider: async (channelId) => {
        let token: FluxerVoiceToken | null = await this.rest.voiceToken(channelId);
        if (!token && options.voice?.gatewayOpFallback) token = this.gatewayVoiceToken(channelId);
        return token;
      },
    });

    this.attachClientEvents();
  }

  getSelfId(): string | null {
    return this.client.user?.id ?? null;
  }

  webhookIdFor(channelId: string): string | undefined {
    return this.webhooks.webhookIdFor(channelId);
  }

  setWatchedTextChannels(ids: Iterable<string>): void {
    this.watchedTextChannels = new Set(ids);
  }

  setReactionsEnabled(enabled: boolean): void {
    this.allowReactions = enabled;
  }

  /** Liste les salons texte visibles du bot Fluxer, triés par position. */
  async listTextChannels(): Promise<DiscoveredChannel[]> {
    const result: DiscoveredChannel[] = [];
    const guild = this.client.guilds.first();
    if (!guild) return result;

    let channels: GuildChannel[] = [];
    try {
      channels = await guild.fetchChannels();
    } catch (err) {
      getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'cache de salons Fluxer utilisé');
      channels = [...guild.channels.values()];
    }

    for (const channel of channels) {
      if (!channel.isText() || !channel.name) continue;
      result.push({ id: channel.id, name: channel.name, position: channel.position ?? Number.MAX_SAFE_INTEGER });
    }
    result.sort((a, b) => a.position - b.position);
    return result;
  }

  /** Token voix LiveKit via un op 4 gateway (repli si REST indisponible). */
  private gatewayVoiceToken(channelId: string): FluxerVoiceToken | null {
    if (typeof this.client.sendToGateway !== 'function') return null;
    try {
      const payload = {
        op: 4,
        d: { channel_id: channelId, self_mute: false, self_deaf: false, session_id: null },
      } as unknown as Parameters<Client['sendToGateway']>[1];
      this.client.sendToGateway(0, payload);
      getLogger().warn({ channelId }, 'op 4 envoyé ; le token LiveKit devra être intercepté côté gateway (expérimental)');
      return null;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'op 4 gateway échoué pour la voix Fluxer',
      );
      return null;
    }
  }

  private attachClientEvents(): void {
    const client = this.client;

    client.on(Events.Ready, () => {
      this.connected = true;
      const user = client.user;
      getLogger().info({ id: user?.id, name: user?.globalName }, 'Fluxer connecté');
    });

    client.on(Events.Resumed, () => {
      getLogger().info('Fluxer : session gateway reprise');
    });

    client.on(Events.ShardDisconnect, (shardId, code) => {
      this.connected = false;
      getLogger().warn({ shardId, code }, 'Fluxer déconnecté (reconnexion automatique)');
    });

    client.on(Events.Error, (err: Error) => {
      getLogger().error({ err: err.message }, 'erreur Fluxer');
    });

    client.on(Events.MessageCreate, (message) => {
      void this.wireMessage(message);
    });

    client.on(Events.MessageUpdate, (_old, message) => {
      if (message.content === null) return;
      if (!this.watchedTextChannels.has(message.channelId)) return;
      const edit: BridgeEdit = {
        platform: 'fluxer',
        messageId: message.id,
        channelId: message.channelId,
        content: message.content,
      };
      for (const handler of this.editHandlers) handler(edit);
    });

    client.on(Events.MessageDelete, (message) => {
      if (!this.watchedTextChannels.has(message.channelId)) return;
      for (const handler of this.deleteHandlers) {
        handler({ messageId: message.id, channelId: message.channelId });
      }
    });

    client.on(Events.MessageReactionAdd, (payload) => {
      this.wireReaction(payload, true);
    });

    client.on(Events.MessageReactionRemove, (payload) => {
      this.wireReaction(payload, false);
    });
  }

  private async wireMessage(message: import('@fluxerjs/core').Message): Promise<void> {
    if (!this.watchedTextChannels.has(message.channelId)) return;
    if (isFluxerSelf(this.client, message.author.id)) return;

    const cdnUrl = message.author.avatarURL({ size: 256 });
    const avatarUrl = cdnUrl ?? (await this.avatarResolver.resolve(message.author));

    let reference;
    if (message.messageReference?.messageId) {
      const referenced = message.referencedMessage;
      reference = {
        messageId: message.messageReference.messageId,
        channelId: message.messageReference.channelId,
        authorName: referenced?.author ? displayNameOf(referenced.author) : undefined,
        contentPreview: referenced?.content,
      };
    }

    const bridged: BridgeMessage = {
      platform: 'fluxer',
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? undefined,
      author: {
        id: message.author.id,
        displayName: displayNameOf(message.author),
        username: message.author.username,
        discriminator: message.author.discriminator || undefined,
        avatarUrl,
        isBot: message.author.bot,
      },
      content: message.content,
      attachments: [...message.attachments.values()].map((att) => ({
        url: att.url ?? att.proxyUrl ?? '',
        filename: att.filename,
        contentType: att.contentType ?? undefined,
        size: att.size,
        width: att.width ?? undefined,
        height: att.height ?? undefined,
      })),
      timestamp: message.createdAt.toISOString(),
      reference,
      isSystem: !DEFAULT_MESSAGE_TYPES.has(message.type),
    };

    for (const handler of this.messageHandlers) handler(bridged);
  }

  private wireReaction(
    payload: import('@fluxerjs/core').MessageReactionPayload,
    adding: boolean,
  ): void {
    if (!this.allowReactions) return;
    if (!this.watchedTextChannels.has(payload.channelId)) return;
    if (isFluxerSelf(this.client, payload.userId)) return;

    const emoji = toEmojiString(payload.emoji);

    const reaction: BridgeReaction = {
      platform: 'fluxer',
      messageId: payload.messageId,
      channelId: payload.channelId,
      emoji,
      user: {
        id: payload.user.id,
        displayName: displayNameOf(payload.user),
        username: payload.user.username,
        isBot: payload.user.bot,
      },
      adding,
    };
    for (const handler of this.reactionHandlers) handler(reaction);
  }

  onMessage(handler: (msg: BridgeMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onMessageEdit(handler: (edit: BridgeEdit) => void): void {
    this.editHandlers.push(handler);
  }

  onMessageDelete(handler: (del: { messageId: string; channelId: string }) => void): void {
    this.deleteHandlers.push(handler);
  }

  onReaction(handler: (reaction: BridgeReaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.client.login(this.opts.token);
  }

  async stop(): Promise<void> {
    if (this.voice?.connected) await this.voice.disconnect();
    await this.client.destroy();
    this.connected = false;
  }

  async sendMessage(channelId: string, message: OutboundMessage): Promise<OutboundMessageResult> {
    // Fluxer ignore le username des webhooks : on met le nom DANS le contenu
    // pour que l'auteur soit visible côté Fluxer (le username reste envoyé
    // en secours là où l'impersonation est supportée).
    const authorPrefix = message.author?.displayName
      ? `**${message.author.displayName}**${message.content ? '\n' : ''}`
      : '';
    const content = `${authorPrefix}${message.content}`;
    const webhookResult = await this.webhooks.execute(channelId, {
      content,
      username: message.author?.displayName,
      avatarUrl: message.author?.avatarUrl,
      attachments: message.attachments,
    });
    if (webhookResult) {
      return {
        id: webhookResult.id,
        channelId,
        attachments: (webhookResult.attachments ?? []).map((a) => ({
          url: a.url,
          filename: a.filename ?? 'attachment',
          contentType: a.content_type ?? undefined,
          size: a.size,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
        })),
        timestamp: webhookResult.timestamp ?? new Date().toISOString(),
      };
    }
    return this.sendAsBot(channelId, message);
  }

  private async sendAsBot(channelId: string, message: OutboundMessage): Promise<OutboundMessageResult> {
    const fileBuffers: Array<{ buffer: Buffer; filename: string }> = [];
    for (const att of message.attachments.slice(0, 10)) {
      const { downloadAttachment } = await import('../../core/attachments.js');
      const downloaded = await downloadAttachment(att, {
        maxBytes: this.opts.maxFileBytes,
        cacheDir: this.opts.cacheDir,
      });
      if (downloaded) fileBuffers.push({ buffer: downloaded.buffer, filename: downloaded.filename });
    }
    let content = message.content || '';
    if (message.author?.displayName) {
      content = `**${message.author.displayName}**${content ? `\n${content}` : ''}`;
    }
    const sent = await this.rest.sendMessage(channelId, { content, fileBuffers });
    if (!sent) throw new Error(`Envoi du message dans le salon Fluxer ${channelId} échoué`);
    return {
      id: sent.id,
      channelId,
      attachments: (sent.attachments ?? []).map((a) => ({
        url: a.url,
        filename: a.filename ?? 'attachment',
        contentType: a.content_type ?? undefined,
        size: a.size,
        width: a.width ?? undefined,
        height: a.height ?? undefined,
      })),
      timestamp: sent.timestamp ?? new Date().toISOString(),
    };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const ok = await this.rest.editMessageNoWebhook(channelId, messageId, content);
    if (ok) return;
    throw new Error(`Édition du message Fluxer ${messageId}: impossible (permissions ?)`);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const ok = await this.rest.deleteMessageNoWebhook(channelId, messageId);
    if (ok) return;
    throw new Error(`Suppression du message Fluxer ${messageId}: impossible (permissions ?)`);
  }

  async setReaction(channelId: string, messageId: string, emoji: string, active: boolean): Promise<void> {
    const ok = await this.rest.setReaction(channelId, messageId, emoji, active);
    if (ok) return;
    throw new Error(`Réaction Fluxer ${active ? 'add' : 'remove'} : échec`);
  }

  async resolveChannel(channelId: string): Promise<PlatformChannel | null> {
    const channel = await this.rest.getChannel(channelId);
    if (!channel) return null;
    return {
      id: channel.id,
      name: channel.name ?? channel.id,
      type: channel.type === 2 ? 'voice' : 'text',
    };
  }

  async resolveUser(userId: string): Promise<PlatformUserInfo | null> {
    // Pas d'endpoint public documenté pour résoudre un utilisateur arbitraire
    // par id ; on renvoie une entrée minimale.
    return { id: userId, displayName: userId, isBot: false };
  }
}