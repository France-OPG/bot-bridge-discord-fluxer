export type PlatformName = 'discord' | 'fluxer';

export interface BridgeUser {
  id: string;
  displayName: string;
  username: string;
  discriminator?: string;
  avatarUrl?: string;
  isBot: boolean;
}

export interface BridgeAttachment {
  url: string;
  filename: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface BridgeMessage {
  platform: PlatformName;
  id: string;
  channelId: string;
  guildId?: string;
  author: BridgeUser;
  content: string;
  attachments: BridgeAttachment[];
  timestamp: string;
  /** Message auquel ce message répond (id + auteur si résolu sur la plateforme source). */
  reference?: {
    messageId: string;
    authorName?: string;
    channelId?: string;
    contentPreview?: string;
  };
  isSystem: boolean;
}

export interface BridgeReaction {
  platform: PlatformName;
  messageId: string;
  channelId: string;
  emoji: string;
  user: BridgeUser;
  adding: boolean;
}

export interface BridgeDelete {
  platform: PlatformName;
  messageId: string;
  channelId: string;
}

export interface BridgeEdit {
  platform: PlatformName;
  messageId: string;
  channelId: string;
  content: string;
}

export interface VoiceParticipant {
  userId: string;
  displayName: string;
  connected: boolean;
  muted: boolean;
  deafened: boolean;
  speaking?: boolean;
}

export interface SeenMessage {
  platform: PlatformName;
  id: string;
  /** Identifiant du message relayé sur l'autre plateforme (s'il existe). */
  relayedId: string;
  /** Identifiant du message d'origine sur l'autre plateforme (résolution des réponses). */
  sourceId: string;
  channelId: string;
  remoteChannelId: string;
  authorName: string;
  contentPreview: string;
  createdAt: number;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  discordConnected: boolean;
  fluxerConnected: boolean;
  text: {
    messagesBridged: number;
    editsBridged: number;
    deletesBridged: number;
    reactionsBridged: number;
    attachmentsBridged: number;
    skippedOwnMessages: number;
  };
  voice: {
    activeLinks: number;
    participantsDiscord: number;
    participantsFluxer: number;
    packetsForwarded: number;
  };
  errors: Array<{ at: string; message: string }>;
}