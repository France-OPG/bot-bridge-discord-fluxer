import { getLogger } from '../logging/logger.js';
import { MetricsSnapshot } from './types.js';

interface ErrorRecord {
  at: string;
  message: string;
}

const MAX_ERRORS = 50;

export class Metrics {
  private startedAt = Date.now();
  private readonly counters = {
    messagesBridged: 0,
    editsBridged: 0,
    deletesBridged: 0,
    reactionsBridged: 0,
    attachmentsBridged: 0,
    skippedOwnMessages: 0,
    packetsForwarded: 0,
  };
  private readonly errors: ErrorRecord[] = [];
  private state: { discord: boolean; fluxer: boolean } = { discord: false, fluxer: false };
  private voice = { activeLinks: 0, participantsDiscord: 0, participantsFluxer: 0 };

  inc<K extends keyof typeof this.counters>(key: K, by = 1): void {
    this.counters[key] += by;
  }

  setConnected(platform: 'discord' | 'fluxer', connected: boolean): void {
    this.state[platform] = connected;
  }

  setVoice(patch: Partial<typeof this.voice>): void {
    Object.assign(this.voice, patch);
  }

  addError(message: string): void {
    getLogger().error({ err: message }, 'erreur bridge');
    this.errors.unshift({ at: new Date().toISOString(), message });
    if (this.errors.length > MAX_ERRORS) this.errors.length = MAX_ERRORS;
  }

  snapshot(): MetricsSnapshot {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      discordConnected: this.state.discord,
      fluxerConnected: this.state.fluxer,
      text: {
        messagesBridged: this.counters.messagesBridged,
        editsBridged: this.counters.editsBridged,
        deletesBridged: this.counters.deletesBridged,
        reactionsBridged: this.counters.reactionsBridged,
        attachmentsBridged: this.counters.attachmentsBridged,
        skippedOwnMessages: this.counters.skippedOwnMessages,
      },
      voice: {
        activeLinks: this.voice.activeLinks,
        participantsDiscord: this.voice.participantsDiscord,
        participantsFluxer: this.voice.participantsFluxer,
        packetsForwarded: this.counters.packetsForwarded,
      },
      errors: [...this.errors],
    };
  }
}