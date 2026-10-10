import { describe, it, expect } from "vitest";
import { Client, generateIdentity } from "./index.js";
import { PacketType, type Packet } from "./transport/packet.js";

function commandPacket(text: string): Packet {
  return {
    typeFlagged: PacketType.Command,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: new TextEncoder().encode(text),
    receivedAt: Date.now(),
  };
}

function connectedBot(nickname: string, clid: number): Client {
  const client = new Client(generateIdentity(0), "127.0.0.1:9987", nickname);
  // clid as initserver's aclid would have assigned during the handshake.
  client.clid = clid;
  client.handler.setClientID(clid);
  return client;
}

describe("Client self identification on notifycliententerview", () => {
  it("ignores another client named <own nick><digits>", () => {
    const client = connectedBot("Bot", 5);

    client.handler.onPacket?.(commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot2"));

    expect(client.clid).toBe(5);
  });

  it("tracks the server-assisted rename on its own clientEnter", () => {
    const client = connectedBot("Bot", 5);

    client.handler.onPacket?.(commandPacket("notifycliententerview clid=5 ctid=1 client_nickname=Bot2"));

    expect(client.clid).toBe(5);
    expect(client.nickname).toBe("Bot2");
  });

  it("still learns its clid from the welcome enter when initserver lacked aclid", () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");

    client.handler.onPacket?.(commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"));

    expect(client.clid).toBe(7);
  });
});
