import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/rate/httpClient.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HttpClient', () => {
  it('envoie au bon endpoint et retourne le JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://api.example/v1/' });
    const body = await client.getJson<{ ok: boolean }>('/status');

    expect(body.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example/v1/status');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('relaye un token d’authentification ajouté à la construction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({
      baseUrl: 'https://api.example/v1',
      headers: { Authorization: 'Bot secret' },
    });
    await client.getJson('/ping');

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bot secret');
  });

  it('respecte Retry-After sur 429 puis réussit', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, {}, { 'retry-after': '0.05' });
      return jsonResponse(200, { recovered: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://api.example/v1', requestsPerSecond: 1000 });
    const started = Date.now();
    const result = await client.getJson<{ recovered: boolean }>('/things');
    expect(result.recovered).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(calls).toBe(2);
  });

  it('abandonne après épuisement des nouvelles tentatives réseau', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://api.example/v1', maxRetries: 2 });
    await expect(client.getJson('/things')).rejects.toThrow(/Échec réseau/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 essai + 2 retries
  });

  it('retente les 5xx selon maxRetries', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) return jsonResponse(503, {});
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://api.example/v1', requestsPerSecond: 1000, maxRetries: 3 });
    const body = await client.getJson('/things');
    expect(body).toEqual({});
    expect(calls).toBe(4);
  });
});