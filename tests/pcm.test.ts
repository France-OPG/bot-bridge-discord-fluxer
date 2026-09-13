import { describe, expect, it } from 'vitest';
import {
  FRAME_SAMPLES,
  monoToStereo,
  PcmFrameAssembler,
  PcmMixer,
  stereoToMono,
} from '../src/audio/pcm.js';

describe('stereoToMono / monoToStereo', () => {
  it('downmix stéréo → mono', () => {
    const stereo = new Int16Array([100, 150, -100, -200]);
    const mono = stereoToMono(stereo);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBe(125);
    expect(mono[1]).toBe(-150);
  });

  it('duplique mono → stéréo entrelacé', () => {
    const mono = new Int16Array([7, -9]);
    const stereo = monoToStereo(mono);
    expect(stereo.length).toBe(4);
    expect([...stereo]).toEqual([7, 7, -9, -9]);
  });

  it('les deux transformations sont réversibles en moyenne', () => {
    const mono = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const roundTrip = stereoToMono(monoToStereo(mono));
    expect([...roundTrip]).toEqual([...mono]);
  });
});

describe('PcmMixer', () => {
  it('accumule puis produit une frame complète', () => {
    const mixer = new PcmMixer();
    const chunk = new Int16Array(FRAME_SAMPLES).fill(1000);
    mixer.push('user-a', chunk);
    const frame = mixer.readFrame();
    expect(frame).not.toBeNull();
    expect(frame!.length).toBe(FRAME_SAMPLES);
    expect(frame![0]).toBeGreaterThan(0);
  });

  it('retourne null tant qu’il n’y a pas assez d’échantillons', () => {
    const mixer = new PcmMixer();
    mixer.push('user-a', new Int16Array(100).fill(500));
    expect(mixer.readFrame()).toBeNull();
  });

  it('additionne deux locuteurs et ne dépasse pas 32767', () => {
    const mixer = new PcmMixer();
    mixer.push('a', new Int16Array(FRAME_SAMPLES).fill(30000));
    mixer.push('b', new Int16Array(FRAME_SAMPLES).fill(30000));
    const frame = mixer.readFrame()!;
    expect(Math.max(...frame)).toBeLessThanOrEqual(32767);
    expect(frame[0]).toBeGreaterThan(30000);
  });

  it('supprime un locuteur avec clearUser', () => {
    const mixer = new PcmMixer();
    mixer.push('a', new Int16Array(FRAME_SAMPLES).fill(1000));
    mixer.clearUser('a');
    expect(mixer.readFrame()).toBeNull();
    expect(mixer.activeUsers()).toBe(0);
  });
});

describe('PcmFrameAssembler', () => {
  it('découpe les données entrantes en frames de 20 ms', () => {
    const assembler = new PcmFrameAssembler();
    const frames = assembler.push(new Int16Array(FRAME_SAMPLES * 2 + 10).fill(1));
    expect(frames.length).toBe(2);
    expect(frames.every((f) => f.length === FRAME_SAMPLES)).toBe(true);
  });

  it('reste sans émission tant que la frame est incomplète', () => {
    const assembler = new PcmFrameAssembler();
    expect(assembler.push(new Int16Array(100)).length).toBe(0);
  });

  it('flushRemainder complète la frame restante avec des zéros', () => {
    const assembler = new PcmFrameAssembler();
    assembler.push(new Int16Array(100).fill(5));
    const remainder = assembler.flushRemainder();
    expect(remainder).not.toBeNull();
    expect(remainder!.length).toBe(FRAME_SAMPLES);
    expect(remainder![0]).toBe(5);
    expect(remainder![FRAME_SAMPLES - 1]).toBe(0);
  });
});