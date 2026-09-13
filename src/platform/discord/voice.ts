import { Client, Events, GuildMember, VoiceState } from 'discord.js';
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { getLogger } from '../../logging/logger.js';
import { VoiceParticipant } from '../../core/types.js';
import { VoicePlatform } from '../types.js';
import { FRAME_SAMPLES, monoToStereo } from '../../audio/pcm.js';
import { HttpClient } from '../../rate/httpClient.js';

const REJOIN_MS = 2500;
const MAX_REJOIN_ATTEMPTS = 12;

class PcmPushStream extends Readable {
  private readonly maxBufferedBytes: number;
  private bufferedBytes = 0;

  constructor(maxBufferedBytes: number) {
    super();
    this.maxBufferedBytes = Math.max(1024, maxBufferedBytes);
  }

  writePcm(pcm: Int16Array): boolean {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.bufferedBytes + buf.length > this.maxBufferedBytes) return false;
    this.bufferedBytes += buf.length;
    return this.push(buf);
  }

  override _read(): void {
    // Le flux est piloté par push() (temps réel) — rien à faire.
  }
}

/**
 * Connexion vocale Discord : rejoint un salon via @discordjs/voice,
 * expose l'audio des utilisateurs (PCM mono 48 kHz) et retransmet notre
 * flux vers le salon.
 */
export class DiscordVoicePlatform implements VoicePlatform {
  connected = false;

  private readonly client: Client;
  private readonly http: HttpClient;
  private participantHandlers: Array<(p: VoiceParticipant) => void> = [];
  private audioHandlers: Array<(userId: string, pcm: Int16Array) => void> = [];
  private channelId: string | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private outputStream: PcmPushStream | null = null;
  private readonly members = new Map<string, GuildMember>();
  private readonly activeSubscriptions = new Map<string, ReturnType<VoiceConnection['receiver']['subscribe']>>();
  private autoReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(client: Client, http: HttpClient) {
    this.client = client;
    this.http = http;
  }

  participants(): VoiceParticipant[] {
    return [...this.members.values()].map((member) => ({
      userId: member.id,
      displayName: member.displayName || member.user.username,
      connected: true,
      muted: (member.voice.mute ?? false) || (member.voice.selfMute ?? false),
      deafened: (member.voice.deaf ?? false) || (member.voice.selfDeaf ?? false),
    }));
  }

  onParticipant(handler: (p: VoiceParticipant) => void): void {
    this.participantHandlers.push(handler);
  }

  onAudio(handler: (userId: string, pcm: Int16Array) => void): void {
    this.audioHandlers.push(handler);
  }

