import { BridgeAttachment, BridgeEdit, BridgeMessage, BridgeReaction, PlatformName, VoiceParticipant } from '../core/types.js';
import { RateLimiter } from '../rate/rateLimiter.js';

/** Résultat d'un envoi : message distant créé. */
export interface OutboundMessageResult {
  id: string;
  channelId: string;
  attachments: BridgeAttachment[];
  timestamp: string;
}

/** Options de création d'un message côté plateforme cible. */
export interface OutboundMessage {
  content: string;
  attachments: BridgeAttachment[];
  reference?: { messageId: string };
  signature?: string;
  author: {
    displayName: string;
    avatarUrl?: string;
    isBot: boolean;
  };
}

/** Un salon associable (texte ou vocal). */
export interface PlatformChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
}

/** Salon texte découvert sur une plateforme (auto-liaison). */
export interface DiscoveredChannel {
  id: string;
  name: string;
  position: number;
}

export interface PlatformUserInfo {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isBot: boolean;
}

/**
 * Contrat minimal que chaque adaptateur de plateforme doit remplir.
 * Discord et Fluxer implémentent cette interface — c'est le point
 * d'extension de l'architecture (le Bridge Core ne connaît que cela).
 */
export interface PlatformAdapter {
  readonly name: PlatformName;
  readonly connected: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Identifiant du compte (bot) du pont sur cette plateforme. */
  getSelfId(): string | null;

  /** Restreint les salons texte surveillés (perf). */
  setWatchedTextChannels(ids: Iterable<string>): void;

  /** Liste les salons texte visibles du compte connecté (auto-liaison). */
  listTextChannels?(): Promise<DiscoveredChannel[]>;

  /** Renvoie l'id du webhook du pont pour un salon (si la plateforme en expose). */
  webhookIdFor?(channelId: string): string | undefined;

  /** Envoie un message, retourne le message distant créé. */
  sendMessage(channelId: string, message: OutboundMessage): Promise<OutboundMessageResult>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Ajoute/révoque une réaction sur un message existant. */
  setReaction(channelId: string, messageId: string, emoji: string, active: boolean): Promise<void>;

  resolveChannel(channelId: string): Promise<PlatformChannel | null>;
  resolveUser(userId: string): Promise<PlatformUserInfo | null>;

  /** Réception des événements normalisés. */
  onMessage(handler: (msg: BridgeMessage) => void): void;
  onMessageEdit(handler: (edit: BridgeEdit) => void): void;
  onMessageDelete(handler: (deletion: { messageId: string; channelId: string }) => void): void;
  onReaction(handler: (reaction: BridgeReaction) => void): void;

  /** Adapter vocal optionnel (null si non supporté). */
  voice: VoicePlatform | null;
}

/** Gestion des events vocaux côté plateforme. */
export interface VoiceParticipantEvent {
  participant: VoiceParticipant;
}

/**
 * Force vocale du pont. Une implémentation se connecte à un salon vocal
 * d'une plateforme, expose l'audio des utilisateurs distants (PCM mono
 * 48 kHz) et transmet notre audio en retour.
 */
export interface VoicePlatform {
  readonly connected: boolean;
  /** Se connecte au salon vocal et commence la capture. */
  connect(channelId: string): Promise<void>;
  /** Se déconnecte du salon vocal. */
  disconnect(): Promise<void>;
  /** Liste des utilisateurs présents dans le salon. */
  participants(): VoiceParticipant[];

  /** Abonnement aux changements de participants. */
  onParticipant(handler: (p: VoiceParticipant) => void): void;
  /** Abonnement aux frames audio reçues des utilisateurs distants. */
  onAudio(handler: (userId: string, pcm: Int16Array) => void): void;
  /** Émet notre propre audio (mélangé) vers le salon. */
  transmit(pcm: Int16Array): void;
  /** Émet l'audio d'un utilisateur distant précis (piste distincte). */
  transmitUser?(userId: string, pcm: Int16Array): void;

  /** Active/désactive la reconnexion automatique sur coupure réseau. */
  setAutoReconnect(enabled: boolean): void;
}

export interface VoiceOptions {
  bucket: RateLimiter;
}

// Réexport sentinelle pour éviter des imports circulaires.
export type { RateLimiter };