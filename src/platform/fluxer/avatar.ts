import { FluxerAuthor } from './rest.js';

/**
 * Résolution best-effort des avatars Fluxer. Le chemin d'hébergement des
 * avatars dépend de l'instance (hébergée ou self-hosted) et n'est pas
 * entièrement documenté ; on essaie donc plusieurs motifs plausibles avec
 * un contrôle HEAD, puis on met en cache la première URL qui répond.
 */
export class FluxerAvatarResolver {
  private readonly cdnBase: string;
  private readonly failed = new Set<string>();
  private readonly successByPrefix = new Map<string, string>();

  constructor(cdnBase: string) {
    this.cdnBase = cdnBase.replace(/\/+$/, '');
  }

  async resolve(author: FluxerAuthor, timeoutMs = 2500): Promise<string | undefined> {
    if (!author?.avatar) return undefined;
    if (/^https?:\/\//.test(author.avatar)) return author.avatar;

    const key = `${author.id}/${author.avatar}`;
    const knownFailure = this.failed.has(key);
    if (knownFailure && !this.successByPrefix.has(this.cdnBase)) return undefined;

    const prefix = this.successByPrefix.get(this.cdnBase);
    if (prefix) return `${prefix}${key}`;

    const candidates = [
      `${this.cdnBase}/media/avatars/${key}`,
      `${this.cdnBase}/media/avatars/${key}.png`,
      `${this.cdnBase}/media/avatars/${key}.webp`,
      `${this.cdnBase}/cdn/avatars/${key}`,
    ];

    for (const url of candidates) {
      if (await this.probe(url, timeoutMs)) {
        this.successByPrefix.set(this.cdnBase, url.slice(0, url.length - key.length));
        this.failed.delete(key);
        return url;
      }
    }

    this.failed.add(key);
    return undefined;
  }

  private async probe(url: string, timeoutMs: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}