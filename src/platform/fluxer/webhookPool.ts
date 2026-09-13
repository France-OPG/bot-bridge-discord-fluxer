import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../../logging/logger.js';
import { downloadAttachment } from '../../core/attachments.js';
import { BridgeAttachment } from '../../core/types.js';
import { FluxerMessage, FluxerRest, FluxerWebhook } from './rest.js';

export interface FluxerWebhookPoolOptions {
  rest: FluxerRest;
  webhookName: string;
  maxFileBytes: number;
  cacheDir: string;
  timeoutMs?: number;
}

interface CachedWebhook {
  id: string;
  token: string;
}

/**
 * Gère un webhook par salon Fluxer. Les webhooks Fluxer permettent
 * l'impersonation : envoyer un message avec le nom et l'avatar d'un
 * utilisateur distant.
 */
export class FluxerWebhookPool {
  private readonly opts: FluxerWebhookPoolOptions;
  private readonly pool = new Map<string, CachedWebhook>();

  constructor(options: FluxerWebhookPoolOptions) {
    this.opts = options;
  }

  private persistPath(): string {
    return path.join(this.opts.cacheDir, 'fluxer-webhooks.json');
  }

  load(): void {
    try {
      const file = this.persistPath();
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, CachedWebhook>;
      for (const [channelId, wh] of Object.entries(raw)) this.pool.set(channelId, wh);
    } catch {
      this.pool.clear();
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true });
      const data: Record<string, CachedWebhook> = {};
      for (const [channelId, wh] of this.pool) data[channelId] = wh;
      const tmp = `${this.persistPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      writeFileSync(this.persistPath(), JSON.stringify(data), 'utf8');
    } catch {
      /* la persistance est best-effort */
    }
  }

  webhookIdFor(channelId: string): string | undefined {
    return this.pool.get(channelId)?.id;
  }

  async ensure(channelId: string): Promise<CachedWebhook | null> {
    const cached = this.pool.get(channelId);
    if (cached) return cached;

    const existing = await this.opts.rest.listWebhooks(channelId);
    const found = existing.find((w: FluxerWebhook) => w.token && (w.name === this.opts.webhookName || w.name.startsWith(this.opts.webhookName)));
    let webhook = found;
    if (!webhook) {
      webhook = await this.opts.rest.createWebhook(channelId, this.opts.webhookName) ?? undefined;
    }
    if (!webhook?.token) return null;
    const entry: CachedWebhook = { id: webhook.id, token: webhook.token };
    this.pool.set(channelId, entry);
    this.persist();
    return entry;
  }

  async execute(
    channelId: string,
    payload: {
      content: string;
      username?: string;
      avatarUrl?: string;
      attachments: BridgeAttachment[];
    },
  ): Promise<FluxerMessage | null> {
    const webhook = await this.ensure(channelId);
    if (!webhook) {
      getLogger().warn({ channelId }, 'webhook Fluxer indisponible — repli bot');
      return null;
    }

    const fileBuffers: Array<{ buffer: Buffer; filename: string }> = [];
    for (const attachment of payload.attachments.slice(0, 10)) {
      const downloaded = await downloadAttachment(attachment, {
        maxBytes: this.opts.maxFileBytes,
        cacheDir: this.opts.cacheDir,
      });
      if (!downloaded) continue;
      fileBuffers.push({ buffer: downloaded.buffer, filename: downloaded.filename });
    }

    let result: FluxerMessage | null = null;
    try {
      result = await this.opts.rest.executeWebhook(webhook.id, webhook.token, {
        content: payload.content,
        username: payload.username,
        avatar_url: payload.avatarUrl,
        fileBuffers,
      });
    } catch (err) {
      getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'exécution webhook Fluxer échouée');
      return null;
    }
    return result;
  }
}