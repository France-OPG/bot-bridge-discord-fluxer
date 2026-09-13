export type EmojiMode = 'text' | 'raw' | 'strip';

const DISCORD_EMOJI = /<(a)?:(\w+):(\d{17,26})>/g;

/**
 * Convertit les emojis custom d'une plateforme en représentation compatible
 * avec l'autre. Les emojis Unicode passent tels quels.
 *
 * @param content texte d'origine
 * @param mode    text | raw | strip
 * @param textPrefix préfixe de repli pour les emojis non résolvables (ex "." ou ":").
 */
export function convertEmojis(content: string, mode: EmojiMode, textPrefix = ':'): string {
  if (mode === 'raw') return content;
  if (mode === 'strip') {
    return content.replace(DISCORD_EMOJI, '').replace(/:[a-zA-Z0-9_+]{2,32}:?/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  return content.replace(DISCORD_EMOJI, (_m, _animated, name: string) => `${textPrefix}${name}${textPrefix}`);
}

/**
 * Préfixe d'affichage du message provenant de la plateforme source.
 * Exemple : "[Discord] ".
 */
export function platformTag(displayPrefix: string, name: string): string {
  if (!displayPrefix) return name;
  return `[${displayPrefix}] ${name}`;
}

/**
 * Construit le contenu final relayé : conversions d'emojis puis marqueur
 * de fin (signature anti-boucle).
 */
export function buildRelayedContent(
  original: string,
  options: { emojiMode: EmojiMode; signature: string },
): string {
  let content = convertEmojis(original, options.emojiMode);
  if (options.signature && !content.endsWith(options.signature)) {
    content = `${content}${options.signature}`;
  }
  return content;
}

/**
 * Ligne de citation pour matérialiser une réponse lorsqu'on relaie.
 * Exemple :
 *   > **Alice** : *hello* (réponse)
 *   votre texte
 */
export function buildReplyQuote(authorName: string, preview: string): string {
  const cleaned = preview.replace(/\r?\n/g, ' ').slice(0, 120);
  return `> **${authorName}** : ${cleaned}\n`;
}

/** Contenu combiné pour un message répondant à un autre. */
export function buildRelayWithReply(
  content: string,
  replyContext: { authorName: string; preview: string } | null,
  options: { emojiMode: EmojiMode; signature: string },
): string {
  const base = buildRelayedContent(content, options);
  if (!replyContext) return base;
  const quote = buildReplyQuote(replyContext.authorName, replyContext.preview);
  return `${quote}${content === '' ? '' : base}`;
}