import { installCrashesHandler, installShutdownHandler, runBridge } from './app.js';
import { getLogger } from './logging/logger.js';

installCrashesHandler();

const configArgIndex = process.argv.indexOf('--config');
const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : process.argv[2];

runBridge({ configPath })
  .then((ctx) => {
    installShutdownHandler(ctx);
    return ctx;
  })
  .catch((err) => {
    getLogger().error({ err: err instanceof Error ? err.message : String(err) }, 'démarrage du pont impossible');
    process.exit(1);
  });