import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BridgeAttachment } from './types.js';

export interface DownloadedAttachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
  /** Chemin d'un fichier temporaire éventuellement écrit (si sizeDelta > 0). */
  tmpPath?: string;
  size: number;
}

/**
 * Télécharge une pièce jointe avec une limite de taille et un cache local.
 * Retourne `null` si le fichier est trop volumineux ou introuvable.
 */
export async function downloadAttachment(
  attachment: BridgeAttachment,
  options: { maxBytes: number; cacheDir: string },
): Promise<DownloadedAttachment | null> {
  if (attachment.size && attachment.size > options.maxBytes) return null;

  const hash = crypto.createHash('sha1').update(attachment.url).digest('hex').slice(0, 24);
  const cachePath = path.join(options.cacheDir, hash);

  let buffer: Buffer | null = null;
  if (fs.existsSync(cachePath)) {
    buffer = fs.readFileSync(cachePath);
    if (buffer.length > options.maxBytes) return null;
  } else {
    const response = await fetch(attachment.url, { redirect: 'follow' });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > options.maxBytes) return null;

    const received: Buffer[] = [];
    let total = 0;
    if (!response.body) return null;
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk as Buffer);
      total += buf.length;
      if (total > options.maxBytes) return null;
      received.push(buf);
    }
    buffer = Buffer.concat(received);
    fs.mkdirSync(options.cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, buffer);
  }

  const contentType = attachment.contentType ?? guessMime(attachment.filename);
  const safeName = sanitizeFilename(attachment.filename || 'fichier');
  return { buffer, filename: safeName, contentType, size: buffer.length };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').slice(-180);
  return cleaned.length ? cleaned : 'fichier.bin';
}

export function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    zip: 'application/zip',
    json: 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}