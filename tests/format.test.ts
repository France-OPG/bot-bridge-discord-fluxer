import { describe, expect, it } from 'vitest';
import {
  buildRelayWithReply,
  buildRelayedContent,
  buildReplyQuote,
  convertEmojis,
  platformTag,
} from '../src/core/format.js';

describe('convertEmojis', () => {
  it('convertit les emojis custom Discord en :name: (mode text)', () => {
    expect(convertEmojis('salut <:wave:123456789012345678> !', 'text')).toBe('salut :wave: !');
    expect(convertEmojis('a <a:party:987654321098765432> b', 'text')).toBe('a :party: b');
  });

  it('laisse le texte inchangé en mode raw', () => {
    const content = 'gm <:wave:123456789012345678>';
    expect(convertEmojis(content, 'raw')).toBe(content);
  });

  it('supprime les emojis custom et nommés en mode strip', () => {
    const result = convertEmojis('woah <:wave:123456789012345678> :joy:', 'strip');
    expect(result).not.toContain('wave');
    expect(result).not.toContain('joy');
  });

  it('gère les emojis unicode', () => {
    expect(convertEmojis('ça marche 👀', 'text')).toBe('ça marche 👀');
  });
});

describe('buildRelayedContent', () => {
  it('ajoute la signature sans la dupliquer', () => {
    expect(buildRelayedContent('bonjour', { emojiMode: 'text', signature: '\u200bDxF' })).toBe(
      'bonjour\u200bDxF',
    );
    expect(
      buildRelayedContent('bonjour\u200bDxF', { emojiMode: 'text', signature: '\u200bDxF' }),
    ).toBe('bonjour\u200bDxF');
  });

  it('sans signature ni conversion, reste identique', () => {
    expect(buildRelayedContent('plain', { emojiMode: 'raw', signature: '' })).toBe('plain');
  });
});

describe('buildReplyQuote', () => {
  it('produit une citation sur une ligne', () => {
    expect(buildReplyQuote('Alice', 'un\npeu long')).toBe('> **Alice** : un peu long\n');
  });

  it('tronque les préviews très longues à 120 caractères', () => {
    const out = buildReplyQuote('Alice', 'x'.repeat(300));
    expect(out).toBe(`> **Alice** : ${'x'.repeat(120)}\n`);
  });
});

describe('buildRelayWithReply', () => {
  it('préfixe une citation quand on connaît le contexte', () => {
    const out = buildRelayWithReply('réponse', { authorName: 'Bob', preview: 'question' }, {
      emojiMode: 'raw',
      signature: '',
    });
    expect(out).toBe('> **Bob** : question\nréponse');
  });
});

describe('platformTag', () => {
  it('ajoute le préfixe de plateforme', () => {
    expect(platformTag('Discord', 'Alice')).toBe('[Discord] Alice');
    expect(platformTag('', 'Alice')).toBe('Alice');
  });
});