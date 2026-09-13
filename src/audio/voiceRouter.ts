import { VoicePlatform } from '../platform/types.js';
import { PcmMixer } from './pcm.js';

const SILENCE_MS = 900;
const DRAIN_MS = 10;
const PRUNE_MS = 1000;

/**
 * Relie les forces vocales de deux plateformes pour un lien voice :
 *  - l'audio de chaque côté est repoussé (mixé en mono 48 kHz) vers
 *    l'autre côté ;
 *  - les utilisateurs silencieux sont purgés pour éviter l'écho ;
 *  - la présence (participants) est suivie pour les métriques.
 */
export class VoiceRouter {
  private mixToFluxer = new PcmMixer();
  private mixToDiscord = new PcmMixer();
  private lastSpoke = new Map<string, number>();
  private intervals: NodeJS.Timeout[] = [];
  private running = false;
  private presence = { discord: new Map<string, boolean>(), fluxer: new Map<string, boolean>() };
  private packets = { toFluxer: 0, toDiscord: 0 };

  constructor(
    private readonly discord: VoicePlatform,
    private readonly fluxer: VoicePlatform,
  ) {}

  /** Réinitialise et renvoie les compteurs de frames transmises. */
  takePackets(): { toFluxer: number; toDiscord: number } {
    const sum = { toFluxer: this.packets.toFluxer, toDiscord: this.packets.toDiscord };
    this.packets.toFluxer = 0;
    this.packets.toDiscord = 0;
    return sum;
  }

  async connect(discordChannelId: string, fluxerChannelId: string): Promise<void> {
    if (this.running) throw new Error('routeur vocal déjà actif');

    this.discord.onAudio((userId, pcm) => {
      if (!this.running) return;
      this.mixToFluxer.push(userId, pcm);
      this.lastSpoke.set(`discord:${userId}`, Date.now());
    });
    this.fluxer.onAudio((userId, pcm) => {
      if (!this.running) return;
      this.mixToDiscord.push(userId, pcm);
      this.lastSpoke.set(`fluxer:${userId}`, Date.now());
    });

    this.discord.onParticipant((p) => this.presence.discord.set(p.userId, p.connected));
    this.fluxer.onParticipant((p) => this.presence.fluxer.set(p.userId, p.connected));

    await Promise.all([this.discord.connect(discordChannelId), this.fluxer.connect(fluxerChannelId)]);
    this.running = true;

    this.intervals.push(setInterval(() => this.step(), DRAIN_MS));
    this.intervals.push(setInterval(() => this.pruneSilent(), PRUNE_MS));
    for (const interval of this.intervals) interval.unref?.();
  }

  private step(): void {
    if (!this.running) return;
    const toFluxer = this.mixToFluxer.readFrame();
    if (toFluxer) {
      this.fluxer.transmit(toFluxer);
      this.packets.toFluxer += 1;
    }
    const toDiscord = this.mixToDiscord.readFrame();
    if (toDiscord) {
      this.discord.transmit(toDiscord);
      this.packets.toDiscord += 1;
    }
  }

  private pruneSilent(): void {
    const now = Date.now();
    for (const [key, spokeAt] of this.lastSpoke) {
      if (now - spokeAt <= SILENCE_MS) continue;
      const [side, userId] = key.split(':');
      if (side === 'discord') this.mixToFluxer.clearUser(userId);
      else this.mixToDiscord.clearUser(userId);
      this.lastSpoke.delete(key);
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    this.mixToFluxer.reset();
    this.mixToDiscord.reset();
    this.lastSpoke.clear();
    await Promise.allSettled([this.discord.disconnect(), this.fluxer.disconnect()]);
    this.presence = { discord: new Map(), fluxer: new Map() };
  }

  participantCounts(): { discord: number; fluxer: number } {
    return {
      discord: [...this.presence.discord.values()].filter(Boolean).length,
      fluxer: [...this.presence.fluxer.values()].filter(Boolean).length,
    };
  }

  get active(): boolean {
    return this.running;
  }
}