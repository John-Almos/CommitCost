import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheEntry<T> {
  storedAt: number;
  /** Absolute expiry in ms since epoch; null means never expires. */
  expiresAt: number | null;
  value: T;
}

/**
 * Tiny JSON-on-disk cache. Used to avoid paying for repeat Cost Explorer
 * requests ($0.01 each). Keys are hashed, so nothing request-specific (and
 * never a credential) appears in file names.
 */
export class FileCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private path(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  get<T>(key: string): T | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.path(key), "utf8")) as CacheEntry<T>;
      if (entry.expiresAt !== null && entry.expiresAt <= this.now()) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T, ttlMs: number | null): void {
    mkdirSync(this.dir, { recursive: true });
    const now = this.now();
    const entry: CacheEntry<T> = { storedAt: now, expiresAt: ttlMs === null ? null : now + ttlMs, value };
    // Write then rename so a crash never leaves a half-written entry.
    const file = this.path(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  }
}
