import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageReaction,
  Partials,
  Snowflake,
  User,
} from 'discord.js';
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
import { DiscordWebhookPool, normalizeDiscordAttachments, resolveDiscordAvatar } from './webhookPool.js';
import { DiscordVoicePlatform } from './voice.js';

export interface DiscordAdapterOptions {
  token: string;
  intents: {
    guilds: boolean;
    guild_members: boolean;
    guild_messages: boolean;
    message_content: boolean;
    message_reactions: boolean;
    voice_states: boolean;
  };
  webhookName: string;
  maxFileBytes: number;
  cacheDir: string;
  bucket: RateLimiter;
  http: HttpClient;
  /** Guild Discord ciblée par l'auto-liaison (optionnel). */
  pinnedGuildId?: string;
}

const DEFAULT_MESSAGE_TYPES = new Set([0, 19]);

export class DiscordAdapter implements PlatformAdapter {
  readonly name = 'discord' as const;
  connected = false;

  private readonly opts: DiscordAdapterOptions;
  private readonly client: Client;
  private readonly webhooks: DiscordWebhookPool;
  private watchedTextChannels = new Set<string>();
  private messageHandlers: Array<(msg: BridgeMessage) => void> = [];
  private editHandlers: Array<(edit: BridgeEdit) => void> = [];
  private deleteHandlers: Array<(del: { messageId: string; channelId: string }) => void> = [];
  private reactionHandlers: Array<(reaction: BridgeReaction) => void> = [];
  private started = false;
  private allowReactions = true;

  readonly voice: VoicePlatform | null;

  constructor(options: DiscordAdapterOptions) {
    this.opts = options;
    this.http = options.http;
    const intentsBits: GatewayIntentBits[] = [];
    if (options.intents.guilds) intentsBits.push(GatewayIntentBits.Guilds);
    if (options.intents.guild_members) intentsBits.push(GatewayIntentBits.GuildMembers);
    if (options.intents.guild_messages) intentsBits.push(GatewayIntentBits.GuildMessages);
    if (options.intents.message_content) intentsBits.push(GatewayIntentBits.MessageContent);
    if (options.intents.message_reactions) intentsBits.push(GatewayIntentBits.GuildMessageReactions);
    if (options.intents.voice_states) intentsBits.push(GatewayIntentBits.GuildVoiceStates);

    this.client = new Client({ intents: intentsBits });
    this.webhooks = new DiscordWebhookPool({
      http: this.http,
      bucket: options.bucket,
      webhookName: options.webhookName,
      maxFileBytes: options.maxFileBytes,
      cacheDir: options.cacheDir,
    });
    this.voice = new DiscordVoicePlatform(this.client, options.http);
    this.attachClientEvents();
  }

  private http: HttpClient;

  getSelfId(): string | null {
    return this.client.user?.id ?? null;
  }

  /** Id d'un webhook que le pont utilise dans ce salon, si existant. */
  webhookIdFor(channelId: string): string | undefined {
    return this.webhooks.webhookIdFor(channelId);
  }

  setWatchedTextChannels(ids: Iterable<string>): void {
    this.watchedTextChannels = new Set(ids);
  }

