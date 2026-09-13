import pino from 'pino';
import { LoggingConfig } from '../config/schema.js';

let instance: pino.Logger | null = null;

export function initLogger(config: LoggingConfig): pino.Logger {
  const redactPaths = Array.isArray(config.redact) ? config.redact : [];
  if (!redactPaths.includes('discord.token')) redactPaths.push('discord.token');
  if (!redactPaths.includes('fluxer.token')) redactPaths.push('fluxer.token');
  if (!redactPaths.includes('discord.authorization')) redactPaths.push('discord.authorization');

  instance = pino({
    level: config.level || 'info',
    redact: { paths: redactPaths, censor: '[masqué]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: config.json
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
  });
  return instance;
}

export function getLogger(): pino.Logger {
  if (!instance) {
    instance = pino({ level: 'info', base: undefined });
  }
  return instance;
}

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}