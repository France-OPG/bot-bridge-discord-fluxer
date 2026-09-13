import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

import { VoiceParticipant } from '../../core/types.js';
import { VoicePlatform } from '../types.js';
import { FRAME_SAMPLES, SAMPLE_RATE, stereoToMono } from '../../audio/pcm.js';
import { FluxerVoiceToken } from './rest.js';

export interface FluxerVoiceOptions {
  /** Fournit un token + endpoint LiveKit pour un salon donné. */
  tokenProvider(channelId: string): Promise<FluxerVoiceToken | null>;
  /** Active une piste LiveKit par utilisateur distant (défaut : false, mixé). */
  perUserTracks?: boolean;
  roomOptions?: {
    autoSubscribe?: boolean;
    adaptiveStream?: boolean;
  };
}

/**
 * Force vocale Fluxer reposant sur LiveKit. Connexion à un salon via le
 * token LiveKit fourni par `POST /channels/{id}/voice/token`, capture des
 * pistes audio des participants (AudioStream), publication d'une piste
 * audio 48 kHz mono via transmit().
 */
export class FluxerVoicePlatform implements VoicePlatform {
  private readonly opts: FluxerVoiceOptions;
  private room: Room | null = null;
  private mixSource: AudioSource | null = null;
  private perUserSources = new Map<string, AudioSource>();
  private audioStreams: ReadableStreamDefaultReader<AudioFrame>[] = [];
  private channelId: string | null = null;
  private connectedFlag = false;
  private audioHandlers: Array<(userId: string, pcm: Int16Array) => void> = [];
  private participantHandlers: Array<(p: VoiceParticipant) => void> = [];
  private participantsInternal = new Map<string, VoiceParticipant>();
  private streamsByIdentity = new Map<string, { track: RemoteTrack; reader: ReadableStreamDefaultReader<AudioFrame> }>();

