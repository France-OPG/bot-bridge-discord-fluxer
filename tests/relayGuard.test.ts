import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkStore } from '../src/core/store.js';
import { RelayGuard } from '../src/core/relayGuard.js';
import { BridgeMessage } from '../src/core/types.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxf-guard-'));
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

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    platform: 'discord',
    id: 'msg-1',
    channelId: 'ch-1',
    author: { id: 'user-1', displayName: 'Alice', username: 'alice', isBot: false },
    content: 'bonjour',
    attachments: [],
    timestamp: new Date().toISOString(),
    isSystem: false,
    ...overrides,
  };
}

function makeGuard(signature = '\u200bDxF'): RelayGuard {
  const dir = tempDir();
  return new RelayGuard(new LinkStore(path.join(dir, 'links.json')), signature);
}

describe('RelayGuard.shouldIgnore', () => {
  it('ignore les messages écrits par le bot du pont', () => {
    const guard = makeGuard();
    guard.setSelfId('discord', 'self-id');
    expect(guard.shouldIgnore(message({ author: { id: 'self-id', displayName: 'bot', username: 'bot', isBot: true } }))).toBe(true);
  });

  it('ignore les messages envoyés via le webhook du pont', () => {
    const guard = makeGuard();
    guard.registerWebhook('discord', 'wh-1');
    expect(guard.shouldIgnore(message(), 'wh-1')).toBe(true);
  });

  it('ignore les messages déjà enregistrés comme relayés', () => {
    const guard = makeGuard();
    guard.recordRelayed(message(), 'relayed-1', 'fluxer', 'ch-f');
    expect(guard.shouldIgnore(message())).toBe(true);
  });

  it('ignore les messages portant la signature (auto-sig)', () => {
    const guard = makeGuard('\u200bDxF');
    expect(guard.shouldIgnore(message({ content: 'salut\u200bDxF' }))).toBe(true);
  });

  it('laisse passer un message normal inconnu', () => {
    const guard = makeGuard();
    expect(guard.shouldIgnore(message())).toBe(false);
  });
});

describe('RelayGuard.recordRelayed', () => {
  it('crée les deux entrées source et distante', () => {
    const guard = makeGuard();
    guard.recordRelayed(message(), 'relayed-1', 'fluxer', 'ch-f');

    const store = (guard as unknown as { store: LinkStore }).store;
    const source = store.find('discord', 'msg-1');
    const remote = store.find('fluxer', 'relayed-1');
    expect(source?.relayedId).toBe('relayed-1');
    expect(remote?.relayedId).toBe('msg-1');
  });
});