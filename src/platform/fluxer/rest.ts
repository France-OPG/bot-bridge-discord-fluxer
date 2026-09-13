import { HttpClient } from '../../rate/httpClient.js';

export interface FluxerAuthor {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export interface FluxerAttachment {
  id: string;
  filename: string;
  content_type?: string | null;
  size?: number;
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface FluxerMessage {
  id: string;
  channel_id: string;
  author: FluxerAuthor;
  content: string;
  timestamp: string;
  type?: number;
  attachments?: FluxerAttachment[] | null;
  embeds?: Array<Record<string, unknown>> | null;
  message_reference?: { message_id?: string; channel_id?: string } | null;
  referenced_message?: { id?: string; author?: Partial<FluxerAuthor>; content?: string; type?: number } | null;
  webhook_id?: string | null;
  flags?: number;
  pinned?: boolean;
  reactions?: Array<{ emoji: { name: string | null; id?: string | null }; count?: number }> | null;
}

export interface FluxerWebhook {
  id: string;
  token?: string | null;
  name: string;
  channel_id: string;
}

export interface FluxerVoiceToken {
  token: string;
  endpoint: string;
  connection_id?: string;
  token_nonce?: string;
}

/**
 * Client REST Fluxer (webhooks, messages, réactions, voix). Utilisé en
 * complément du SDK @fluxerjs/core quand on a besoin d'endpoints précis
 * (webhooks), ou pour éviter de dépendre de ses internes.
 */
export class FluxerRest {
  constructor(
    private readonly http: HttpClient,
    private readonly token: string,
  ) {}

  private auth(): Record<string, string> {
    return { Authorization: `Bot ${this.token}` };
  }

  async createWebhook(channelId: string, name: string): Promise<FluxerWebhook | null> {
    try {
      return await this.http.getJson<FluxerWebhook>(`/channels/${channelId}/webhooks`, {
        method: 'POST',
        headers: { ...this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch {
      return null;
    }
  }

  async listWebhooks(channelId: string): Promise<FluxerWebhook[]> {
    try {
      return await this.http.getJson<FluxerWebhook[]>(`/channels/${channelId}/webhooks`, {
        headers: this.auth(),
      });
    } catch {
      return [];
    }
  }

  /**
   * Exécute un webhook (message avec nom/avatar custom).
   * `text` peut être absent si l'on n'envoie que des fichiers.
   */
  async executeWebhook(
    webhookId: string,
    webhookToken: string,
    payload: {
      content?: string;
      username?: string;
      avatar_url?: string;
      fileBuffers?: Array<{ buffer: Buffer; filename: string }>;
    },
  ): Promise<FluxerMessage | null> {
    const form = new FormData();
    if (payload.content) form.append('content', payload.content);
    if (payload.username) form.append('username', payload.username.slice(0, 80));
    if (payload.avatar_url) form.append('avatar_url', payload.avatar_url);
    for (const file of payload.fileBuffers ?? []) {
      form.append('files[]', new Blob([file.buffer], { type: 'application/octet-stream' }), file.filename);
    }

    try {
      const response = await this.http.send(`/webhooks/${webhookId}/${webhookToken}`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text ? (JSON.parse(text) as FluxerMessage) : null;
    } catch {
      return null;
    }
  }

  async sendMessage(
    channelId: string,
    payload: { content?: string; fileBuffers?: Array<{ buffer: Buffer; filename: string }> },
  ): Promise<FluxerMessage | null> {
    const form = new FormData();
    if (payload.content) form.append('content', payload.content);
    for (const file of payload.fileBuffers ?? []) {
      form.append('files[]', new Blob([file.buffer], { type: 'application/octet-stream' }), file.filename);
    }
    try {
      const response = await this.http.send(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: this.auth(),
        body: form,
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text ? (JSON.parse(text) as FluxerMessage) : null;
    } catch {
      return null;
    }
  }

  async editMessageNoWebhook(channelId: string, messageId: string, content: string): Promise<boolean> {
    const response = await this.http.send(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  }

  async deleteMessageNoWebhook(channelId: string, messageId: string): Promise<boolean> {
    const response = await this.http.send(`/channels/${channelId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: this.auth(),
    });
    return response.ok;
  }

  async setReaction(channelId: string, messageId: string, emoji: string, active: boolean): Promise<boolean> {
    const encoded = encodeURIComponent(emoji);
    const path = `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`;
    const response = await this.http.send(path, {
      method: active ? 'PUT' : 'DELETE',
      headers: this.auth(),
    });
    return response.ok || response.status === 204;
  }

  async voiceToken(channelId: string): Promise<FluxerVoiceToken | null> {
    try {
      const token = await this.http.getJson<FluxerVoiceToken>(
        `/channels/${channelId}/voice/token`,
        {
          method: 'POST',
          headers: this.auth(),
          body: JSON.stringify({}),
        },
        { rateKey: 'voice' },
      );
      return token && token.token && token.endpoint ? token : null;
    } catch {
      return null;
    }
  }

  async getChannel(channelId: string): Promise<{ id: string; name?: string; type?: number } | null> {
    try {
      return await this.http.getJson<{ id: string; name?: string; type?: number }>(`/channels/${channelId}`, {
        headers: this.auth(),
      });
    } catch {
      return null;
    }
  }
}