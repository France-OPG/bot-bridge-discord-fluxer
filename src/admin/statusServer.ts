import { createServer, Server, ServerResponse } from 'node:http';
import { AdminConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import { BridgeService } from '../core/bridge.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

/**
 * Serveur de supervision : met à disposition des endpoints locaux de
 * santé et de statistiques (aucun secret n'y transite).
 */
export function startStatusServer(admin: AdminConfig, bridge: BridgeService): Promise<Server> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      switch (url) {
        case '/health':
          sendJson(res, 200, { ok: true });
          return;
        case '/status':
          sendJson(res, 200, bridge.getStatus());
          return;
        case '/links':
          sendJson(res, 200, { links: bridge.getStatus().links });
          return;
        case '/':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body><h1>discord-fluxer-bridge</h1>' +
              '<ul><li><a href="/health">/health</a></li><li><a href="/status">/status</a></li>' +
              '<li><a href="/links">/links</a></li></ul></body></html>',
          );
          return;
        default:
          sendJson(res, 404, { error: 'not_found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().error({ err: message }, 'erreur serveur de statut');
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message });
      else res.end();
    }
  });

  server.on('error', (err) => {
    getLogger().error({ err: err.message }, 'serveur de statut en erreur');
  });

  return new Promise<Server>((resolve) => {
    server.listen(admin.status_port, admin.status_host, () => {
      getLogger().info(
        { host: admin.status_host, port: admin.status_port },
        'Serveur de statut démarré (health, status, links)',
      );
      resolve(server);
    });
  });
}

export function stopStatusServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Force la fermeture si des connexions restent ouvertes.
    server.closeAllConnections?.();
  });
}