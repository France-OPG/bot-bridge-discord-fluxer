import { LinkConfig } from '../config/schema.js';
import { DiscoveredChannel } from '../platform/types.js';

export interface DroppedLink {
  /** Plateforme du salon introuvable. */
  source: 'discord' | 'fluxer';
  id: string;
  name: string;
}

export interface AutoLinkOutcome {
  /** Liens finaux : manuels encore valides + liaisons automatiques. */
  links: LinkConfig[];
  /** Liens manuels abandonnés (salon disparu ou placeholder). */
  drops: DroppedLink[];
  /** Nombre de liaisons créées automatiquement. */
  added: number;
}

const sortByPosition = (a: DiscoveredChannel, b: DiscoveredChannel): number => a.position - b.position;

/** "Salon-Général" / "général" / "general" -> "general". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Construit automatiquement les paires de salons texte entre Discord et
 * Fluxer :
 *   1. les liens manuels valides sont conservés ;
 *   2. les paires de mêmes noms sont reliées (normalisation des accents/casse) ;
 *   3. le reliquat est apparié par ordre de position ;
 *   4. un lien manuel dont un salon n'existe plus est retiré (self-heal).
 */
export function buildAutoLinks(params: {
  existing: LinkConfig[];
  discord: DiscoveredChannel[];
  fluxer: DiscoveredChannel[];
}): AutoLinkOutcome {
  const { existing, discord, fluxer } = params;

  const drops: DroppedLink[] = [];
  const kept: LinkConfig[] = [];
  const usedDiscord = new Set<string>();
  const usedFluxer = new Set<string>();

  for (const link of existing) {
    const dOk = discord.some((c) => c.id === link.discord_channel_id);
    const fOk = fluxer.some((c) => c.id === link.fluxer_channel_id);
    if (dOk && fOk) {
      kept.push(link);
      usedDiscord.add(link.discord_channel_id);
      usedFluxer.add(link.fluxer_channel_id);
    } else {
      drops.push({
        source: dOk ? 'fluxer' : 'discord',
        id: dOk ? link.fluxer_channel_id : link.discord_channel_id,
        name: link.name,
      });
    }
  }

  const dFree = discord.filter((c) => !usedDiscord.has(c.id)).sort(sortByPosition);
  const fFree = fluxer.filter((c) => !usedFluxer.has(c.id)).sort(sortByPosition);

  const added: LinkConfig[] = [];
  const matchedFluxer = new Set<string>();
  const matchedDiscord = new Set<string>();

  const byName = new Map<string, DiscoveredChannel>();
  for (const c of fFree) {
    const key = normalizeName(c.name);
    if (key && !byName.has(key)) byName.set(key, c);
  }

  for (const d of dFree) {
    const key = normalizeName(d.name);
    const target = key ? byName.get(key) : undefined;
    if (!target) continue;
    added.push({ name: d.name, discord_channel_id: d.id, fluxer_channel_id: target.id, text: true });
    matchedDiscord.add(d.id);
    matchedFluxer.add(target.id);
  }

  const restD = dFree.filter((c) => !matchedDiscord.has(c.id));
  const restF = fFree.filter((c) => !matchedFluxer.has(c.id));
  for (let i = 0; i < Math.min(restD.length, restF.length); i += 1) {
    const d = restD[i];
    const f = restF[i];
    added.push({ name: d.name, discord_channel_id: d.id, fluxer_channel_id: f.id, text: true });
  }

  // Déduplique les paires identiques (config doublonnée, relances…) : un
  // message ne doit jamais être relayé deux fois vers le même salon.
  const seenPairs = new Set<string>();
  const unique: LinkConfig[] = [];
  for (const link of [...kept, ...added]) {
    const key = `${link.discord_channel_id}|${link.fluxer_channel_id}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    unique.push(link);
  }

  return { links: unique, drops, added: added.length };
}