import { describe, it, expect } from "vitest";
import { Client, generateIdentity } from "./index.js";
import type { VoiceData } from "./types.js";

describe("S2C voice parsing", () => {
  it("exposes VId, high-nibble flags and the whisper type", async () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    const seen: VoiceData[] = [];
    client.on("voiceData", (data) => {
      seen.push(data);
    });
    const payload = new Uint8Array([0x12, 0x34, 0x02, 0x01, 4, 9, 8, 7]);
    const packet = {
      id: 0,
      clientID: 0,
      generationID: 0,
      data: payload,
      receivedAt: 0,
    };

    client.handler.onPacket?.({ ...packet, typeFlagged: 1 | 0x20 | 0x40 | 0x80 });
    client.handler.onPacket?.({ ...packet, typeFlagged: 0 | 0x80 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      clientId: 513,
      codec: 4,
      data: new Uint8Array([9, 8, 7]),
      vid: 0x1234,
      flags: 0xe0,
      isWhisper: true,
    });
    expect(seen[1]!.flags).toBe(0x80);
    expect(seen[1]!.isWhisper).toBe(false);
  });
});
