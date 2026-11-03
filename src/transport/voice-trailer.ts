/** Sliding-window RTT statistics feeding the voice trailer byte. The official
 *  client tracks ping/pong round-trip deviation over the last <=20 samples
 *  (36 号 R15) and reports floor(3 * deviation) on the first five voice
 *  packets of a connection. */
export class RttStats {
  readonly #samples: number[] = [];

  add(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.#samples.push(rttMs);
    if (this.#samples.length > 20) this.#samples.shift();
  }

  /** Population standard deviation in milliseconds, or null without samples. */
  deviationMs(): number | null {
    const count = this.#samples.length;
    if (count === 0) return null;
    const mean = this.#samples.reduce((sum, value) => sum + value, 0) / count;
    const variance = this.#samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
    return Math.sqrt(variance);
  }
}

/** 0x40 on a voice/whisper packet means "trailer byte present" (on commands the
 *  same bit is Compressed; the flag byte is reinterpreted per packet type). */
export const VOICE_TRAILER_FLAG = 0x40;

/** 0xFE is the overflow sentinel: floor(3 * deviation) above this is clamped. */
const VOICE_TRAILER_MAX = 254;
/** The trailer only appears on the first five voice packets of a connection. */
const VOICE_TRAILER_PACKET_LIMIT = 5;

/**
 * First-five-packets voice trailer. The official client increments its counter
 * for every voice packet (voice and whisper share it), consumes the gate even
 * when no RTT sample exists, and omits the byte afterwards (0xFF semantics).
 */
export class VoiceTrailer {
  #sent = 0;

  constructor(private readonly stats: RttStats) {}

  /** Returns this packet's trailer byte, or null when it must be omitted. */
  next(): number | null {
    if (this.#sent >= VOICE_TRAILER_PACKET_LIMIT) return null;
    this.#sent++;
    const deviation = this.stats.deviationMs();
    if (deviation === null) return null;
    const scaled = deviation * 3;
    return scaled > VOICE_TRAILER_MAX ? VOICE_TRAILER_MAX : Math.floor(scaled);
  }
}
