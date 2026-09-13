import { getLogger } from '../logging/logger.js';
import { RateLimiter } from './rateLimiter.js';

export interface HttpClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Nombre de requêtes autorisées par secondes sur une même clé. */
  requestsPerSecond?: number;
  maxRetries?: number;
}

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

/**
 * Client HTTP léger avec :
 *  - rate limiting par clé (bucket à jetons par seconde) ;
 *  - respect de l'en-tête Retry-After (429) ;
 *  - backoff exponentiel sur erreurs réseau et 5xx ;
 *  - retraits des tokens et secrets.
 */
export class HttpClient {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly requestsPerSecond: number;
  private readonly maxRetries: number;
  private readonly baseRate: number;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.headers = { ...(options.headers ?? {}) };
    this.requestsPerSecond = options.requestsPerSecond ?? 20;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseRate = options.requestsPerSecond ?? 20;
  }

  private limiterFor(key: string): RateLimiter {
    const rate = key === 'default' ? this.baseRate : this.requestsPerSecond;
    let bucket = this.limiters.get(key);
    if (!bucket) {
      bucket = new RateLimiter(rate);
      this.limiters.set(key, bucket);
    }
    return bucket;
  }

  async request(
    path: string,
    init: RequestInit = {},
    options: { rateKey?: string; retry?: boolean } = {},
  ): Promise<Response> {
    const rateKey = options.rateKey ?? path;
    const bucket = this.limiterFor(rateKey);
    const retries = options.retry === false ? 0 : this.maxRetries;

    let attempt = 0;
    for (;;) {
      await bucket.acquire();

      const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      };

      let response: Response;
      try {
        response = await fetch(url, { ...init, headers });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < retries) {
          const delay = 250 * 2 ** attempt;
          getLogger().warn({ err: message, path, attempt, delay }, 'erreur réseau, nouvelle tentative');
          await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 200));
          attempt += 1;
          continue;
        }
        throw new Error(`Échec réseau pour ${path}: ${message}`);
      }

      if (response.status === 429) {
        const retryAfterS = Number(response.headers.get('retry-after') ?? '1');
        const retryAfterMs = Number.isFinite(retryAfterS) ? retryAfterS * 1000 : 1000;
        getLogger().warn({ path, retryAfterMs }, '429 — rate limit respecté');
        await bucket.cooldown(retryAfterMs + 100);
        if (attempt < retries) {
          attempt += 1;
          continue;
        }
        return response;
      }

      if (RETRYABLE_5XX.has(response.status) && attempt < retries) {
        const delay = 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 200));
        attempt += 1;
        continue;
      }

      return response;
    }
  }

  async getJson<T>(path: string, init: RequestInit = {}, options?: { rateKey?: string }): Promise<T> {
    const response = await this.request(path, init, options);
    if (!response.ok) {
      throw new Error(`GET ${path} → ${response.status} ${await response.text().catch(() => '')}`);
    }
    return (await response.json()) as T;
  }

  async send(path: string, init: RequestInit, options?: { rateKey?: string }): Promise<Response> {
    return this.request(path, init, options);
  }
}