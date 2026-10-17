import type { Command } from "./command/command.js";
import { unescape } from "./command/command.js";
import type {
  ClientInfo,
  ClientLeftViewEvent,
  ClientMovedEvent,
  TextMessage,
  PokeEvent,
  FileUploadInfo,
  FileDownloadInfo,
  FileTransferStatusInfo,
  RawNotification,
  DirectoryClientInfo,
} from "./types.js";
import { parseUint64, parseUint16, parseInt10 } from "./helpers.js";

export type NotificationResult =
  | { kind: "clientEnter"; info: ClientInfo }
  | { kind: "clientLeave"; event: ClientLeftViewEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent }
  | { kind: "clientUpdated"; event: { info: DirectoryClientInfo } }
  | { kind: "textMessage"; message: TextMessage }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "startUpload"; info: FileUploadInfo }
  | { kind: "startDownload"; info: FileDownloadInfo }
  | { kind: "fileTransferStatus"; info: FileTransferStatusInfo }
  | { kind: "rawNotification"; notification: RawNotification };

export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, DirectoryClientInfo>,
  nickname: string,
): NotificationResult {
  switch (cmd.name) {
    case "notifycliententerview":
      return handleClientEnterView(cmd, clients, nickname);
    case "notifyclientleftview":
      return handleClientLeftView(cmd, selfCLID, clients);
    case "notifyclientmoved":
      return handleClientMoved(cmd, clients);
    case "notifyclientupdated":
      return handleClientUpdated(cmd, clients);
    case "notifytextmessage":
      return handleTextMessage(cmd, clients);
    case "notifyclientpoke":
      return handleClientPoked(cmd);
    case "notifystartupload":
      return { kind: "startUpload", info: handleStartUpload(cmd) };
    case "notifystartdownload":
      return { kind: "startDownload", info: handleStartDownload(cmd) };
    case "notifystatusfiletransfer":
      return { kind: "fileTransferStatus", info: handleFileTransferStatus(cmd) };
    default:
      return {
        kind: "rawNotification",
        notification: { name: cmd.name, params: { ...cmd.params } },
      };
  }
}

