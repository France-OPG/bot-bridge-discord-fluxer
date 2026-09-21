export interface DiscordConfig {
  token: string;
  intents: {
    guilds: boolean;
    guild_members: boolean;
    guild_messages: boolean;
    message_content: boolean;
    message_reactions: boolean;
    voice_states: boolean;
  };
}

export interface FluxerConfig {
  base_url: string;
  token: string;
}

export interface VoiceLinkConfig {
  enabled: boolean;
  discord_channel_id: string;
  fluxer_channel_id: string;
}

export interface LinkConfig {
  name: string;
  discord_channel_id: string;
  fluxer_channel_id: string;
  text: boolean;
  voice?: VoiceLinkConfig;
}

export interface BridgeConfig {
  name: string;
  signature: string;
  /** Analyse automatique des salons texte et création des liaisons. */
  autolink: boolean;
  /** Guild Discord utilisée pour l'auto-liaison (défaut : première disponible). */
  discord_guild_id?: string;
  display: { discord: string; fluxer: string };
  relay: {
    messages: boolean;
    edits: boolean;
    deletes: boolean;
    replies: boolean;
    reactions: boolean;
    attachments: boolean;
    system_messages: boolean;
  };
  emoji_mode: 'text' | 'raw' | 'strip';
  attachments: { max_size_mb: number; cache_dir: string };
}

export interface AdminConfig {
  status_host: string;
  status_port: number;
}

export interface LoggingConfig {
  level: string;
  json: boolean;
  redact: string[];
}

