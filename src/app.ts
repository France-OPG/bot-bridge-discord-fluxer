import { Server } from 'node:http';
import { loadConfig } from './config/loader.js';
import { AppConfig, LinkConfig } from './config/schema.js';
import { getLogger, initLogger } from './logging/logger.js';
import { HttpClient } from './rate/httpClient.js';
import { RateLimiter } from './rate/rateLimiter.js';
import { LinkStore } from './core/store.js';
import { Metrics } from './core/metrics.js';
import { RelayGuard } from './core/relayGuard.js';
import { BridgeService } from './core/bridge.js';
import { buildAutoLinks } from './core/autoLink.js';
import { DiscordAdapter } from './platform/discord/adapter.js';
import { FluxerAdapter } from './platform/fluxer/adapter.js';
import { startStatusServer, stopStatusServer } from './admin/statusServer.js';
import { DiscoveredChannel } from './platform/types.js';
import * as path from 'node:path';

const VERSION = '0.1.0';

export interface BridgeContext {
  config: AppConfig;
  bridge: BridgeService;
  statusServer: Server | null;
  stop(): Promise<void>;
}

/** Point d'entrée unique du pont (utilisé par la CLI `start`). */
export async function runBridge(options: { configPath?: string } = {}): Promise<BridgeContext> {
  const config = loadConfig(options.configPath);
  initLogger(config.logging);
  const log = getLogger();

  log.info({ version: VERSION }, 'démarrage du pont discord-fluxer');

  const store = new LinkStore(path.join(process.cwd(), 'data', 'links.json'));
  const metrics = new Metrics();

  const discordBucket = new RateLimiter(10);
  const fluxerBucket = new RateLimiter(10);

  const discordHttp = new HttpClient({
    baseUrl: 'https://discord.com/api/v10',
    headers: { Authorization: `Bot ${config.discord.token}` },
    requestsPerSecond: 10,
  });

  const fluxerHttp = new HttpClient({
    baseUrl: config.fluxer.base_url,
    headers: { Authorization: `Bot ${config.fluxer.token}` },
    requestsPerSecond: 10,
  });

  const maxFileBytes = config.bridge.attachments.max_size_mb * 1024 * 1024;
  const cacheDir = config.bridge.attachments.cache_dir;

  const discord = new DiscordAdapter({
    token: config.discord.token,
    intents: config.discord.intents,
    webhookName: config.bridge.name,
    maxFileBytes,
    cacheDir,
    bucket: discordBucket,
    http: discordHttp,
    pinnedGuildId: config.bridge.discord_guild_id,
  });

  const fluxer = new FluxerAdapter({
    baseUrl: config.fluxer.base_url,
    token: config.fluxer.token,
    webhookName: config.bridge.name,
    maxFileBytes,
    cacheDir,
    bucket: fluxerBucket,
    http: fluxerHttp,
    voice: { perUserTracks: false },
  });

  await discord.start();
  await fluxer.start();

  // Analyse des salons : auto-liaison des deux côtés (si activée).
  let links: LinkConfig[] = config.links;
  if (config.bridge.autolink) {
    log.info('Analyse des salons — création automatique des liaisons…');
    let discordChannels: DiscoveredChannel[] = [];
    let fluxerChannels: DiscoveredChannel[] = [];
    const discover = async (): Promise<boolean> => {
      const [d, f] = await Promise.all([
        discord.listTextChannels?.() ?? Promise.resolve([]),
        fluxer.listTextChannels?.() ?? Promise.resolve([]),
      ]);
      discordChannels = d;
      fluxerChannels = f;
      return d.length > 0 && f.length > 0;
    };
    try {
      let ready = await discover();
      if (!ready) {
        // L'une des plateformes n'est pas encore prête (guilds pas peuplés
        // au démarrage) : on réessaie une fois après un court délai.
        log.info(
          { discord: discordChannels.length, fluxer: fluxerChannels.length },
          'découverte incomplète au premier essai — nouvelle tentative dans 1,5 s',
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        ready = await discover();
      }
      if (!ready) {
        log.warn(
          { discord: discordChannels.length, fluxer: fluxerChannels.length },
          'découverte des salons incomplète — liens manuels conservés',
        );
      } else {
        const outcome = buildAutoLinks({
          existing: config.links,
          discord: discordChannels,
          fluxer: fluxerChannels,
        });
        links = outcome.links;
        for (const drop of outcome.drops) {
          log.warn({ source: drop.source, id: drop.id, name: drop.name }, 'lien manuel obsolète abandonné');
        }
        if (outcome.added > 0) {
          log.info({ created: outcome.added, total: links.length }, 'liaisons automatiques créées');
        } else {
          log.info({ total: links.length }, 'aucune nouvelle liaison à créer');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'auto-liaison impossible — liens manuels conservés');
    }
  }

  const effectiveConfig: AppConfig = { ...config, links };

  const watchedDiscord = new Set<string>();
  const watchedFluxer = new Set<string>();
  for (const link of links) {
    watchedDiscord.add(link.discord_channel_id);
    watchedFluxer.add(link.fluxer_channel_id);
    if (link.voice) {
      watchedDiscord.add(link.voice.discord_channel_id);
      watchedFluxer.add(link.voice.fluxer_channel_id);
    }
  }
  discord.setWatchedTextChannels(watchedDiscord);
  fluxer.setWatchedTextChannels(watchedFluxer);

  const guard = new RelayGuard(store, effectiveConfig.bridge.signature);
  const bridge = new BridgeService({ config: effectiveConfig, store, guard, metrics, discord, fluxer });

  await bridge.start();

  // Pré-remplit le cache des salons surveillés (nécessaire aussi pour la voix).
  for (const channelId of watchedDiscord) {
    void discord
      .resolveChannel(channelId)
      .catch(() => undefined);
  }

  let statusServer: Server | null = null;
  try {
    statusServer = await startStatusServer(config.admin, bridge);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'serveur de statut non démarré');
  }

  log.info(
    { links: links.length, signature: effectiveConfig.bridge.signature || '(aucune)', autolink: effectiveConfig.bridge.autolink },
    'pont opérationnel — prêt à relayer',
  );

  return {
    config: effectiveConfig,
    bridge,
    statusServer,
    async stop() {
      try {
        if (statusServer) await stopStatusServer(statusServer);
      } catch {
        /* déjà fermé */
      }
      await bridge.stop();
    },
  };
}

export function installShutdownHandler(ctx: BridgeContext): () => void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    getLogger().info({ signal }, 'arrêt en cours…');
    try {
      await ctx.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  };
}

export function installCrashesHandler(): void {
  process.on('uncaughtException', (err) => {
    getLogger().error({ err: err?.message ?? String(err), stack: err?.stack }, 'erreur non interceptée');
  });
  process.on('unhandledRejection', (reason) => {
    getLogger().error({ err: reason instanceof Error ? reason.message : String(reason) }, 'rejet non géré');
  });
}

export const bridgeVersion = VERSION;