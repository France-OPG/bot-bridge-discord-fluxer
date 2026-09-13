import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { ConfigError } from '../src/config/schema.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxf-cfg-'));
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

const MINIMAL_YAML = `
bridge:
  name: "dxf"
  signature: "\\u200bDxF"
  relay:
    messages: true
    reactions: true
discord:
  token: "\${DISCORD_TOKEN}"
fluxer:
  base_url: "\${FLUXER_BASE_URL}"
  token: "\${FLUXER_TOKEN}"
links:
  - name: "main"
    discord_channel_id: "100"
    fluxer_channel_id: "200"
admin:
  status_port: 8090
`;

function writeConfig(content: string): string {
  const dir = tempDir();
  const filePath = path.join(dir, 'config.yaml');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('loadConfig', () => {
  it('charge un YAML minimal et interpole les variables d’environnement', () => {
    const configPath = writeConfig(MINIMAL_YAML);
    const config = loadConfig(configPath, {
      DISCORD_TOKEN: 'bot.discord.token.000',
      FLUXER_BASE_URL: 'https://fluxer.example.com',
      FLUXER_TOKEN: '123456789.abcdef',
    });

    expect(config.discord.token).toBe('bot.discord.token.000');
    expect(config.fluxer.token).toBe('123456789.abcdef');
    expect(config.fluxer.base_url).toBe('https://fluxer.example.com/v1');
    expect(config.bridge.signature).toBe('\u200bDxF');
    expect(config.links).toHaveLength(1);
    expect(config.links[0].text).toBe(true);
    expect(config.admin.status_port).toBe(8090);
  });

  it('ratifie l’ajout de /v1 à une base_url sans version', () => {
    const configPath = writeConfig(MINIMAL_YAML);
    const config = loadConfig(configPath, {
      DISCORD_TOKEN: 'bot.discord.token.000',
      FLUXER_BASE_URL: 'https://fluxer.example.com/',
      FLUXER_TOKEN: '123456789.abcdef',
    });
    expect(config.fluxer.base_url).toBe('https://fluxer.example.com/v1');
  });

  it('rejette un fluxer.token mal formé', () => {
    const configPath = writeConfig(MINIMAL_YAML);
    expect(() =>
      loadConfig(configPath, {
        DISCORD_TOKEN: 'bot.discord.token.000',
        FLUXER_BASE_URL: 'https://fluxer.example.com',
        FLUXER_TOKEN: 'sans-point',
      }),
    ).toThrow(ConfigError);
  });

  it('rejette un lien sans identifiants de salons', () => {
    const configPath = writeConfig(MINIMAL_YAML.replace('fluxer_channel_id: "200"', 'fluxer_channel_id: ""'));
    expect(() =>
      loadConfig(configPath, {
        DISCORD_TOKEN: 'bot.discord.token.000',
        FLUXER_BASE_URL: 'https://fluxer.example.com',
        FLUXER_TOKEN: '123456789.abcdef',
      }),
    ).toThrow(ConfigError);
  });

  it('convertit le relais voix activé en booléen', () => {
    const voiceYaml = `
bridge:
  name: "dxf"
discord:
  token: "\${DISCORD_TOKEN}"
fluxer:
  base_url: "\${FLUXER_BASE_URL}"
  token: "\${FLUXER_TOKEN}"
links:
  - name: "main"
    discord_channel_id: "100"
    fluxer_channel_id: "200"
    voice:
      enabled: true
      discord_channel_id: "300"
      fluxer_channel_id: "400"
`;
    const configPath = writeConfig(voiceYaml);
    const config = loadConfig(configPath, {
      DISCORD_TOKEN: 'bot.discord.token.000',
      FLUXER_BASE_URL: 'https://fluxer.example.com',
      FLUXER_TOKEN: '123456789.abcdef',
    });
    expect(config.links[0].voice?.enabled).toBe(true);
    expect(config.links[0].voice?.discord_channel_id).toBe('300');
    expect(config.links[0].voice?.fluxer_channel_id).toBe('400');
  });
});