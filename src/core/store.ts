import * as fs from 'node:fs';
import * as path from 'node:path';
import { SeenMessage } from './types.js';

/**
 * Persistance des correspondances de messages entre les deux plateformes.
 * Utilise un simple fichier JSON (écriture atomique) — adapté à un pont
 * mono-instance auto-hébergé.
 */
export class LinkStore {
  private readonly filePath: string;
  private byMessageId = new Map<string, SeenMessage>();
  private readonly maxEntries: number;

  constructor(filePath: string, maxEntries = 20000) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { entries: SeenMessage[] };
      for (const entry of parsed.entries ?? []) {
        this.byMessageId.set(this.key(entry.platform, entry.id), entry);
      }
    } catch {
      this.byMessageId.clear();
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ entries: [...this.byMessageId.values()] });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  private key(platform: string, id: string): string {
    return `${platform}:${id}`;
  }

  find(platform: string, messageId: string): SeenMessage | undefined {
    return this.byMessageId.get(this.key(platform, messageId));
  }

  has(platform: string, messageId: string): boolean {
    return this.byMessageId.has(this.key(platform, messageId));
  }

  /** Retrouve le message relayé à partir de l'id du message source. */
  bySource(platform: string, messageId: string): SeenMessage | undefined {
    for (const entry of this.byMessageId.values()) {
      if (entry.platform === platform && entry.sourceId === messageId) {
        return entry;
      }
    }
    return undefined;
  }

  record(entry: SeenMessage): void {
    this.byMessageId.set(this.key(entry.platform, entry.id), entry);
    if (this.byMessageId.size > this.maxEntries) {
      const oldest = [...this.byMessageId.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, this.byMessageId.size - this.maxEntries);
      for (const [key] of oldest) this.byMessageId.delete(key);
    }
    this.save();
  }

  remove(platform: string, messageId: string): void {
    if (this.byMessageId.delete(this.key(platform, messageId))) {
      this.save();
    }
  }

  size(): number {
    return this.byMessageId.size;
  }
}