  transmit(pcm: Int16Array): void {
    if (!this.outputStream || pcm.length === 0) return;
    const stereo = monoToStereo(pcm);
    this.outputStream.writePcm(stereo);
  }

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
  }

  private emitParticipant(p: VoiceParticipant): void {
    for (const handler of this.participantHandlers) handler(p);
  }

  private emitAudio(userId: string, pcm: Int16Array): void {
    for (const handler of this.audioHandlers) handler(userId, pcm);
  }

  async connect(channelId: string): Promise<void> {
    this.stopped = false;
    let channel = this.client.channels.cache.get(channelId) as { guildId?: string } | undefined;
    if (!channel) {
      try {
        channel = (await this.client.channels.fetch(channelId)) as unknown as { guildId?: string };
      } catch {
        channel = undefined;
      }
    }
    const guildId = channel?.guildId;
    if (!guildId) throw new Error(`Salon vocal Discord ${channelId} introuvable (ou non-caché).`);

    let guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      try {
        guild = await this.client.guilds.fetch(guildId);
      } catch {
        guild = undefined;
      }
    }
    if (!guild) throw new Error(`Guild Discord ${guildId} introuvable.`);

    this.channelId = channelId;
    const log = getLogger();
    log.info({ guildId, channelId }, 'Connexion au salon vocal Discord');

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection = connection;

    connection.on('stateChange', (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
      if (newState.status === VoiceConnectionStatus.Ready) {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.beginReceiving(connection);
      } else if (
        newState.status === VoiceConnectionStatus.Disconnected &&
        newState.reason === VoiceConnectionDisconnectReason.Manual
      ) {
        this.connected = false;
      } else if (
        newState.status === VoiceConnectionStatus.Disconnected ||
        newState.status === VoiceConnectionStatus.Destroyed
      ) {
        this.connected = false;
        if (!this.stopped && this.autoReconnect) this.scheduleReconnect();
      }
    });

    const player = createAudioPlayer();
    this.player = player;
    this.outputStream = new PcmPushStream(FRAME_SAMPLES * 2 * 2 * 12);
    const resource = createAudioResource(this.outputStream, { inputType: StreamType.Raw });
    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      // Ressource terminée : on la recrée pour rester dans le salon.
      if (this.outputStream && connection.state.status === VoiceConnectionStatus.Ready) {
        const next = createAudioResource(this.outputStream, { inputType: StreamType.Raw });
        player.play(next);
      }
    });

    // Attend la création par @discordjs/voice : la connexion devient prête.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout connexion vocale Discord (5s)')), 5000);
      const check = (oldS: VoiceConnectionState, newS: VoiceConnectionState) => {
        if (newS.status === VoiceConnectionStatus.Ready || newS.status === VoiceConnectionStatus.Signalling) {
          clearTimeout(timeout);
          connection.off('stateChange', check);
          resolve();
        } else if (newS.status === VoiceConnectionStatus.Destroyed) {
          clearTimeout(timeout);
          connection.off('stateChange', check);
          reject(new Error('Connexion vocale Discord détruite'));
        }
      };
      connection.on('stateChange', check);
      // Cas déjà prêt (connexion instantanée).
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        clearTimeout(timeout);
        connection.off('stateChange', check);
        resolve();
      }
    });

    this.connected = true;
    this.syncParticipants();
    // Enregistre les mises à jour des membres du salon.
    this.client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) =>
      this.handleVoiceStateChange(oldState, newState),
    );
  }

  private handleVoiceStateChange(oldState: VoiceState, newState: VoiceState): void {
    if (!this.channelId) return;
    const joined = newState.channelId === this.channelId;
    const left = oldState.channelId === this.channelId && newState.channelId !== this.channelId;

    if (joined) {
      if (newState.member) this.members.set(newState.member.id, newState.member);
      this.emitParticipant({
        userId: newState.id,
        displayName: newState.member?.displayName || '',
        connected: true,
        muted: newState.mute ?? false,
        deafened: newState.deaf ?? false,
      });
    } else if (left) {
      this.members.delete(oldState.id);
      this.emitParticipant({
        userId: oldState.id,
        displayName: '',
        connected: false,
        muted: false,
        deafened: false,
      });
      this.stopUserStream(oldState.id);
    }
  }

  private syncParticipants(): void {
    if (!this.channelId) return;
    const channel = this.client.channels.cache.get(this.channelId) as { members?: Map<string, GuildMember> } | undefined;
    if (!channel?.members) return;
    for (const member of channel.members.values()) {
      this.members.set(member.id, member);
      this.emitParticipant({
        userId: member.id,
        displayName: member.displayName || member.user.username,
        connected: true,
        muted: member.voice.mute ?? false,
        deafened: member.voice.deaf ?? false,
      });
    }
  }

  private beginReceiving(connection: VoiceConnection): void {
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      if (this.activeSubscriptions.has(userId)) return;
      let stream;
      try {
        stream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
        });
      } catch {
        return;
      }
      this.activeSubscriptions.set(userId, stream);

      stream.on('data', (chunk: Buffer) => {
        // PCM stéréo 48 kHz → mono (downmix) puis émission.
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        const mono = new Int16Array(samples.length >> 1);
        for (let i = 0; i < samples.length >> 1; i++) {
          mono[i] = (samples[i * 2] + samples[i * 2 + 1]) >> 1;
        }
        this.emitAudio(userId, mono);
      });

      stream.on('end', () => {
        this.activeSubscriptions.delete(userId);
      });
      stream.on('close', () => {
        this.activeSubscriptions.delete(userId);
      });
    });
  }

  private stopUserStream(userId: string): void {
    const stream = this.activeSubscriptions.get(userId);
    if (stream) {
      try {
        stream.destroy();
      } catch {
        /* déjà fermé */
      }
      this.activeSubscriptions.delete(userId);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_REJOIN_ATTEMPTS) {
      getLogger().error('Échec répété de reconnexion vocale Discord — abandon.');
      return;
    }
    const delay = Math.min(REJOIN_MS * 2 ** Math.min(this.reconnectAttempts, 4), 30000);
    getLogger().info({ attempt: this.reconnectAttempts, delay }, 'Reconnexion vocale Discord dans quelques secondes…');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      const channelId = this.channelId;
      if (!channelId) return;
      try {
        await this.disconnect();
        await this.connect(channelId);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const userId of [...this.activeSubscriptions.keys()]) this.stopUserStream(userId);

    const connection = getVoiceConnection(
      (this.client.channels.cache.get(this.channelId ?? '') as { guildId?: string } | undefined)?.guildId ?? '',
    );
    try {
      connection?.destroy();
    } catch {
      /* déjà détruite */
    }
    this.connection?.destroy();
    this.connection = null;
    this.player?.stop();
    this.player = null;
    this.outputStream?.destroy();
    this.outputStream = null;
    this.connected = false;
    this.channelId = null;
    this.members.clear();
  }
}