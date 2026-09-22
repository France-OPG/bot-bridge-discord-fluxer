import { describe, expect, it } from 'vitest';
import { buildAutoLinks, normalizeName } from '../src/core/autoLink.js';
import { LinkConfig } from '../src/config/schema.js';
import { DiscoveredChannel } from '../src/platform/types.js';

const ch = (id: string, name: string, position: number): DiscoveredChannel => ({ id, name, position });

function link(name: string, d: string, f: string): LinkConfig {
  return { name, discord_channel_id: d, fluxer_channel_id: f, text: true };
}

describe('normalizeName', () => {
  it('normalise casse, accents et caractères spéciaux', () => {
    expect(normalizeName('Salon-Général')).toBe('salongeneral');
    expect(normalizeName('général')).toBe('general');
    expect(normalizeName(' Chât 2 ')).toBe('chat2');
  });
});

describe('buildAutoLinks', () => {
  it('apparie les salons de même nom (insensible casse/accents)', () => {
    const discord = [ch('d1', 'Général', 0), ch('d2', 'Bots', 1)];
    const fluxer = [ch('f1', 'general', 3), ch('f2', 'bots', 5)];
    const outcome = buildAutoLinks({ existing: [], discord, fluxer });

    expect(outcome.added).toBe(2);
    expect(outcome.drops).toHaveLength(0);
    expect(outcome.links[0]).toMatchObject({ discord_channel_id: 'd1', fluxer_channel_id: 'f1' });
    expect(outcome.links[1]).toMatchObject({ discord_channel_id: 'd2', fluxer_channel_id: 'f2' });
  });

  it('conserve les liens manuels valides et abandonne les obsolètes', () => {
    const existing = [link('ok', 'd1', 'f1'), link('placeholder', '123456789012345678', '987654321098765432')];
    const discord = [ch('d1', 'general', 0)];
    const fluxer = [ch('f1', 'general', 0)];
    const outcome = buildAutoLinks({ existing, discord, fluxer });

    expect(outcome.links).toHaveLength(1);
    expect(outcome.links[0].name).toBe('ok');
    expect(outcome.drops).toHaveLength(1);
    expect(outcome.drops[0]).toMatchObject({ source: 'discord' });
  });

  it('apparie le reliquat par ordre de position', () => {
    const discord = [ch('d1', 'alpha', 10), ch('d2', 'zzz', 20)];
    const fluxer = [ch('f1', 'autre', 1), ch('f2', 'machin', 2)];
    const outcome = buildAutoLinks({ existing: [], discord, fluxer });

    expect(outcome.added).toBe(2);
    expect(outcome.links[0]).toMatchObject({ discord_channel_id: 'd1', fluxer_channel_id: 'f1' });
    expect(outcome.links[1]).toMatchObject({ discord_channel_id: 'd2', fluxer_channel_id: 'f2' });
  });

  it('ne crée pas de lien fantôme quand un côté est vide', () => {
    const discord = [ch('d1', 'general', 0)];
    const fluxer = [];
    const outcome = buildAutoLinks({ existing: [], discord, fluxer });

    expect(outcome.added).toBe(0);
    expect(outcome.links).toHaveLength(0);
  });

  it('préfère le nom exact avant l\'appariement par position', () => {
    const discord = [ch('d1', 'general', 1), ch('d2', 'portails', 0)];
    const fluxer = [ch('f1', 'portails', 0), ch('f2', 'general', 1)];
    const outcome = buildAutoLinks({ existing: [], discord, fluxer });

    expect(outcome.links[0]).toMatchObject({ discord_channel_id: 'd2', fluxer_channel_id: 'f1' });
    expect(outcome.links[1]).toMatchObject({ discord_channel_id: 'd1', fluxer_channel_id: 'f2' });
  });

  it('déduplique les paires identiques (config doublonnée)', () => {
    const discord = [ch('d1', 'general', 0)];
    const fluxer = [ch('f1', 'general', 0)];
    const dup: LinkConfig = {
      name: 'duplicata',
      discord_channel_id: 'd1',
      fluxer_channel_id: 'f1',
      text: true,
    };
    const outcome = buildAutoLinks({ existing: [dup, dup], discord, fluxer });

    expect(outcome.links).toHaveLength(1);
    expect(outcome.links[0].discord_channel_id).toBe('d1');
  });
});