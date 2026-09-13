import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate/rateLimiter.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RateLimiter', () => {
  it('autorise immédiatement les requêtes dans la limite', async () => {
    const limiter = new RateLimiter(3, 500);
    expect(limiter.canAcquire()).toBe(true);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.canAcquire()).toBe(false);
  });

  it('bloque après épuisement puis se régénère', async () => {
    const windowMs = 200;
    const limiter = new RateLimiter(1, windowMs);
    await limiter.acquire();
    expect(limiter.canAcquire()).toBe(false);
    await sleep(windowMs + 60);
    expect(limiter.canAcquire()).toBe(true);
  });

  it('cooldown met à zéro et impose un délai', async () => {
    const limiter = new RateLimiter(1, 400);
    expect(limiter.canAcquire()).toBe(true);
    await limiter.cooldown(50);
    expect(limiter.canAcquire()).toBe(false);
    await sleep(150);
    expect(limiter.canAcquire()).toBe(false);
    await sleep(400);
    expect(limiter.canAcquire()).toBe(true);
  });

  it('acquire attend lorsque le bucket est vide', async () => {
    const limiter = new RateLimiter(1, 100);
    await limiter.acquire();
    const started = Date.now();
    let resolved = false;
    const promise = limiter.acquire().then(() => {
      resolved = true;
    });
    await sleep(60);
    expect(resolved).toBe(false);
    await promise;
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});