export interface AppConfig {
  bridge: BridgeConfig;
  discord: DiscordConfig;
  fluxer: FluxerConfig;
  links: LinkConfig[];
  admin: AdminConfig;
  logging: LoggingConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const truthy = (v: unknown): boolean => v === true || v === 'true';

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`La configuration "${path}" doit être une chaîne non vide.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`La configuration "${path}" doit être un nombre.`);
  }
  return value;
}

/**
 * Accepte un nombre explicite ou une chaîne numérique (cas des variables
 * d'environnement interpolées, ex. `status_port: ${STATUS_PORT}`).
 */
function optionalNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return requireNumber(value, path);
}

export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const bridge = (raw.bridge ?? {}) as Record<string, unknown>;
  if (bridge.signature !== undefined && typeof bridge.signature !== 'string') {
    throw new ConfigError('La configuration "bridge.signature" doit être une chaîne de caractères.');
  }

  const discord = (raw.discord ?? {}) as Record<string, unknown>;
  const fluxer = (raw.fluxer ?? {}) as Record<string, unknown>;

  const discordToken = requireString(discord.token ?? '', 'discord.token');
  if (!discordToken.startsWith('http') && discordToken.includes(' ')) {
    throw new ConfigError('discord.token contient des espaces : vérifiez le fichier .env.');
  }

  const fluxerToken = requireString(fluxer.token ?? '', 'fluxer.token');
  if (fluxerToken.includes(' ') || !fluxerToken.includes('.')) {
    throw new ConfigError('fluxer.token doit être au format "<application_id>.<secret>" (voir .env).');
  }

  const baseUrl = requireString(fluxer.base_url ?? '', 'fluxer.base_url');
  let normalizedUrl = baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(normalizedUrl)) {
    throw new ConfigError('fluxer.base_url doit commencer par http:// ou https://.');
  }
  if (!/\/v1$/.test(normalizedUrl)) {
    normalizedUrl = `${normalizedUrl}/v1`;
  }

  const intents = (discord.intents ?? {}) as Record<string, unknown>;

  const linksRaw = Array.isArray(raw.links) ? (raw.links as unknown[]) : [];

  const links: LinkConfig[] = linksRaw.map((entry, i) => {
    const link = (entry ?? {}) as Record<string, unknown>;
    const name = typeof link.name === 'string' && link.name.length > 0 ? link.name : `link-${i + 1}`;
    const discordChannelId = requireString(String(link.discord_channel_id ?? ''), `links[${i}].discord_channel_id`);
    const fluxerChannelId = requireString(String(link.fluxer_channel_id ?? ''), `links[${i}].fluxer_channel_id`);

    let voice: VoiceLinkConfig | undefined;
    const v = link.voice as Record<string, unknown> | undefined;
    if (v && typeof v === 'object') {
      voice = {
        enabled: truthy(v.enabled),
        discord_channel_id: String(v.discord_channel_id ?? ''),
        fluxer_channel_id: String(v.fluxer_channel_id ?? ''),
      };
    }

    return {
      name,
      discord_channel_id: discordChannelId,
      fluxer_channel_id: fluxerChannelId,
      text: link.text === undefined ? true : truthy(link.text),
      voice,
    };
  });

  const admin = (raw.admin ?? {}) as Record<string, unknown>;
  const logging = (raw.logging ?? {}) as Record<string, unknown>;
  const attachments = ((bridge.attachments ?? {}) as Record<string, unknown>);

  return {
    bridge: {
      name: typeof bridge.name === 'string' ? bridge.name : 'bridge',
      signature: typeof bridge.signature === 'string' ? bridge.signature : '',
      autolink: bridge.autolink === undefined ? true : truthy(bridge.autolink),
      discord_guild_id:
        typeof bridge.discord_guild_id === 'string' && bridge.discord_guild_id.trim() !== ''
          ? bridge.discord_guild_id.trim()
          : undefined,
      display: {
        discord: typeof (bridge.display as Record<string, unknown>)?.discord === 'string'
          ? ((bridge.display as Record<string, unknown>).discord as string)
          : 'Discord',
        fluxer: typeof (bridge.display as Record<string, unknown>)?.fluxer === 'string'
          ? ((bridge.display as Record<string, unknown>).fluxer as string)
          : 'Fluxer',
      },
      relay: {
        messages: truthy((bridge.relay as Record<string, unknown> | undefined)?.messages) ?? true,
        edits: truthy((bridge.relay as Record<string, unknown>)?.edits) ?? true,
        deletes: truthy((bridge.relay as Record<string, unknown>)?.deletes) ?? true,
        replies: truthy((bridge.relay as Record<string, unknown>)?.replies) ?? true,
        reactions: truthy((bridge.relay as Record<string, unknown>)?.reactions) ?? true,
        attachments: truthy((bridge.relay as Record<string, unknown>)?.attachments) ?? true,
        system_messages: truthy((bridge.relay as Record<string, unknown>)?.system_messages) ?? false,
      },
      emoji_mode: ['text', 'raw', 'strip'].includes(String(bridge.emoji_mode ?? 'text'))
        ? (bridge.emoji_mode as 'text' | 'raw' | 'strip')
        : 'text',
      attachments: {
        max_size_mb: optionalNumber(attachments.max_size_mb, 24, 'bridge.attachments.max_size_mb'),
        cache_dir: typeof attachments.cache_dir === 'string' ? attachments.cache_dir : './data/attachments',
      },
    },
    discord: {
      token: discordToken,
      intents: {
        guilds: truthy(intents.guilds),
        guild_members: truthy(intents.guild_members),
        guild_messages: truthy(intents.guild_messages),
        message_content: truthy(intents.message_content),
        message_reactions: truthy(intents.message_reactions),
        voice_states: truthy(intents.voice_states),
      },
    },
    fluxer: {
      base_url: normalizedUrl,
      token: fluxerToken,
    },
    links,
    admin: {
      status_host: typeof admin.status_host === 'string' ? admin.status_host : '127.0.0.1',
      status_port: optionalNumber(admin.status_port, 8083, 'admin.status_port'),
    },
    logging: {
      level: typeof logging.level === 'string' ? logging.level : 'info',
      json: logging.json === false ? false : true,
      redact: Array.isArray(logging.redact) ? (logging.redact as string[]) : [],
    },
  };
}