function handleClientEnterView(
  cmd: Command,
  clients: Map<number, DirectoryClientInfo>,
  _nickname: string,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const ctid = parseUint64(cmd.params["ctid"] ?? cmd.params["cid"] ?? "");
  const clientType = parseInt10(cmd.params["client_type"] ?? "");
  const groupsStr = cmd.params["client_servergroups"] ?? "";

  const previous = clients.get(clid);
  const info: DirectoryClientInfo = {
    ...previous,
    id: clid,
    nickname: cmd.params["client_nickname"] ?? "",
    uid: cmd.params["client_unique_identifier"] ?? "",
    channelID: ctid !== 0n ? ctid : (previous?.channelID ?? 0n),
    type: clientType,
    serverGroups: groupsStr ? groupsStr.split(",") : [],
  };

  if (clid !== 0) {
    clients.set(clid, info);
  }

  return { kind: "clientEnter", info };
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, DirectoryClientInfo>,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const reasonID = parseInt10(cmd.params["reasonid"] ?? "");
  const targetChannelID = parseUint64(cmd.params["ctid"] ?? "");

  if (targetChannelID !== 0n) {
    if (clid !== 0) {
      const existing = clients.get(clid);
      if (existing) clients.set(clid, { ...existing, channelID: targetChannelID });
    }
    return {
      kind: "clientMoved",
      event: {
        id: clid,
        targetChannelID,
        reasonID,
        invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
        invokerName: cmd.params["invokername"] ?? "",
        invokerUID: cmd.params["invokeruid"] ?? "",
      },
    };
  }

  const isSelf = clid === selfCLID;
  if (clid !== 0) clients.delete(clid);

  return {
    kind: "clientLeave",
    event: {
      id: clid,
      reasonID,
      reasonMsg: cmd.params["reasonmsg"] ?? "",
      targetID: parseUint16(cmd.params["targetid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(cmd: Command, clients: Map<number, DirectoryClientInfo>): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const ctid = parseUint64(cmd.params["ctid"] ?? cmd.params["cid"] ?? "");

  if (clid !== 0) {
    const existing = clients.get(clid);
    if (existing) clients.set(clid, { ...existing, channelID: ctid });
  }

  return {
    kind: "clientMoved",
    event: {
      id: clid,
      targetChannelID: ctid,
      reasonID: parseInt10(cmd.params["reasonid"] ?? ""),
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: cmd.params["invokeruid"] ?? "",
    },
  };
}

function handleClientUpdated(
  cmd: Command,
  clients: Map<number, DirectoryClientInfo>,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const current = clients.get(clid);
  const ctid = parseUint64(cmd.params["ctid"] ?? cmd.params["cid"] ?? "");
  const groups = cmd.params["client_servergroups"];
  const info: DirectoryClientInfo = {
    ...current,
    id: clid,
    nickname: cmd.params["client_nickname"] ?? current?.nickname ?? "",
    uid: cmd.params["client_unique_identifier"] ?? current?.uid ?? "",
    channelID: ctid !== 0n ? ctid : (current?.channelID ?? 0n),
    type: cmd.params["client_type"] !== undefined
      ? parseInt10(cmd.params["client_type"])
      : (current?.type ?? 0),
    serverGroups: groups !== undefined
      ? (groups ? groups.split(",") : [])
      : (current?.serverGroups ?? []),
  };

  if (cmd.params["client_away"] !== undefined) info.away = cmd.params["client_away"] === "1";
  if (cmd.params["client_away_message"] !== undefined) info.awayMessage = cmd.params["client_away_message"];
  if (cmd.params["client_input_muted"] !== undefined) info.inputMuted = cmd.params["client_input_muted"] === "1";
  if (cmd.params["client_output_muted"] !== undefined) info.outputMuted = cmd.params["client_output_muted"] === "1";
  if (cmd.params["client_is_channel_commander"] !== undefined) info.channelCommander = cmd.params["client_is_channel_commander"] === "1";

  if (clid !== 0) clients.set(clid, info);
  return { kind: "clientUpdated", event: { info } };
}

function handleTextMessage(cmd: Command, clients: Map<number, DirectoryClientInfo>): NotificationResult {
  const invokerID = parseUint16(cmd.params["invokerid"] ?? "");
  const invokerInfo = clients.get(invokerID);

  const message: TextMessage = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? ""),
    targetID: parseUint64(cmd.params["target"] ?? ""),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: cmd.params["invokeruid"] ?? invokerInfo?.uid ?? "",
    message: unescape(cmd.params["msg"] ?? ""),
    invokerGroups: invokerInfo?.serverGroups ?? [],
  };

  return { kind: "textMessage", message };
}

function handleStartUpload(cmd: Command): FileUploadInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    serverFileTransferID: parseUint16(cmd.params["serverftfid"] ?? ""),
    fileTransferKey: cmd.params["ftkey"] ?? "",
    port: parseUint16(cmd.params["port"] ?? ""),
    seekPosition: parseUint64(cmd.params["seekpos"] ?? ""),
  };
}

function handleStartDownload(cmd: Command): FileDownloadInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    serverFileTransferID: parseUint16(cmd.params["serverftfid"] ?? ""),
    fileTransferKey: cmd.params["ftkey"] ?? "",
    port: parseUint16(cmd.params["port"] ?? ""),
    size: parseUint64(cmd.params["size"] ?? ""),
  };
}

function handleFileTransferStatus(cmd: Command): FileTransferStatusInfo {
  return {
    clientFileTransferID: parseUint16(cmd.params["clientftfid"] ?? ""),
    status: parseInt10(cmd.params["status"] ?? ""),
    message: cmd.params["msg"] ?? "",
  };
}

function handleClientPoked(cmd: Command): NotificationResult {
  return {
    kind: "poked",
    event: {
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: unescape(cmd.params["invokername"] ?? ""),
      invokerUID: cmd.params["invokeruid"] ?? "",
      message: unescape(cmd.params["msg"] ?? ""),
    },
  };
}
