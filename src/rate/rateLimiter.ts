const WINDOW_MS = 1000;

/**
 * Bucket à jetons par clé (route HTTP). Limite `max` requêtes par fenêtre
 * glissante de `WINDOW_MS`. Utilisé pour respecter les rate limits par
 * endpoint des plateformes (Discord et Fluxer).
 */
export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private tokens: number;
  private refilledAt: number;

  constructor(max: number, windowMs = WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
    this.tokens = max;
    this.refilledAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.refilledAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.max, this.tokens + (elapsed / this.windowMs) * this.max);
      this.refilledAt = now;
    }
  }

  /** Attend quand nécessaire pour que la requête soit autorisée. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.windowMs)));
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Bloque pendant `ms` (utilisé après une réponse 429 avec Retry-After). */
  async cooldown(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.tokens = 0;
    this.refilledAt = Date.now();
  }

  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1;
  }
}