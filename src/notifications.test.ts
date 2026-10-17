import { describe, it, expect } from "vitest";
import { handleNotification } from "./notifications.js";
import type { DirectoryClientInfo } from "./types.js";

function makeClients(): Map<number, DirectoryClientInfo> {
  return new Map();
}

describe("handleNotification", () => {
  describe("notifycliententerview", () => {
    it("uses ctid as the client's channel ID", () => {
      const clients = makeClients();
      const cmd = {
        name: "notifycliententerview",
        params: {
          clid: "7",
          ctid: "42",
          client_nickname: "Alice",
          client_unique_identifier: "uid123",
          client_type: "0",
          client_servergroups: "6,9",
        },
      };

      const result = handleNotification(cmd, 1, clients, "Bot");

      expect(result.kind).toBe("clientEnter");
      if (result.kind !== "clientEnter") return;
      expect(result.info.channelID).toBe(42n);
      expect(clients.get(7)?.channelID).toBe(42n);
    });

    it("retains the previous channel when a compressed row omits ctid", () => {
      const clients = new Map<number, DirectoryClientInfo>([
        [
          7,
          {
            id: 7,
            nickname: "Alice",
            uid: "uid123",
            channelID: 42n,
            type: 0,
            serverGroups: [],
          },
        ],
      ]);
      const result = handleNotification(
        {
          name: "notifycliententerview",
          params: {
            clid: "7",
            client_nickname: "Alice",
            client_unique_identifier: "uid123",
            client_type: "0",
          },
        },
        1,
        clients,
        "Bot",
      );

      expect(result.kind).toBe("clientEnter");
      expect(clients.get(7)?.channelID).toBe(42n);
    });
  });

  describe("notifyclientleftview", () => {
    it("treats a non-zero ctid as a move instead of a leave", () => {
      const clients = new Map<number, DirectoryClientInfo>([
        [
          7,
          {
            id: 7,
            nickname: "Alice",
            uid: "uid123",
            channelID: 1n,
            type: 0,
            serverGroups: [],
          },
        ],
      ]);
      const result = handleNotification(
        {
          name: "notifyclientleftview",
          params: {
            clid: "7",
            ctid: "42",
            reasonid: "0",
            invokerid: "8",
            invokername: "Bob",
            invokeruid: "uid456",
          },
        },
        1,
        clients,
        "Bot",
      );

      expect(result.kind).toBe("clientMoved");
      if (result.kind !== "clientMoved") return;
      expect(result.event.targetChannelID).toBe(42n);
      expect(clients.get(7)?.channelID).toBe(42n);
    });
  });

  describe("notifyclientupdated", () => {
    it("updates mute state without discarding fields not included in the notification", () => {
      const clients = new Map<number, DirectoryClientInfo>([
        [
          7,
          {
            id: 7,
            nickname: "Alice",
            uid: "uid123",
            channelID: 42n,
            type: 0,
            serverGroups: ["6"],
            inputMuted: false,
            outputMuted: false,
          },
        ],
      ]);

      const result = handleNotification(
        {
          name: "notifyclientupdated",
          params: { clid: "7", client_input_muted: "1" },
        },
        1,
        clients,
        "Bot",
      );

      expect(result.kind).toBe("clientUpdated");
      if (result.kind !== "clientUpdated") return;
      expect(result.event.info.inputMuted).toBe(true);
      expect(result.event.info.outputMuted).toBe(false);
      expect(result.event.info.channelID).toBe(42n);
      expect(clients.get(7)?.inputMuted).toBe(true);
    });
  });

  describe("notifyclientpoke", () => {
    it("parses poke with message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "5",
          invokername: "Alice",
          invokeruid: "uid123",
          msg: "hello",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(5);
      expect(result.event.invokerName).toBe("Alice");
      expect(result.event.invokerUID).toBe("uid123");
      expect(result.event.message).toBe("hello");
    });

    it("parses poke with empty message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "3",
          invokername: "Bob",
          invokeruid: "uid456",
          msg: "",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.message).toBe("");
      expect(result.event.invokerName).toBe("Bob");
    });

    it("handles missing fields gracefully", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {},
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(0);
      expect(result.event.invokerName).toBe("");
      expect(result.event.invokerUID).toBe("");
      expect(result.event.message).toBe("");
    });
  });

  it("preserves unrecognized notifications for protocol extensions", () => {
    const cmd = {
      name: "notifystreamstarted",
      params: { id: "stream-1", clid: "7", audio: "1" },
    };
    const result = handleNotification(cmd, 1, makeClients(), "Bot");
    expect(result.kind).toBe("rawNotification");
    if (result.kind !== "rawNotification") return;
    expect(result.notification).toEqual({
      name: "notifystreamstarted",
      params: { id: "stream-1", clid: "7", audio: "1" },
    });
  });
});
