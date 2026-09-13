import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { AppConfig, ConfigError, validateConfig } from './schema.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');

export function loadDotEnv(filePath: string = ENV_PATH): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function interpolateEnv(raw: unknown, env: Record<string, string>): unknown {
  if (typeof raw === 'string') {
    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
      return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : match;
    });
  }
  if (Array.isArray(raw)) return raw.map((item) => interpolateEnv(item, env));
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = interpolateEnv(value, env);
    }
    return out;
  }
  return raw;
}

export function resolveConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(process.cwd(), customPath);
  const candidates: string[] = [];
  if (process.env.BRIDGE_CONFIG) candidates.push(path.resolve(process.cwd(), process.env.BRIDGE_CONFIG));
  candidates.push(
    path.resolve(process.cwd(), 'config', 'config.yaml'),
    path.resolve(process.cwd(), 'config', 'config.yml'),
    path.resolve(process.cwd(), 'config', 'config.json'),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new ConfigError(
    `Aucun fichier de configuration trouvé (config/config.yaml, config/config.yml, config/config.json). ` +
      `Copiez config/config.example.yaml vers config/config.yaml.`,
  );
}

export function loadConfig(customPath?: string, envOverride: Record<string, string> = {}): AppConfig {
  const env: Record<string, string> = { ...loadDotEnv(), ...process.env as Record<string, string>, ...envOverride };
  const configPath = resolveConfigPath(customPath);
  const fileContent = fs.readFileSync(configPath, 'utf8');

  let parsed: unknown;
  if (configPath.endsWith('.json')) {
    parsed = JSON.parse(fileContent);
  } else {
    parsed = YAML.parse(fileContent);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ConfigError('Le fichier de configuration doit contenir un objet en racine.');
  }

  const interpolated = interpolateEnv(parsed, env);
  return validateConfig(interpolated as Record<string, unknown>);
}

export function validateConfigFile(configPath: string): AppConfig {
  return loadConfig(configPath);
}