import { Attachment, AttachmentBuilder, Message, WebhookClient, WebhookMessageCreateOptions } from 'discord.js';
import { getLogger } from '../../logging/logger.js';
import { downloadAttachment } from '../../core/attachments.js';
import { BridgeAttachment } from '../../core/types.js';
import { RateLimiter } from '../../rate/rateLimiter.js';
import { HttpClient } from '../../rate/httpClient.js';

export interface WebhookPoolOptions {
  http: HttpClient;
  bucket: RateLimiter;
  webhookName: string;
  maxFileBytes: number;
  cacheDir: string;
}

interface StoredWebhook {
  id: string;
  token: string;
}

/**
 * Gère un webhook par salon Discord (création, cache, exécution).
 * Les webhooks permettent d'envoyer des messages avec un nom et un
 * avatar choisis — indispensable pour que le pont ait l'air des
 * utilisateurs qu'il relaie.
 */
export class DiscordWebhookPool {
  private readonly opts: WebhookPoolOptions;
  private readonly pool = new Map<string, WebhookClient>();

  constructor(options: WebhookPoolOptions) {
    this.opts = options;
  }

  webhookIdFor(channelId: string): string | undefined {
    return this.pool.get(channelId)?.id;
  }

  async ensure(channelId: string): Promise<WebhookClient | null> {
    const cached = this.pool.get(channelId);
    if (cached) return cached;

    await this.opts.bucket.acquire();
    const http = this.opts.http;
    try {
      const list = (await http.getJson<StoredWebhook[]>('/channels/' + channelId + '/webhooks')).filter(
        (w) => Boolean(w.token),
      );
      let webhook: StoredWebhook | undefined = list[0];
      if (!webhook) {
        const created = await http.getJson<StoredWebhook>('/channels/' + channelId + '/webhooks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.opts.webhookName }),
        });
        webhook = created;
      }
      if (!webhook?.token) return null;
      const client = new WebhookClient({ id: webhook.id, token: webhook.token });
      this.pool.set(channelId, client);
      return client;
    } catch (err) {
      getLogger().warn({ channelId, err: err instanceof Error ? err.message : String(err) }, 'webhook Discord indisponible');
      return null;
    }
  }

  webhookClient(channelId: string): WebhookClient | null {
    return this.pool.get(channelId) ?? null;
  }

  async execute(
    channelId: string,
    payload: {
      content: string;
      username?: string;
      avatarURL?: string;
      attachments: BridgeAttachment[];
      reference?: { messageId: string };
    },
  ): Promise<Message | null> {
    const webhook = await this.ensure(channelId);
    if (!webhook) return null;

    const files = await this.prepareFiles(payload.attachments);

    const options: WebhookMessageCreateOptions = {};
    if (payload.content) options.content = payload.content;
    if (payload.username) options.username = payload.username.slice(0, 80);
    if (payload.avatarURL) options.avatarURL = payload.avatarURL;
    if (files.length > 0) options.files = files;

    try {
      const optionsWithReply = options as WebhookMessageCreateOptions & { reply?: { messageReference: string } };
      if (payload.reference?.messageId) optionsWithReply.reply = { messageReference: payload.reference.messageId };
      return (await webhook.send(optionsWithReply)) as unknown as Message;
    } catch (err) {
      getLogger().error({ err: err instanceof Error ? err.message : String(err) }, 'échec envoi webhook Discord');
      return null;
    }
  }

  private async prepareFiles(attachments: BridgeAttachment[]): Promise<AttachmentBuilder[]> {
    const out: AttachmentBuilder[] = [];
    for (const attachment of attachments.slice(0, 10)) {
      const downloaded = await downloadAttachment(attachment, {
        maxBytes: this.opts.maxFileBytes,
        cacheDir: this.opts.cacheDir,
      });
      if (!downloaded) continue;
      out.push(new AttachmentBuilder(downloaded.buffer, { name: downloaded.filename }));
    }
    return out;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    const webhook = await this.ensure(channelId);
    if (!webhook) return false;
    try {
      await webhook.editMessage(messageId, { content });
      return true;
    } catch (err) {
      getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'édition webhook Discord échouée');
      return false;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    const webhook = await this.ensure(channelId);
    if (!webhook) return false;
    try {
      await webhook.deleteMessage(messageId);
      return true;
    } catch (err) {
      getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'suppression webhook Discord échouée');
      return false;
    }
  }
}

export function resolveDiscordAvatar(avatarUrl?: string): string | undefined {
  return avatarUrl;
}

export function normalizeDiscordAttachments(message: Message): BridgeAttachment[] {
  return message.attachments.map((att: Attachment) => ({
    url: att.url,
    filename: att.name,
    contentType: att.contentType ?? undefined,
    size: att.size,
    width: att.width ?? undefined,
    height: att.height ?? undefined,
  }));
}