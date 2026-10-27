import type { Pixels } from "./models";

/**
 * Decoded images kept for the engines that need them again (an export, the next video), within a
 * memory budget: a 12-megapixel photo is 48 MB of RGBA, so keeping every one ever opened is what
 * made the editor grow without end. Least recently used go first; an evicted image is decoded
 * again from the browser's HTTP cache when it is needed.
 */
export class PixelCache {
  private entries = new Map<string, { pixels: Promise<Pixels | null>; bytes: number }>();
  private total = 0;
  private readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  get(key: string, load: () => Promise<Pixels | null>): Promise<Pixels | null> {
    const hit = this.entries.get(key);
    if (hit) {
      // Most recent last: Map keeps insertion order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.pixels;
    }
    const entry = { pixels: load(), bytes: 0 };
    this.entries.set(key, entry);
    void entry.pixels.then((px) => {
      if (this.entries.get(key) !== entry) return;
      entry.bytes = px?.rgba.byteLength ?? 0;
      this.total += entry.bytes;
      this.trim(key);
    });
    return entry.pixels;
  }

  private trim(keep: string) {
    for (const [k, e] of this.entries) {
      if (this.total <= this.budget) return;
      if (k === keep || e.bytes === 0) continue;
      this.entries.delete(k);
      this.total -= e.bytes;
    }
  }
}
