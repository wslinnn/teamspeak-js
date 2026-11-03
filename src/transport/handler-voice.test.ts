import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crypt } from "../crypto/crypt.js";
import { PacketHandler } from "./handler.js";
import { PacketFlags, PacketType } from "./packet.js";

class FakeSocket extends EventEmitter {
  readonly sent: Uint8Array[] = [];

  send(data: Buffer, callback?: (error?: Error | null) => void): void {
    this.sent.push(new Uint8Array(data));
    callback?.();
  }

  close(): void {}
}

function createHandler(cryptoInitComplete: boolean): {
  handler: PacketHandler;
  socket: FakeSocket;
} {
  const crypt = {
    cryptoInitComplete,
    fakeSignature: new Uint8Array(8),
    encrypt: () => [new Uint8Array(0), new Uint8Array(8)],
    // The pong payload carries the ping id; returning the ciphertext verbatim
    // lets the test drive the RTT path without a real handshake.
    decrypt: (
      _pType: number,
      _pID: number,
      _gen: number,
      _header: Uint8Array,
      ciphertext: Uint8Array,
    ) => ciphertext,
  } as unknown as Crypt;
  const handler = new PacketHandler(crypt);
  const socket = new FakeSocket();
  handler.start(socket as never);
  socket.sent.length = 0; // drop the Init1 datagram
  return { handler, socket };
}

/** C2S header: 8 (tag) + 2 (packet id) + 2 (client id) + 1 (typeFlagged). */
function typeFlagged(datagram: Uint8Array): number {
  return datagram[12]!;
}

describe("voice packet trailer and flags", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not set the group-whisper flag (0x20) on direct whisper targets", () => {
    const { handler, socket } = createHandler(false);
    handler.sendWhisperPacket(new Uint8Array([9, 8]), [7, 8], 4);
    const datagram = socket.sent.at(-1)!;

    expect(typeFlagged(datagram) & 0x0f).toBe(PacketType.VoiceWhisper);
    // 0x20 selects the group-whisper layout on voice packets; direct targets
    // must keep it clear or the server parses the target list as a group id.
    expect(typeFlagged(datagram) & PacketFlags.NewProtocol).toBe(0);
    expect(typeFlagged(datagram) & PacketFlags.Unencrypted).toBe(PacketFlags.Unencrypted);
    // No RTT sample yet: no trailer byte, payload layout unchanged.
    expect(typeFlagged(datagram) & 0x40).toBe(0);
    const payload = datagram.subarray(13);
    expect(payload.length).toBe(5 + 2 * 2 + 2);
    expect([...payload.subarray(5, 7)]).toEqual([0, 7]);
    expect([...payload.subarray(7, 9)]).toEqual([0, 8]);
    expect([...payload.subarray(9)]).toEqual([9, 8]);
    handler.close();
  });

  it("omits the trailer byte on outgoing voice before any RTT sample", () => {
    const { handler, socket } = createHandler(false);
    handler.sendVoicePacket(new Uint8Array([1, 2, 3]), 4);
    const datagram = socket.sent.at(-1)!;
    expect(typeFlagged(datagram) & 0x40).toBe(0);
    expect(datagram.subarray(13).length).toBe(3 + 3);
    handler.close();
  });

  it("reports the RTT deviation trailer on the first five voice packets", () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { handler, socket } = createHandler(true);

    const roundTrip = (rttMs: number): void => {
      socket.sent.length = 0;
      // The ping interval started at startedAt; advance to its next 5s boundary
      // so the measured RTT is exactly rttMs (timer callbacks see boundary time).
      vi.advanceTimersByTime(5_000 - ((Date.now() - startedAt) % 5_000));
      const ping = socket.sent.find(
        (datagram) => (typeFlagged(datagram) & 0x0f) === PacketType.Ping,
      );
      expect(ping).toBeDefined();
      const pingId = (ping![8]! << 8) | ping![9]!;
      vi.advanceTimersByTime(rttMs);
      const raw = new Uint8Array(13);
      raw[10] = PacketType.Pong;
      raw[11] = pingId >> 8;
      raw[12] = pingId & 0xff;
      socket.emit("message", Buffer.from(raw));
    };
    roundTrip(40);
    roundTrip(60); // samples [40, 60] → deviation 10 → trailer 30

    socket.sent.length = 0;
    for (let index = 0; index < 6; index++) handler.sendVoicePacket(new Uint8Array([1, 2, 3]), 4);
    const datagrams = socket.sent.slice(-6);
    for (let index = 0; index < 5; index++) {
      const datagram = datagrams[index]!;
      expect(typeFlagged(datagram) & 0x40).toBe(0x40);
      expect(datagram.length).toBe(13 + 3 + 3 + 1);
      expect(datagram[datagram.length - 1]).toBe(30);
    }
    const sixth = datagrams[5]!;
    expect(typeFlagged(sixth) & 0x40).toBe(0);
    expect(sixth.length).toBe(13 + 3 + 3);
    handler.close();
  });
});