  constructor(options: FluxerVoiceOptions) {
    this.opts = options;
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  participants(): VoiceParticipant[] {
    return [...this.participantsInternal.values()];
  }

  onParticipant(handler: (p: VoiceParticipant) => void): void {
    this.participantHandlers.push(handler);
  }

  onAudio(handler: (userId: string, pcm: Int16Array) => void): void {
    this.audioHandlers.push(handler);
  }

  setAutoReconnect(_enabled: boolean): void {
    // LiveKit gère nativement la reconnexion ; on conserve le flag pour
    // re-joindre le salon après une coupure si besoin.
  }

  async connect(channelId: string): Promise<void> {
    if (this.connectedFlag) {
      if (this.channelId === channelId) return;
      await this.disconnect();
    }
    this.channelId = channelId;

    const token = await this.opts.tokenProvider(channelId);
    if (!token) {
      throw new Error(
        "Impossible d'obtenir un token LiveKit (POST /channels/{id}/voice/token). Vérifiez la config voix Fluxer.",
      );
    }

    const room = new Room();
    this.room = room;

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      this.addParticipant(participant);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.removeParticipant(participant);
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === TrackKind.KIND_AUDIO) this.attachAudioStream(track, participant);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === TrackKind.KIND_AUDIO) this.detachAudioStream(track, participant);
    });

    await room.connect(token.endpoint, token.token, {
      autoSubscribe: this.opts.roomOptions?.autoSubscribe ?? true,
      dynacast: false,
    });
    this.connectedFlag = true;
    this.participantsInternal.clear();

    for (const [, participant] of room.remoteParticipants) {
      this.addParticipant(participant);
      for (const [, publication] of participant.trackPublications) {
        if (publication.kind === TrackKind.KIND_AUDIO && publication.track) {
          this.attachAudioStream(publication.track, participant);
        }
      }
    }

    if (this.opts.perUserTracks) {
      for (const [, participant] of room.remoteParticipants) {
        this.ensureUserSource(participant.identity);
      }
    }

    await this.ensureMixedSource();
  }

  async disconnect(): Promise<void> {
    for (const stream of this.audioStreams) {
      try {
        await this.cancelStream(stream);
      } catch {
        /* déjà fermé */
      }
    }
    this.audioStreams = [];
    this.streamsByIdentity.clear();

    for (const source of this.perUserSources.values()) {
      try {
        await source.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.perUserSources.clear();

    if (this.mixSource) {
      try {
        await this.mixSource.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.mixSource = null;

    if (this.room) {
      try {
        await this.room.disconnect();
      } catch {
        /* déjà déconnecté */
      }
    }
    this.room = null;
    this.connectedFlag = false;
    this.participantsInternal.clear();
    this.channelId = null;
  }

  private addParticipant(p: RemoteParticipant): void {
    const entry: VoiceParticipant = {
      userId: p.identity,
      displayName: p.name || p.identity,
      connected: true,
      muted: false,
      deafened: false,
    };
    this.participantsInternal.set(p.identity, entry);
    for (const handler of this.participantHandlers) handler(entry);
  }

  private removeParticipant(p: RemoteParticipant): void {
    this.participantsInternal.delete(p.identity);
    const stream = this.streamsByIdentity.get(p.identity);
    if (stream) this.detachAudioStream(stream.track, p);
    this.perUserSources.delete(p.identity);
    const entry: VoiceParticipant = {
      userId: p.identity,
      displayName: p.name || p.identity,
      connected: false,
      muted: false,
      deafened: false,
    };
    for (const handler of this.participantHandlers) handler(entry);
  }

  private attachAudioStream(track: RemoteTrack, participant: RemoteParticipant): void {
    if (this.streamsByIdentity.has(participant.identity) || !this.room) return;

    const stream = new AudioStream(track, {
      sampleRate: SAMPLE_RATE,
      numChannels: 2,
      frameSizeMs: 40,
    });
    const reader = stream.getReader();
    this.streamsByIdentity.set(participant.identity, { track, reader });
    this.audioStreams.push(reader);
    void this.pumpAudioStream(reader, participant);
  }

  private async pumpAudioStream(
    reader: ReadableStreamDefaultReader<AudioFrame>,
    participant: RemoteParticipant,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const mono = this.decodeFrame(value);
        if (!mono) continue;

        if (this.opts.perUserTracks) {
          const source = this.perUserSources.get(participant.identity);
          if (source) {
            try {
              void source.captureFrame(new AudioFrame(mono.slice(), SAMPLE_RATE, 1, mono.length));
            } catch {
              /* frame ignorée */
            }
          }
        }

        for (const handler of this.audioHandlers) handler(participant.identity, mono);
      }
    } catch {
      /* flux fermé */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* lock déjà libéré */
      }
      if (this.streamsByIdentity.get(participant.identity)?.reader === reader) {
        this.streamsByIdentity.delete(participant.identity);
      }
      this.audioStreams = this.audioStreams.filter((r) => r !== reader);
    }
  }

  private async cancelStream(reader: ReadableStreamDefaultReader<AudioFrame>): Promise<void> {
    try {
      await reader.cancel();
    } catch {
      /* déjà fermé */
    }
  }

  private detachAudioStream(track: RemoteTrack, participant: RemoteParticipant): void {
    const entry = this.streamsByIdentity.get(participant.identity);
    if (!entry || entry.track !== track) return;
    void this.cancelStream(entry.reader).catch(() => {
      /* déjà fermé */
    });
  }

  private decodeFrame(frame: AudioFrame): Int16Array | null {
    if (frame.sampleRate !== SAMPLE_RATE) return null;
    const data = frame.data;
    if (frame.channels === 2) return stereoToMono(data);
    if (frame.channels === 1) return data;
    return null;
  }

  private ensureUserSource(userId: string): void {
    if (this.perUserSources.has(userId) || !this.room?.localParticipant) return;
    const source = new AudioSource(SAMPLE_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack(`dxf-user-${userId}`, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    void this.room.localParticipant.publishTrack(track, options).catch(() => {
      /* piste non publiée : on se rabat sur le mixé */
    });
    this.perUserSources.set(userId, source);
  }

  private async ensureMixedSource(): Promise<void> {
    if (this.mixSource || !this.room) return;
    const source = new AudioSource(SAMPLE_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('dxf-mix', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;

    if (!this.room.localParticipant) {
      throw new Error('Pas de participant local : impossible de publier l’audio.');
    }
    await this.room.localParticipant.publishTrack(track, options);
    this.mixSource = source;
  }

  transmit(pcm: Int16Array): void {
    if (!this.mixSource || pcm.length === 0) return;
    const frame = pcm.length > FRAME_SAMPLES ? pcm.slice(0, FRAME_SAMPLES) : pcm;
    try {
      void this.mixSource.captureFrame(new AudioFrame(frame.slice(), SAMPLE_RATE, 1, frame.length));
    } catch {
      /* frame ignorée si la source est fermée */
    }
  }

  transmitUser(userId: string, pcm: Int16Array): void {
    if (!this.opts.perUserTracks) {
      this.transmit(pcm);
      return;
    }
    const source = this.perUserSources.get(userId);
    if (!source) {
      this.transmit(pcm);
      return;
    }
    const frame = pcm.length > FRAME_SAMPLES ? pcm.slice(0, FRAME_SAMPLES) : pcm;
    if (frame.length === 0) return;
    try {
      void source.captureFrame(new AudioFrame(frame.slice(), SAMPLE_RATE, 1, frame.length));
    } catch {
      /* frame ignorée */
    }
  }
}