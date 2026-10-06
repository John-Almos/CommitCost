/** Small seeded PRNG (mulberry32) so mock data is reproducible across runs. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() from empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller. */
  gaussian(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  hex(length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }

  /** Derives an independent stream, so adding draws to one part of the
   * generator doesn't shift the numbers another part sees. */
  fork(label: string): Rng {
    let h = this.state ^ 0x811c9dc5;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    return new Rng(h >>> 0);
  }
}
