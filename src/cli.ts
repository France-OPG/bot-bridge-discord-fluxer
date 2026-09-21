import { bridgeVersion, installCrashesHandler, installShutdownHandler, runBridge } from './app.js';
import { getLogger } from './logging/logger.js';
import { loadConfig, validateConfigFile } from './config/loader.js';

interface ParsedArgs {
  command: string;
  configPath?: string;
  port?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'start';
  const args: ParsedArgs = { command };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') {
      args.configPath = argv[i + 1];
      i += 1;
    } else if (arg === '--port' || arg === '-p') {
      args.port = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function printUsage(): void {
  const usage = `
discord-fluxer-bridge v${bridgeVersion}

Usage:
  node dist/cli.js <commande> [options]

Commandes:
  start             Lance le pont (défaut)
  validate-config   Vérifie la configuration et quitte
  links             Liste les liens configurés
  status            Affiche les statistiques du serveur de statut
  version           Affiche la version

Options:
  -c, --config <chemin>   Chemin du fichier de configuration (YAML/JSON)
  -p, --port <numéro>     Port du serveur de statut (commande status)
  -h, --help              Affiche cette aide
`;
  console.log(usage);
}

async function commandStart(args: ParsedArgs): Promise<never> {
  const ctx = await runBridge({ configPath: args.configPath });
  installCrashesHandler();
  installShutdownHandler(ctx);
  await new Promise(() => undefined); // le pont tourne jusqu'au signal d'arrêt
  throw new Error('unreachable');
}

function commandValidate(args: ParsedArgs): void {
  try {
    const config = validateConfigFile(args.configPath ?? '');
    console.log('Configuration valide.');
    console.log(`  bridge.name : ${config.bridge.name}`);
    console.log(`  liaison auto : ${config.bridge.autolink ? 'activée' : 'désactivée'}`);
    console.log(`  lien(s) texte : ${config.links.length}`);
    console.log(`  lien(s) voix : ${config.links.filter((l) => l.voice?.enabled).length}`);
    console.log(`  destination Fluxer : ${config.fluxer.base_url}`);
    console.log(`  serveur de statut : ${config.admin.status_host}:${config.admin.status_port}`);
  } catch (err) {
    console.error(`Configuration invalide : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function commandLinks(args: ParsedArgs): void {
  try {
    const config = loadConfig(args.configPath);
    for (const link of config.links) {
      const voice = link.voice?.enabled ? `voix ${link.voice.discord_channel_id} ↔ ${link.voice.fluxer_channel_id}` : '';
      console.log(`- ${link.name} (texte) : discord=${link.discord_channel_id} fluxer=${link.fluxer_channel_id}${voice ? ` | ${voice}` : ''}`);
    }
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const config = loadConfig(args.configPath);
  const port = args.port ?? String(config.admin.status_port);
  const host = config.admin.status_host;

  try {
    const response = await fetch(`http://${host}:${port}/status`);
    if (!response.ok) {
      console.error(`Serveur de statut indisponible (HTTP ${response.status}).`);
      process.exit(1);
    }
    const status = (await response.json()) as Record<string, unknown>;
    console.log(JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`Impossible de joindre le serveur de statut : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  installCrashesHandler();
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'start':
      await commandStart(args);
      break;
    case 'validate-config':
      commandValidate(args);
      break;
    case 'links':
      commandLinks(args);
      break;
    case 'status':
      await commandStatus(args);
      break;
    case 'version':
      console.log(bridgeVersion);
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      console.error(`Commande inconnue : ${args.command}`);
      printUsage();
      process.exit(1);
  }
}

void main().catch((err) => {
  getLogger().error({ err: err instanceof Error ? err.message : String(err) }, 'échec CLI');
  process.exit(1);
});