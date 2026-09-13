/**
 * Utilitaires PCM (16 bits, petit-boutiste) utilisés par le pont vocal.
 * Le pont travaille en mono 48 kHz pour le mixage, puis convertit en
 * stéréo pour Discord (qui attend du PCM stéréo 48 kHz en entrée "Raw").
 */

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz

/** Convertit du PCM stéréo entrelacé (Int16) en PCM mono. */
export function stereoToMono(interleaved: Int16Array): Int16Array {
  const frames = interleaved.length >> 1;
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = (interleaved[i * 2] + interleaved[i * 2 + 1]) >> 1;
  }
  return mono;
}

/** Duplique un tampon mono vers un tampon stéréo entrelacé. */
export function monoToStereo(mono: Int16Array): Int16Array {
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i];
    stereo[i * 2] = v;
    stereo[i * 2 + 1] = v;
  }
  return stereo;
}

/**
 * Mélangeur PCM mono : agrège l'audio de plusieurs utilisateurs en un
 * seul flux 48 kHz. Chaque contributeur est amplifiée puis la somme est
 * limitée (clamp) pour éviter le clipping.
 */
export class PcmMixer {
  private readonly buffers = new Map<string, Int16Array>();
  private readonly gains = new Map<string, number>();

  setGain(userId: string, gain: number): void {
    this.gains.set(userId, gain);
  }

  push(userId: string, chunk: Int16Array, gain?: number): void {
    const g = gain ?? this.gains.get(userId) ?? 0.9;
    const current = this.buffers.get(userId) ?? new Int16Array(0);
    const appended = new Int16Array(current.length + chunk.length);
    appended.set(current);
    for (let i = 0; i < chunk.length; i++) {
      appended[current.length + i] = Math.max(-32768, Math.min(32767, chunk[i] * g));
    }
    if (appended.length > SAMPLE_RATE) {
      this.buffers.set(userId, appended.slice(appended.length - SAMPLE_RATE));
    } else {
      this.buffers.set(userId, appended);
    }
  }

  /** Construit une frame moyennée de `frameSamples` échantillons. */
  readFrame(frameSamples = FRAME_SAMPLES): Int16Array | null {
    const readyUsers: string[] = [];
    for (const [userId, buffer] of this.buffers) {
      if (buffer.length >= frameSamples) readyUsers.push(userId);
    }
    if (readyUsers.length === 0) return null;

    const frame = new Int16Array(frameSamples);
    for (const userId of readyUsers) {
      const buffer = this.buffers.get(userId)!;
      for (let i = 0; i < frameSamples; i++) {
        const sum = frame[i] + buffer[i];
        frame[i] = Math.max(-32768, Math.min(32767, sum));
      }
      this.buffers.set(userId, buffer.slice(frameSamples));
    }
    return frame;
  }

  clearUser(userId: string): void {
    this.buffers.delete(userId);
    this.gains.delete(userId);
  }

  activeUsers(): number {
    return this.buffers.size;
  }

  reset(): void {
    this.buffers.clear();
    this.gains.clear();
  }
}

/**
 * Re-encapsule un flux PCM en frames de durée fixe (20 ms). Utile pour
 * découper l'audio reçu (tailles de buffers variables) en segments stables.
 */
export class PcmFrameAssembler {
  private pending: Int16Array = new Int16Array(0);

  push(chunk: Int16Array): Int16Array[] {
    if (chunk.length === 0) return [];
    const combined = new Int16Array(this.pending.length + chunk.length);
    combined.set(this.pending);
    combined.set(chunk, this.pending.length);
    this.pending = combined;

    const frames: Int16Array[] = [];
    while (this.pending.length >= FRAME_SAMPLES) {
      const frame = this.pending.slice(0, FRAME_SAMPLES);
      this.pending = this.pending.slice(FRAME_SAMPLES);
      frames.push(frame);
    }
    if (this.pending.length > SAMPLE_RATE) this.pending = this.pending.slice(-FRAME_SAMPLES);
    return frames;
  }

  flushRemainder(): Int16Array | null {
    if (this.pending.length === 0) return null;
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(this.pending);
    this.pending = new Int16Array(0);
    return frame;
  }
}