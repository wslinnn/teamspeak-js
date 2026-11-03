import { describe, it, expect } from "vitest";
import { RttStats, VoiceTrailer } from "./voice-trailer.js";

describe("RttStats", () => {
  it("reports null deviation without samples", () => {
    expect(new RttStats().deviationMs()).toBeNull();
  });

  it("computes the population deviation of the window", () => {
    const stats = new RttStats();
    stats.add(40);
    stats.add(60);
    expect(stats.deviationMs()).toBeCloseTo(10);
  });

  it("keeps only the last 20 samples", () => {
    const stats = new RttStats();
    for (let index = 0; index < 20; index++) stats.add(100);
    stats.add(0);
    // 19 x 100 and 1 x 0 → mean 95, population deviation sqrt(475).
    expect(stats.deviationMs()).toBeCloseTo(Math.sqrt(475));
  });

  it("ignores negative and non-finite samples", () => {
    const stats = new RttStats();
    stats.add(-1);
    stats.add(Number.NaN);
    expect(stats.deviationMs()).toBeNull();
  });
});

describe("VoiceTrailer", () => {
  it("omits the byte without samples and still consumes the five-packet gate", () => {
    const trailer = new VoiceTrailer(new RttStats());
    for (let index = 0; index < 5; index++) expect(trailer.next()).toBeNull();
    expect(trailer.next()).toBeNull();
  });

  it("reports floor(3 * deviation) on the first five packets only", () => {
    const stats = new RttStats();
    stats.add(40);
    stats.add(60); // deviation 10 → 30
    const trailer = new VoiceTrailer(stats);
    for (let index = 0; index < 5; index++) expect(trailer.next()).toBe(30);
    expect(trailer.next()).toBeNull();
  });

  it("clamps overflow to the 0xFE sentinel", () => {
    const stats = new RttStats();
    stats.add(0);
    stats.add(1_000); // deviation 500 → 1500 > 254
    const trailer = new VoiceTrailer(stats);
    expect(trailer.next()).toBe(254);
  });
});