  /** Liste les salons texte (GuildText) visibles du bot, triés par position. */
  async listTextChannels(): Promise<DiscoveredChannel[]> {
    const channels: DiscoveredChannel[] = [];
    let guild = this.client.guilds.cache.first();
    if (this.opts.pinnedGuildId) {
      guild = this.client.guilds.cache.get(this.opts.pinnedGuildId);
    }
    if (!guild) return channels;

    try {
      await guild.channels.fetch();
    } catch (err) {
      getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'cache de salons Discord utilisé');
    }

    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText) continue;
      channels.push({ id: channel.id, name: channel.name, position: channel.rawPosition ?? 0 });
    }
    channels.sort((a, b) => a.position - b.position);
    return channels;
  }

  setReactionsEnabled(enabled: boolean): void {
    this.allowReactions = enabled;
  }

  private attachClientEvents(): void {
    const client = this.client;

    client.on(Events.ClientReady, () => {
      this.connected = true;
      getLogger().info({ user: client.user?.tag, id: client.user?.id }, 'Discord connecté');
    });

    client.on(Events.ShardDisconnect, () => {
      this.connected = false;
      getLogger().warn('Discord déconnecté (reconnexion automatique)');
    });

    client.on('resumed', () => {
      this.connected = true;
      getLogger().info('Session Discord reprise');
    });

    client.on(Events.Warn, (info) => getLogger().warn({ info }, 'avertissement Discord'));

    client.on(Events.Error, (err) => {
      getLogger().error({ err: err.message }, 'erreur Discord');
    });

    client.on('invalidated', () => {
      this.connected = false;
      getLogger().error('Session Discord invalidée — reconnexion requise');
    });

    client.on(Events.MessageCreate, (message: Message) => {
      if (message.guildId === null) return;
      if (!this.watchedTextChannels.has(message.channelId)) return;
      this.emitMessage(this.normalizeMessage(message));
    });

    client.on(Events.MessageUpdate, async (_old, message: Message) => {
      if (message.guildId === null) return;
      if (!this.watchedTextChannels.has(message.channelId)) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return;
        }
      }
      // Éviter de relayer des updates sans changement de contenu.
      if (message.content === undefined) return;
      this.emitEdit({
        platform: 'discord',
        messageId: message.id,
        channelId: message.channelId,
        content: message.content,
      });
    });

    client.on(Events.MessageDelete, (message) => {
      if (!this.watchedTextChannels.has(message.channelId)) return;
      this.emitDelete({ messageId: message.id, channelId: message.channelId });
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
      if (reaction.partial) return;
      const message = reaction.message as Message;
      if (message.guildId === null) return;
      if (!this.watchedTextChannels.has(message.channelId)) return;
      if (user.bot) return;
      this.emitReaction(this.normalizeReaction(reaction as MessageReaction, user as User, true));
    });

    client.on(Events.MessageReactionRemove, (reaction, user) => {
      if (reaction.partial) return;
      const message = reaction.message as Message;
      if (message.guildId === null) return;
      if (!this.watchedTextChannels.has(message.channelId)) return;
      if (user.bot) return;
      this.emitReaction(this.normalizeReaction(reaction as MessageReaction, user as User, false));
    });
  }

  private normalizeMessage(message: Message): BridgeMessage {
    const author = message.author as User;
    let displayName = author.username;
    if (message.member?.displayName) displayName = message.member.displayName;
    else if (author.displayName) displayName = author.displayName;

    let reference;
    if (message.reference?.messageId) {
      reference = {
        messageId: message.reference.messageId,
        channelId: message.reference.channelId ?? undefined,
        authorName: message.mentions.repliedUser?.displayName ?? message.mentions.repliedUser?.username ?? undefined,
      };
    }

    return {
      platform: 'discord',
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? undefined,
      author: {
        id: author.id,
        displayName,
        username: author.username,
        discriminator: author.discriminator,
        avatarUrl: resolveDiscordAvatar(author.displayAvatarURL({ size: 128 })),
        isBot: author.bot ?? false,
      },
      content: message.content,
      attachments: normalizeDiscordAttachments(message),
      timestamp: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
      reference,
      isSystem: !DEFAULT_MESSAGE_TYPES.has(message.type as number) || Boolean(message.webhookId && message.author.bot),
    };
  }

  private normalizeReaction(reaction: MessageReaction, user: User, adding: boolean): BridgeReaction {
    const emoji = reaction.emoji.id
      ? `<${reaction.emoji.name ?? 'a'}:${reaction.emoji.name ?? ''}:${reaction.emoji.id}>`
      : `${reaction.emoji.name ?? ''}`;
    return {
      platform: 'discord',
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
      emoji,
      user: {
        id: user.id,
        displayName: user.displayName || user.username,
        username: user.username,
        isBot: user.bot ?? false,
      },
      adding,
    };
  }

  private emitMessage(msg: BridgeMessage): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  private emitEdit(edit: BridgeEdit): void {
    for (const handler of this.editHandlers) handler(edit);
  }

  private emitDelete(del: { messageId: string; channelId: string }): void {
    for (const handler of this.deleteHandlers) handler(del);
  }

  private emitReaction(reaction: BridgeReaction): void {
    if (!this.allowReactions) return;
    if (reaction.user.id === this.getSelfId()) return;
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
    this.client.destroy();
    this.connected = false;
  }

  async sendMessage(channelId: string, message: OutboundMessage): Promise<OutboundMessageResult> {
    const webhookResult = await this.webhooks.execute(channelId, {
      content: message.content,
      username: message.author?.displayName,
      avatarURL: message.author?.avatarUrl,
      attachments: message.attachments,
      reference: message.reference ? { messageId: message.reference.messageId } : undefined,
    });
    if (webhookResult) {
      return {
        id: webhookResult.id,
        channelId,
        attachments: normalizeDiscordAttachments(webhookResult),
        timestamp: webhookResult.createdAt
          ? webhookResult.createdAt.toISOString()
          : new Date().toISOString(),
      };
    }
    return this.sendAsBot(channelId, message);
  }

  private async sendAsBot(channelId: string, message: OutboundMessage): Promise<OutboundMessageResult> {
    const channel = this.client.channels.cache.get(channelId) as { send: (payload: unknown) => Promise<Message> };
    if (!channel?.send) {
      throw new Error(`Salon Discord ${channelId} introuvable`);
    }
    const files: Array<{ name: string; buffer: Buffer }> = [];
    for (const att of message.attachments.slice(0, 10)) {
      const downloaded = await this.download(att);
      if (downloaded) files.push({ name: downloaded.filename, buffer: downloaded.buffer });
    }
    let content = message.content || '';
    if (message.author?.displayName) {
      content = `**${message.author.displayName}**${content ? `\n${content}` : ''}`;
    }
    const sent = (await channel.send({ content, files })) as Message;
    return {
      id: sent.id,
      channelId,
      attachments: normalizeDiscordAttachments(sent),
      timestamp: sent.createdAt ? sent.createdAt.toISOString() : new Date().toISOString(),
    };
  }

  private async download(att: { url: string; filename: string }): Promise<{ buffer: Buffer; filename: string } | null> {
    const { downloadAttachment } = await import('../../core/attachments.js');
    const result = await downloadAttachment(
      { url: att.url, filename: att.filename },
      { maxBytes: this.opts.maxFileBytes, cacheDir: this.opts.cacheDir },
    );
    return result ? { buffer: result.buffer, filename: result.filename } : null;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const ok = await this.webhooks.editMessage(channelId, messageId, content);
    if (ok) return;
    const response = await this.http.send(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) throw new Error(`Édition du message Discord ${messageId}: HTTP ${response.status}`);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const ok = await this.webhooks.deleteMessage(channelId, messageId);
    if (ok) return;
    const response = await this.http.send(`/channels/${channelId}/messages/${messageId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(`Suppression du message Discord ${messageId}: HTTP ${response.status}`);
  }

  async setReaction(channelId: string, messageId: string, emoji: string, active: boolean): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    const path = `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`;
    const response = await this.http.send(
      path,
      active ? { method: 'PUT' } : { method: 'DELETE' },
      { rateKey: 'reactions' },
    );
    if (response.status === 404 || response.status === 400) return;
    if (!response.ok) throw new Error(`Réaction Discord ${active ? 'add' : 'remove'} : HTTP ${response.status}`);
  }

  async resolveChannel(channelId: string): Promise<PlatformChannel | null> {
    const cached = this.client.channels.cache.get(channelId as Snowflake);
    if (!cached) return null;
    const isVoice = (cached as { isVoiceBased?: () => boolean }).isVoiceBased?.() ?? false;
    return {
      id: cached.id,
      name: (cached as { name?: string }).name ?? cached.id,
      type: isVoice ? 'voice' : 'text',
    };
  }

  async resolveUser(userId: string): Promise<PlatformUserInfo | null> {
    try {
      const user = await this.client.users.fetch(userId);
      return {
        id: user.id,
        displayName: user.displayName || user.username,
        avatarUrl: user.displayAvatarURL({ size: 128 }),
        isBot: user.bot,
      };
    } catch {
      return null;
    }
  }

  /** Accès au client Discord (pour le superviseur/vocal). */
  getClient(): Client {
    return this.client;
  }
}