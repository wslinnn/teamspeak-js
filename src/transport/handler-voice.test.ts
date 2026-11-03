import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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

function createHandler(cryptoInitComplete: boolean): { handler: PacketHandler; socket: FakeSocket } {
  const crypt = {
    cryptoInitComplete,
    fakeSignature: new Uint8Array(8),
    encrypt: () => [new Uint8Array(0), new Uint8Array(8)],
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

describe("voice packet flags", () => {
  it("sets the whisper flag (0x20) on outgoing whispers", () => {
    const { handler, socket } = createHandler(false);
    handler.sendWhisperPacket(new Uint8Array([9, 8]), [7, 8], 4);
    const datagram = socket.sent.at(-1)!;

    expect(typeFlagged(datagram) & 0x0f).toBe(PacketType.VoiceWhisper);
    expect(typeFlagged(datagram) & PacketFlags.NewProtocol).toBe(PacketFlags.NewProtocol);
    expect(typeFlagged(datagram) & PacketFlags.Unencrypted).toBe(PacketFlags.Unencrypted);
    // Payload layout is unchanged: [VId][codec][0][count][targets][audio].
    const payload = datagram.subarray(13);
    expect(payload.length).toBe(5 + 2 * 2 + 2);
    expect([...payload.subarray(5, 7)]).toEqual([0, 7]);
    expect([...payload.subarray(7, 9)]).toEqual([0, 8]);
    expect([...payload.subarray(9)]).toEqual([9, 8]);
    handler.close();
  });
});
