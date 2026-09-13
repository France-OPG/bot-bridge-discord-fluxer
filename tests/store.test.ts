import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkStore } from '../src/core/store.js';
import { SeenMessage } from '../src/core/types.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxf-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignoré */
    }
  }
  dirs.length = 0;
});

function entry(platform: 'discord' | 'fluxer', id: string, relayedId: string, channel = 'c1', remote = 'c2'): SeenMessage {
  return {
    platform,
    id,
    relayedId,
    sourceId: id,
    channelId: channel,
    remoteChannelId: remote,
    authorName: 'Alice',
    contentPreview: 'hello',
    createdAt: Date.now(),
  };
}

describe('LinkStore', () => {
  it('enregistre, retrouve et supprime des correspondances', () => {
    const store = new LinkStore(path.join(tempDir(), 'links.json'));
    expect(store.find('discord', 'm1')).toBeUndefined();

    store.record(entry('discord', 'm1', 'f1'));
    const seen = store.find('discord', 'm1');
    expect(seen?.relayedId).toBe('f1');
    expect(store.has('discord', 'm1')).toBe(true);

    store.remove('discord', 'm1');
    expect(store.find('discord', 'm1')).toBeUndefined();
  });

  it('persiste et recharge ses correspondances', () => {
    const storePath = path.join(tempDir(), 'links.json');
    const store = new LinkStore(storePath);
    store.record(entry('fluxer', 'f42', 'd42'));

    const reloaded = new LinkStore(storePath);
    expect(reloaded.find('fluxer', 'f42')?.relayedId).toBe('d42');
  });

  it('borne le nombre d’entrées conservées', () => {
    const store = new LinkStore(path.join(tempDir(), 'tiny.json'), 5);
    for (let i = 0; i < 50; i += 1) {
      store.record({ ...entry('discord', `m${i}`, `f${i}`), createdAt: i });
    }
    expect(store.size()).toBeLessThanOrEqual(5);
    // les plus anciennes sont évacuées
    expect(store.find('discord', 'm0')).toBeUndefined();
  });

  it('réinitialise proprement si le fichier est corrompu', () => {
    const storePath = path.join(tempDir(), 'broken.json');
    writeFileSync(storePath, '{pas du json');
    const store = new LinkStore(storePath);
    store.record(entry('discord', 'm1', 'f1'));
    expect(store.size()).toBe(1);
  });

  it('écrit un fichier lisible en JSON', () => {
    const storePath = path.join(tempDir(), 'links.json');
    const store = new LinkStore(storePath);
    store.record(entry('discord', 'm1', 'f1'));
    expect(existsSync(storePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { entries: SeenMessage[] };
    expect(parsed.entries.length).toBe(1);
  });
});